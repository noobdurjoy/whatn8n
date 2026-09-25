import { after, type NextRequest } from 'next/server';
import { persistWebhookEvent, processWebhookEvent } from '@/lib/ingest';
import { n8n } from '@/lib/n8n';
import { getPool } from '@/lib/db';
import { sanitizeHeaders, verifyZernioSignature } from '@/lib/zernio/signature';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY = 1024 * 1024; // webhook JSON only; media is fetched separately

// Zernio requires a 2xx within 5 seconds and retries up to 7 times, so this
// handler only verifies, persists and acknowledges. Processing and n8n
// routing run after the response is sent (Next.js `after`), and the
// maintenance workflow re-drives anything that did not finish.
export async function POST(req: NextRequest) {
  const raw = Buffer.from(await req.arrayBuffer());
  if (raw.length > MAX_BODY) return new Response('payload too large', { status: 413 });

  const secret = process.env.ZERNIO_WEBHOOK_SECRET || '';
  const sig = req.headers.get('x-zernio-signature') ?? req.headers.get('x-late-signature');
  // Verify against the exact bytes received, before parsing.
  if (!verifyZernioSignature(raw, sig, secret)) {
    return new Response('invalid signature', { status: 401 });
  }

  let payload: any;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    return new Response('invalid json', { status: 400 });
  }
  const eventType = req.headers.get('x-zernio-event') ?? req.headers.get('x-late-event') ?? payload?.event;
  const eventId = req.headers.get('x-zernio-event-id') ?? req.headers.get('x-late-event-id') ?? payload?.id;
  if (typeof eventType !== 'string' || typeof eventId !== 'string' || !eventId) {
    return new Response('missing event metadata', { status: 400 });
  }

  let stored: { id: string; duplicate: boolean };
  try {
    stored = await persistWebhookEvent({
      source: 'zernio', providerEventId: eventId, eventType, signatureValid: true,
      headers: sanitizeHeaders(req.headers), payload,
    });
  } catch (err) {
    // Not persisted → do not acknowledge; Zernio will retry.
    console.error('[webhook] persist failed', (err as Error)?.message);
    return new Response('storage unavailable', { status: 503 });
  }

  if (!stored.duplicate) {
    after(async () => {
      try {
        const res = await processWebhookEvent(stored.id);
        if (res.status === 'processed' && res.route && res.route.action !== 'none') {
          const ok = await n8n.route(stored.id, res.route);
          await getPool().query(
            `UPDATE app.webhook_events SET routed_at = CASE WHEN $2 THEN now() ELSE routed_at END, route_attempts = route_attempts + 1 WHERE id = $1`,
            [stored.id, ok]);
        }
      } catch (err) {
        // Stays 'received'/'failed'; the maintenance workflow retries it.
        console.error('[webhook] processing failed', stored.id, (err as Error)?.message);
        await getPool().query(
          `UPDATE app.webhook_events SET processing_status = 'failed', last_error = $2, next_attempt_at = now() + interval '1 minute' WHERE id = $1`,
          [stored.id, String((err as Error)?.message).slice(0, 500)]).catch(() => {});
      }
    });
  }
  return new Response(JSON.stringify({ ok: true, duplicate: stored.duplicate }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}
