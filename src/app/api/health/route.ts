import { getPool } from '@/lib/db';
import { json } from '@/lib/http';
import { currentStaff } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Unauthenticated callers (uptime monitors) only learn whether the app and
// database respond. Signed-in staff get component detail.
export async function GET() {
  let dbOk = false;
  try { await getPool().query('SELECT 1'); dbOk = true; } catch { dbOk = false; }
  const staff = dbOk ? await currentStaff().catch(() => null) : null;
  if (!staff) return json({ ok: dbOk }, dbOk ? 200 : 503);
  const pool = getPool();
  const [checks, backlog, accounts] = await Promise.all([
    pool.query(`SELECT component, status, detail, checked_at FROM app.health_checks ORDER BY component`),
    pool.query(`SELECT
        (SELECT count(*)::int FROM app.webhook_events WHERE processing_status IN ('received', 'deferred', 'failed')) AS events_pending,
        (SELECT count(*)::int FROM app.webhook_events WHERE processing_status = 'dead') AS events_dead,
        (SELECT count(*)::int FROM app.webhook_events WHERE processing_status = 'processed' AND routed_at IS NULL) AS events_unrouted,
        (SELECT max(received_at) FROM app.webhook_events WHERE source = 'zernio') AS last_zernio_event,
        (SELECT count(*)::int FROM app.outbound_messages WHERE status = 'queued' AND next_attempt_at < now() - interval '2 minutes') AS sends_stuck,
        (SELECT count(*)::int FROM app.outbound_messages WHERE status = 'unknown') AS sends_unknown,
        (SELECT count(*)::int FROM app.attachments WHERE fetch_status = 'pending' AND created_at < now() - interval '5 minutes') AS media_pending,
        app.ai_budget_status() AS ai_budget`),
    pool.query(`SELECT id, provider_account_id, display_name, username, status, enabled, last_event_at FROM app.channel_accounts ORDER BY created_at`),
  ]);
  return json({ ok: dbOk, checks: checks.rows, backlog: backlog.rows[0], accounts: accounts.rows });
}
