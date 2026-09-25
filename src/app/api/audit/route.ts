import { getPool } from '@/lib/db';
import { json, staffRoute } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = staffRoute({ cap: 'view_audit' }, async ({ req }) => {
  const entity = req.nextUrl.searchParams.get('entity_id');
  const r = await getPool().query(
    `SELECT a.id, a.at, a.actor_type, su.display_name AS actor_name, a.action, a.entity_type, a.entity_id, a.details
       FROM app.audit_log a LEFT JOIN app.staff_users su ON su.id = a.actor_id
      WHERE ($1::text IS NULL OR a.entity_id = $1) ORDER BY a.at DESC LIMIT 200`, [entity]);
  return json({ entries: r.rows });
});
