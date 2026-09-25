import { z } from 'zod';
import { getPool } from '@/lib/db';
import { json, staffRoute } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = staffRoute({ cap: 'prompts' }, async () => {
  const r = await getPool().query(
    `SELECT p.id, p.name, p.version_no, p.body, p.model_config, p.status, p.note, p.created_at, p.published_at, p.tested_at,
            c.display_name AS created_by_name, pb.display_name AS published_by_name
       FROM app.prompt_versions p
       LEFT JOIN app.staff_users c ON c.id = p.created_by LEFT JOIN app.staff_users pb ON pb.id = p.published_by
      ORDER BY p.name, p.version_no DESC`);
  return json({ versions: r.rows });
});

// New versions start as drafts; they must pass a sandbox test before publishing.
export const POST = staffRoute({ cap: 'prompts', body: z.object({
  name: z.enum(['customer_system', 'vision_system', 'summary_system', 'learning_system']),
  body: z.string().min(50).max(20000),
  note: z.string().max(300).optional(),
}) }, async ({ staff, body }) => {
  const r = await getPool().query(
    `INSERT INTO app.prompt_versions (name, version_no, body, status, note, created_by)
     SELECT $1, coalesce(max(version_no), 0) + 1, $2, 'draft', $3, $4 FROM app.prompt_versions WHERE name = $1
     RETURNING id, version_no`, [body.name, body.body, body.note ?? null, staff.id]);
  await getPool().query(`SELECT app.audit('staff', $1, 'prompt.draft_created', 'prompt_version', $2, $3)`,
    [staff.id, r.rows[0].id, { name: body.name, version_no: r.rows[0].version_no }]);
  return json(r.rows[0]);
});
