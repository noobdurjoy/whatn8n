import { z } from 'zod';
import { getPool } from '@/lib/db';
import { json, staffRoute } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Approve / Edit-and-approve / Reject a daily-learning proposal. Only an
// approved proposal becomes a published knowledge version.
export const POST = staffRoute<{ id: string }, any>({ cap: 'knowledge_review', body: z.object({
  action: z.enum(['approve', 'edit_approve', 'reject']),
  title: z.string().min(3).max(200).optional(),
  body: z.string().min(10).max(8000).optional(),
  note: z.string().max(1000).optional(),
}) }, async ({ staff, params, body }) => {
  const r = await getPool().query(`SELECT app.review_knowledge_proposal($1, $2, $3, $4, $5, $6) AS r`,
    [params.id, staff.id, body.action, body.title ?? null, body.body ?? null, body.note ?? null]);
  return json(r.rows[0].r);
});
