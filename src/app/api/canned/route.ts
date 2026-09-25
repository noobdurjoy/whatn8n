import { z } from 'zod';
import { getPool } from '@/lib/db';
import { json, staffRoute } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = staffRoute({ cap: 'view' }, async () => {
  const r = await getPool().query(`SELECT id, title, body, language FROM app.canned_replies WHERE archived_at IS NULL ORDER BY title`);
  return json({ canned: r.rows });
});

export const POST = staffRoute({ cap: 'canned_manage', body: z.object({
  title: z.string().min(1).max(80), body: z.string().min(1).max(4096), language: z.enum(['en', 'bn', 'banglish']),
}) }, async ({ staff, body }) => {
  const r = await getPool().query(`INSERT INTO app.canned_replies (title, body, language, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
    [body.title, body.body, body.language, staff.id]);
  return json(r.rows[0]);
});
