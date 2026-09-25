import { getPool } from '@/lib/db';
import { json, staffRoute } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Temporary notices (all versions, newest first) and private staff notes.
export const GET = staffRoute({ cap: 'knowledge_review' }, async () => {
  const pool = getPool();
  const notices = (await pool.query(
    `SELECT n.id, n.notice_key, n.version, n.title, n.body, n.scope, n.starts_at, n.expires_at, n.status, n.created_via, n.created_at, n.canceled_at,
            s.display_name AS created_by, (n.status = 'active' AND now() >= n.starts_at AND now() < n.expires_at) AS live
       FROM app.temporary_notices n LEFT JOIN app.staff_users s ON s.id = n.created_by
      ORDER BY n.created_at DESC LIMIT 100`)).rows;
  const notes = (await pool.query(
    `SELECT n.id, n.body, n.created_via, n.created_at, s.display_name AS created_by
       FROM app.staff_notes n LEFT JOIN app.staff_users s ON s.id = n.created_by WHERE n.deleted_at IS NULL ORDER BY n.created_at DESC LIMIT 100`)).rows;
  return json({ notices, notes });
});
