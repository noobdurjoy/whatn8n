import { z } from 'zod';
import { getPool, withTx } from '@/lib/db';
import { HttpError, json, staffRoute } from '@/lib/http';
import { n8n } from '@/lib/n8n';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Test area: runs the real reply workflow against the sandbox conversation,
// optionally with a draft prompt version. The sandbox conversation can never
// send (claim_outbound refuses it); results come back as drafts.
export const POST = staffRoute({ cap: 'prompts', body: z.object({
  message: z.string().min(1).max(2000),
  prompt_version_id: z.string().uuid().optional(),
  reset: z.boolean().optional(),
}) }, async ({ staff, body }) => {
  const r = await withTx(async (c) => {
    const conv = (await c.query(`SELECT id FROM app.conversations WHERE is_sandbox LIMIT 1 FOR UPDATE`)).rows[0];
    if (!conv) throw new HttpError(500, 'Sandbox conversation missing; run the seed script.');
    if (body.reset) await c.query(`DELETE FROM app.messages WHERE conversation_id = $1`, [conv.id]);
    const m = (await c.query(
      `INSERT INTO app.messages (conversation_id, direction, author_type, kind, body, provider_message_id, sent_at, metadata)
       VALUES ($1, 'inbound', 'customer', 'text', $2, 'sandbox.' || gen_random_uuid(), now(), jsonb_build_object('sandbox_by', $3::text)) RETURNING id`,
      [conv.id, body.message, staff.id])).rows[0];
    await c.query(`UPDATE app.conversations SET revision = revision + 1, last_inbound_at = now(), last_message_at = now() WHERE id = $1`, [conv.id]);
    const j = (await c.query(`SELECT app.start_ai_job($1, 'sandbox', $2) AS r`, [conv.id, m.id])).rows[0].r;
    if (!j.started) throw new HttpError(409, j.reason);
    if (body.prompt_version_id) {
      const ok = (await c.query(`UPDATE app.ai_jobs SET prompt_version_id = $2 WHERE id = $1 AND EXISTS (
                   SELECT 1 FROM app.prompt_versions WHERE id = $2 AND name = 'customer_system')`, [j.job_id, body.prompt_version_id])).rowCount;
      if (!ok) throw new HttpError(400, 'Unknown customer prompt version');
    }
    return j;
  });
  const ok = await n8n.aiJob(r.job_id, { sandbox: true });
  if (!ok) {
    await getPool().query(`SELECT app.fail_ai_job($1, 'n8n unreachable')`, [r.job_id]);
    throw new HttpError(503, 'The AI workflow is not reachable right now.');
  }
  return json({ job_id: r.job_id });
});

export const GET = staffRoute({ cap: 'prompts' }, async ({ req }) => {
  const jobId = req.nextUrl.searchParams.get('job_id');
  if (!jobId || !z.string().uuid().safeParse(jobId).success) throw new HttpError(400, 'job_id required');
  const pool = getPool();
  const job = (await pool.query(
    `SELECT j.id, j.status, j.decision, j.result, j.discard_reason, j.prompt_version_id, j.started_at, j.finished_at
       FROM app.ai_jobs j JOIN app.conversations c ON c.id = j.conversation_id WHERE j.id = $1 AND c.is_sandbox`, [jobId])).rows[0];
  if (!job) throw new HttpError(404, 'Not found');
  const draft = (await pool.query(`SELECT body, decision, references_used FROM app.ai_drafts WHERE ai_job_id = $1`, [jobId])).rows[0] ?? null;
  const usage = (await pool.query(`SELECT purpose, model, provider, latency_ms, prompt_tokens, completion_tokens, reasoning_tokens, cost_usd, usage_available, outcome
                                     FROM app.ai_usage WHERE ai_job_id = $1 ORDER BY created_at`, [jobId])).rows;
  // A successful run marks the prompt version as tested (required to publish).
  if (['drafted', 'completed'].includes(job.status) && job.prompt_version_id) {
    await pool.query(`UPDATE app.prompt_versions SET tested_at = now() WHERE id = $1 AND (tested_at IS NULL OR tested_at < $2)`,
      [job.prompt_version_id, job.finished_at]);
  }
  return json({ job, draft, usage });
});
