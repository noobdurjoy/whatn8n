import { after, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getPool } from '@/lib/db';
import { HttpError, json, staffRoute, uuid } from '@/lib/http';
import { n8n } from '@/lib/n8n';
import { can } from '@/lib/permissions';
import { canSeeConversation } from '@/lib/queries';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type P = { id: string; action: string };

async function guard(staffId: Parameters<typeof canSeeConversation>[0], id: string) {
  if (!uuid.safeParse(id).success || !(await canSeeConversation(staffId, id))) throw new HttpError(404, 'Not found');
}

const handlers: Record<string, (req: NextRequest, ctx: { params: Promise<P> }) => Promise<Response>> = {
  // Change mode. AUTO needs 'resume_ai'; HUMAN is a takeover. The database
  // function applies the same rules again.
  mode: staffRoute<P, any>({ cap: 'view', body: z.object({ mode: z.enum(['AUTO', 'COPILOT', 'HUMAN']), reason: z.string().max(200).optional() }) },
    async ({ staff, params, body }) => {
      await guard(staff, params.id);
      const cap = body.mode === 'AUTO' ? 'resume_ai' : body.mode === 'COPILOT' ? 'set_copilot' : 'takeover';
      const agentsCanResumeAi = (await getPool().query(`SELECT app.setting_bool('agents_can_resume_ai', false) AS v`)).rows[0].v;
      if (!can(staff.role, cap, { agentsCanResumeAi })) throw new HttpError(403, 'Not allowed');
      const r = await getPool().query(`SELECT app.set_mode($1, $2, $3, $4) AS r`, [params.id, body.mode, staff.id, body.reason ?? null]);
      return json(r.rows[0].r);
    }),

  // "Take Over": commits HUMAN mode in the database before anything else.
  takeover: staffRoute<P>({ cap: 'takeover' }, async ({ staff, params }) => {
    await guard(staff, params.id);
    const r = await getPool().query(`SELECT app.take_over($1, 'staff', $2, 'staff_take_over', '{}', false) AS r`, [params.id, staff.id]);
    return json(r.rows[0].r);
  }),

  reply: staffRoute<P, any>({
    cap: 'reply',
    body: z.object({
      text: z.string().max(4096).optional(),
      client_request_id: z.string().min(8).max(80),
      upload_id: z.string().uuid().optional(),
      template: z.object({
        name: z.string().regex(/^[a-z0-9_]{1,512}$/),
        language: z.string().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/),
        components: z.array(z.record(z.string(), z.unknown())).max(10).optional(),
      }).optional(),
    }).refine((b) => (b.text && b.text.trim()) || b.upload_id || b.template, { message: 'Message is empty' }),
  }, async ({ staff, params, body }) => {
    await guard(staff, params.id);
    const payload: Record<string, unknown> = {};
    if (body.template) payload.template = body.template;
    if (body.upload_id) {
      const up = (await getPool().query(
        `SELECT id, mime_type, file_name FROM app.staff_uploads WHERE id = $1 AND conversation_id = $2 AND staff_id = $3`,
        [body.upload_id, params.id, staff.id])).rows[0];
      if (!up) throw new HttpError(400, 'Attachment not found');
      payload.attachment = {
        upload_id: up.id, filename: up.file_name,
        type: up.mime_type.startsWith('image/') ? 'image' : up.mime_type.startsWith('video/') ? 'video' : up.mime_type.startsWith('audio/') ? 'audio' : 'file',
      };
    }
    const r = (await getPool().query(`SELECT app.enqueue_staff_reply($1, $2, $3, $4, $5) AS r`,
      [params.id, staff.id, body.text?.trim() || null, payload, body.client_request_id])).rows[0].r;
    after(() => n8n.dispatch(r.outbound_id));
    return json(r);
  }),

  notes: staffRoute<P, any>({ cap: 'note', body: z.object({ body: z.string().min(1).max(4000) }) }, async ({ staff, params, body }) => {
    await guard(staff, params.id);
    const r = await getPool().query(
      `INSERT INTO app.internal_notes (conversation_id, staff_id, body) VALUES ($1, $2, $3) RETURNING id, created_at`,
      [params.id, staff.id, body.body]);
    await getPool().query(`SELECT app.notify('note', $1, '{}')`, [params.id]);
    return json(r.rows[0]);
  }),

  assign: staffRoute<P, any>({ cap: 'assign_self', body: z.object({ staff_id: z.string().uuid().nullable() }) },
    async ({ staff, params, body }) => {
      await guard(staff, params.id);
      if (body.staff_id !== staff.id && !can(staff.role, 'assign_any')) throw new HttpError(403, 'Not allowed');
      if (body.staff_id) {
        const ok = (await getPool().query(`SELECT 1 FROM app.staff_users WHERE id = $1 AND active`, [body.staff_id])).rowCount;
        if (!ok) throw new HttpError(400, 'Unknown staff member');
      }
      await getPool().query(
        `UPDATE app.conversations SET assigned_to = $2,
                queue_state = CASE WHEN $2::uuid IS NULL THEN (CASE WHEN mode = 'HUMAN' THEN 'waiting_staff' ELSE 'none' END) ELSE 'assigned' END,
                updated_at = now() WHERE id = $1`, [params.id, body.staff_id]);
      await getPool().query(`SELECT app.audit('staff', $1, 'conversation.assign', 'conversation', $2, $3)`,
        [staff.id, params.id, { assigned_to: body.staff_id }]);
      await getPool().query(`SELECT app.notify('conversation', $1, '{}')`, [params.id]);
      return json({ ok: true });
    }),

  tags: staffRoute<P, any>({ cap: 'tag', body: z.object({ tags: z.array(z.string().regex(/^[\p{L}\p{M}\p{N} _-]{1,30}$/u)).max(15),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).optional() }) },
    async ({ staff, params, body }) => {
      await guard(staff, params.id);
      await getPool().query(`UPDATE app.conversations SET tags = $2, priority = coalesce($3, priority), updated_at = now() WHERE id = $1`,
        [params.id, body.tags, body.priority ?? null]);
      await getPool().query(`SELECT app.notify('conversation', $1, '{}')`, [params.id]);
      return json({ ok: true });
    }),

  status: staffRoute<P, any>({ cap: 'tickets', body: z.object({ status: z.enum(['open', 'pending', 'resolved', 'closed']) }) },
    async ({ staff, params, body }) => {
      await guard(staff, params.id);
      await getPool().query(
        `UPDATE app.conversations SET status = $2, queue_state = CASE WHEN $2 IN ('resolved', 'closed') THEN 'none' ELSE queue_state END,
                first_response_due_at = CASE WHEN $2 IN ('resolved', 'closed') THEN NULL ELSE first_response_due_at END, updated_at = now()
          WHERE id = $1`, [params.id, body.status]);
      await getPool().query(`SELECT app.audit('staff', $1, 'conversation.status', 'conversation', $2, $3)`, [staff.id, params.id, { status: body.status }]);
      await getPool().query(`SELECT app.notify('conversation', $1, '{}')`, [params.id]);
      return json({ ok: true });
    }),

  // Staff asks the AI for a suggestion (works in HUMAN mode too). The result
  // is always a draft for staff review, never sent automatically.
  assist: staffRoute<P, any>({ cap: 'request_ai_assist', body: z.object({ include_images: z.boolean().optional() }) },
    async ({ staff, params, body }) => {
      await guard(staff, params.id);
      const r = (await getPool().query(`SELECT app.start_ai_job($1, 'staff_assist', NULL, NULL, $2) AS r`, [params.id, staff.id])).rows[0].r;
      if (!r.started) throw new HttpError(409, r.reason);
      const ok = await n8n.aiJob(r.job_id, { staff_requested: true, include_images: Boolean(body.include_images) });
      if (!ok) {
        await getPool().query(`SELECT app.fail_ai_job($1, 'n8n unreachable')`, [r.job_id]);
        throw new HttpError(503, 'The AI workflow is not reachable right now.');
      }
      return json({ job_id: r.job_id });
    }),

  'clear-hold': staffRoute<P, any>({ cap: 'clear_hold', body: z.object({ note: z.string().max(500).optional() }) },
    async ({ staff, params, body }) => {
      await guard(staff, params.id);
      await getPool().query(`SELECT app.clear_automation_hold($1, $2, $3)`, [params.id, staff.id, body.note ?? null]);
      return json({ ok: true });
    }),

  feedback: staffRoute<P, any>({ cap: 'reply', body: z.object({ message_id: z.string().uuid(), label: z.enum(['ai_good', 'ai_wrong']), comment: z.string().max(1000).optional() }) },
    async ({ staff, params, body }) => {
      await guard(staff, params.id);
      await getPool().query(
        `INSERT INTO app.feedback (conversation_id, message_id, source, label, comment, staff_id, rating)
         SELECT $1, m.id, 'staff', $3, $4, $5, CASE WHEN $3 = 'ai_good' THEN 5 ELSE 1 END
           FROM app.messages m WHERE m.id = $2 AND m.conversation_id = $1`,
        [params.id, body.message_id, body.label, body.comment ?? null, staff.id]);
      return json({ ok: true });
    }),
};

export async function POST(req: NextRequest, ctx: { params: Promise<P> }) {
  const { action } = await ctx.params;
  const h = handlers[action];
  if (!h) return json({ error: 'Not found' }, 404);
  return h(req, ctx);
}
