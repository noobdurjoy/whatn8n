import { getPool } from '@/lib/db';
import { json, staffRoute } from '@/lib/http';

export const runtime = 'nodejs';

export const POST = staffRoute<{ id: string }>({ cap: 'reconcile_send' }, async ({ staff, params }) => {
  await getPool().query(`UPDATE app.alerts SET resolved_at = now(), resolved_by = $2 WHERE id = $1 AND resolved_at IS NULL`, [params.id, staff.id]);
  return json({ ok: true });
});
