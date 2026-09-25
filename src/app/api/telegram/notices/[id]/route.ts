import { z } from 'zod';
import { getPool } from '@/lib/db';
import { json, staffRoute } from '@/lib/http';

export const runtime = 'nodejs';

// cancel: end the notice (every active version) now.
// restore: make this older version the active one again (a new version).
const Body = z.object({ action: z.enum(['cancel', 'restore']) });

export const POST = staffRoute<{ id: string }, typeof Body>({ cap: 'knowledge_review', body: Body },
  async ({ staff, params, body }) => {
    const pool = getPool();
    if (body.action === 'restore') {
      const r = (await pool.query(`SELECT app.restore_notice_version($1, $2) AS r`, [staff.id, params.id])).rows[0].r;
      return json(r, r.ok ? 200 : 400);
    }
    const key = (await pool.query(`SELECT notice_key FROM app.temporary_notices WHERE id = $1`, [params.id])).rows[0]?.notice_key;
    if (!key) return json({ error: 'Notice not found' }, 404);
    const r = (await pool.query(`SELECT app.staff_cancel_notice($1, $2) AS r`, [staff.id, key])).rows[0].r;
    return json(r);
  });
