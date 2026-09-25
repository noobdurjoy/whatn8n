import { z } from 'zod';
import { getPool, withTx } from '@/lib/db';
import { HttpError, json, staffRoute } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Everyone can read published knowledge; editing needs 'knowledge_review'.
export const GET = staffRoute({ cap: 'view' }, async ({ staff }) => {
  const pool = getPool();
  const docs = (await pool.query(
    `SELECT d.id, d.slug, d.category, d.language, d.status, d.published_version_id,
            coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'version_no', v.version_no, 'title', v.title, 'body', v.body,
              'status', v.status, 'source', v.source, 'approved_at', v.approved_at, 'created_at', v.created_at) ORDER BY v.version_no DESC)
              FILTER (WHERE v.id IS NOT NULL), '[]') AS versions
       FROM app.knowledge_documents d LEFT JOIN app.knowledge_versions v ON v.document_id = d.id
      GROUP BY d.id ORDER BY d.category, d.slug`)).rows;
  const reviewer = ['owner', 'admin'].includes(staff.role);
  const proposals = reviewer ? (await pool.query(
    `SELECT p.*, d.slug AS document_slug FROM app.knowledge_proposals p LEFT JOIN app.knowledge_documents d ON d.id = p.document_id
      WHERE p.status = 'pending' ORDER BY p.created_at DESC LIMIT 100`)).rows : [];
  return json({ documents: docs, proposals, can_review: reviewer });
});

// Owner/admin-authored entry: approved and published immediately (the author
// is the reviewer). Editing an existing document creates a new version.
export const POST = staffRoute({ cap: 'knowledge_review', body: z.object({
  document_id: z.string().uuid().optional(),
  slug: z.string().regex(/^[a-z0-9-]{3,60}$/).optional(),
  category: z.enum(['faq', 'product', 'procedure', 'policy']),
  language: z.enum(['en', 'bn', 'banglish']).optional(),
  title: z.string().min(3).max(200),
  body: z.string().min(10).max(8000),
}) }, async ({ staff, body }) => {
  const r = await withTx(async (c) => {
    let docId = body.document_id;
    if (!docId) {
      if (!body.slug) throw new HttpError(400, 'slug required for a new entry');
      docId = (await c.query(
        `INSERT INTO app.knowledge_documents (shop_id, slug, category, language) SELECT id, $1, $2, $3 FROM app.shops LIMIT 1 RETURNING id`,
        [body.slug, body.category, body.language ?? 'en'])).rows[0].id;
    }
    const v = (await c.query(
      `INSERT INTO app.knowledge_versions (document_id, version_no, title, body, status, source, created_by, approved_by, approved_at)
       SELECT $1, coalesce(max(version_no), 0) + 1, $2, $3, 'approved', 'owner', $4, $4, now() FROM app.knowledge_versions WHERE document_id = $1
       RETURNING id`, [docId, body.title, body.body, staff.id])).rows[0];
    await c.query(`SELECT app.publish_knowledge_version($1, $2)`, [v.id, staff.id]);
    return { document_id: docId, version_id: v.id };
  });
  return json(r);
});
