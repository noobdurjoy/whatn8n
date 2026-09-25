import { getPool } from '@/lib/db';
import { internalRoute, json } from '@/lib/http';
import { processWebhookEvent } from '@/lib/ingest';
import { n8n } from '@/lib/n8n';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Called every minute by n8n workflow I (Maintenance). Re-processes events
// that were persisted but not finished (crash, deploy, DB blip, deferred
// echoes) and re-delivers routing notifications n8n did not accept.
// Everything here is idempotent.
export const POST = internalRoute(async () => {
  const pool = getPool();
  const pending = (await pool.query(
    `SELECT id FROM app.webhook_events
      WHERE source = 'zernio' AND signature_valid AND attempts < 10
        AND ((processing_status = 'received' AND received_at < now() - interval '30 seconds')
          OR (processing_status IN ('deferred', 'failed') AND coalesce(next_attempt_at, now()) <= now()))
      ORDER BY received_at LIMIT 100`)).rows;
  let processed = 0;
  let failed = 0;
  for (const e of pending) {
    try {
      const r = await processWebhookEvent(e.id);
      if (r.status === 'processed') processed++;
    } catch (err) {
      failed++;
      await pool.query(
        `UPDATE app.webhook_events SET processing_status = 'failed', attempts = attempts + 1, last_error = $2,
                next_attempt_at = now() + make_interval(mins => least(60, power(2, attempts)::int)) WHERE id = $1`,
        [e.id, String((err as Error)?.message).slice(0, 500)]);
    }
  }
  // Give up after 10 attempts: dead-letter for staff review.
  const dead = await pool.query(
    `UPDATE app.webhook_events SET processing_status = 'dead' WHERE processing_status IN ('failed', 'deferred') AND attempts >= 10 RETURNING id`);
  for (const d of dead.rows) {
    await pool.query(`SELECT app.raise_alert('event_dead', 'warning', 'A webhook event could not be processed and needs review.', $1, $2)`,
      [{ event_id: d.id }, `event_dead:${d.id}`]);
  }

  const unrouted = (await pool.query(
    `SELECT id, route, source FROM app.webhook_events
      WHERE processing_status = 'processed' AND routed_at IS NULL AND route_attempts < 20
        AND processed_at < now() - interval '20 seconds' ORDER BY processed_at LIMIT 100`)).rows;
  let routed = 0;
  for (const e of unrouted) {
    const ok = e.source === 'woocommerce' ? await n8n.wooEvent(e.id) : await n8n.route(e.id, e.route);
    await pool.query(`UPDATE app.webhook_events SET routed_at = CASE WHEN $2 THEN now() END, route_attempts = route_attempts + 1 WHERE id = $1`,
      [e.id, ok]);
    if (ok) routed++;
  }
  return json({ processed, failed, dead: dead.rowCount, routed, pending: pending.length });
});
