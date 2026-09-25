import { getPool } from '@/lib/db';
import { json, staffRoute } from '@/lib/http';

export const runtime = 'nodejs';

export const DELETE = staffRoute<{ id: string }>({ cap: 'manage_staff' }, async ({ staff, params }) => {
  await getPool().query(`SELECT app.revoke_telegram_admin($1, $2)`, [staff.id, params.id]);
  return json({ ok: true });
});
