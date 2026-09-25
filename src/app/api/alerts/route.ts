import { getPool } from '@/lib/db';
import { json, staffRoute } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = staffRoute({ cap: 'view' }, async () => {
  const r = await getPool().query(
    `SELECT id, kind, severity, message, details, created_at FROM app.alerts WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT 100`);
  return json({ alerts: r.rows });
});
