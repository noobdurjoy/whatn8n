import { currentStaff } from '@/lib/auth';
import { getPool } from '@/lib/db';
import { ensureListener, subscribe } from '@/lib/realtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Authenticated Server-Sent Events. The session is checked when the stream
// opens and re-checked every 60 s (a revoked session closes the stream).
// Per-conversation events are filtered with the same visibility rule as the
// inbox, and payloads contain ids only.
export async function GET(req: Request) {
  const staff = await currentStaff();
  if (!staff) return new Response('Not signed in', { status: 401 });
  await ensureListener();
  const pool = getPool();
  const assignedOnly = staff.role === 'agent'
    && (await pool.query(`SELECT app.setting_bool('agents_see_assigned_only', false) AS v`)).rows[0].v;

  const enc = new TextEncoder();
  let unsub = () => {};
  let timer: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try { controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { /* closed */ }
      };
      send('ready', { at: new Date().toISOString() });
      unsub = subscribe(async (e) => {
        if (assignedOnly && e.conversation_id) {
          const r = await pool.query(`SELECT 1 FROM app.conversations WHERE id = $1 AND (assigned_to = $2 OR assigned_to IS NULL)`,
            [e.conversation_id, staff.id]).catch(() => ({ rowCount: 0 }));
          if (!r.rowCount) return;
        }
        const safe: Record<string, unknown> = { type: e.type };
        for (const k of ['conversation_id', 'message_id', 'outbound_id', 'draft_id', 'attachment_id', 'status', 'mode', 'mode_version', 'kind', 'job_id', 'operation_id']) {
          if (e[k] !== undefined) safe[k] = e[k];
        }
        send('app', safe);
      });
      timer = setInterval(async () => {
        const still = await pool.query(`SELECT 1 FROM app.staff_sessions WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()`,
          [staff.session_id]).catch(() => ({ rowCount: 0 }));
        if (!still.rowCount) { send('logout', {}); cleanup(); try { controller.close(); } catch { /* */ } return; }
        send('ping', { t: Date.now() });
      }, 60_000);
      const cleanup = () => { unsub(); if (timer) clearInterval(timer); };
      req.signal.addEventListener('abort', () => { cleanup(); try { controller.close(); } catch { /* */ } });
    },
    cancel() { unsub(); if (timer) clearInterval(timer); },
  });
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' },
  });
}
