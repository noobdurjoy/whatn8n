import { getPool } from '@/lib/db';
import { json, staffRoute } from '@/lib/http';

export const runtime = 'nodejs';

export const DELETE = staffRoute<{ id: string }>({ cap: 'canned_manage' }, async ({ params }) => {
  await getPool().query(`UPDATE app.canned_replies SET archived_at = now() WHERE id = $1`, [params.id]);
  return json({ ok: true });
});
