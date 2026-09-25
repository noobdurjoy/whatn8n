import { getPool } from '@/lib/db';
import { json } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// For an external uptime monitor: detects the failure the n8n workflow cannot
// report itself (n8n down, workflow unpublished or stuck). The workflow's
// maintenance branch writes the heartbeat every minute. 503 when it is older
// than 3 minutes. No details are returned.
export async function GET() {
  try {
    const r = (await getPool().query(
      `SELECT checked_at > now() - interval '3 minutes' AS ok FROM app.health_checks WHERE component = 'n8n_maintenance'`)).rows[0];
    const ok = Boolean(r?.ok);
    return json({ ok }, ok ? 200 : 503);
  } catch {
    return json({ ok: false }, 503);
  }
}
