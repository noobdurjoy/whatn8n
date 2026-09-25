import { after, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getPool } from '@/lib/db';
import { HttpError, json, staffRoute, uuid } from '@/lib/http';
import { n8n } from '@/lib/n8n';
import { canSeeConversation } from '@/lib/queries';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type P = { id: string; action: string };

async function draftConversation(id: string) {
  if (!uuid.safeParse(id).success) throw new HttpError(404, 'Not found');
  const r = await getPool().query(`SELECT conversation_id FROM app.ai_drafts WHERE id = $1`, [id]);
  if (!r.rows[0]) throw new HttpError(404, 'Not found');
  return r.rows[0].conversation_id as string;
}

const approve = staffRoute<P, any>({
  cap: 'approve_draft',
  body: z.object({ final_text: z.string().max(4096).optional(), force_stale: z.boolean().optional() }),
}, async ({ staff, params, body }) => {
  const convId = await draftConversation(params.id);
  if (!(await canSeeConversation(staff, convId))) throw new HttpError(404, 'Not found');
  const r = (await getPool().query(`SELECT app.approve_draft($1, $2, $3, $4) AS r`,
    [params.id, staff.id, body.final_text ?? null, Boolean(body.force_stale)])).rows[0].r;
  if (r.ok) after(() => n8n.dispatch(r.outbound_id));
  return json(r, r.ok ? 200 : 409);
});

const reject = staffRoute<P, any>({ cap: 'approve_draft', body: z.object({ note: z.string().max(1000).optional() }) },
  async ({ staff, params, body }) => {
    const convId = await draftConversation(params.id);
    if (!(await canSeeConversation(staff, convId))) throw new HttpError(404, 'Not found');
    const r = (await getPool().query(`SELECT app.reject_draft($1, $2, $3) AS r`, [params.id, staff.id, body.note ?? null])).rows[0].r;
    return json(r);
  });

export async function POST(req: NextRequest, ctx: { params: Promise<P> }) {
  const { action } = await ctx.params;
  if (action === 'approve') return approve(req, ctx);
  if (action === 'reject') return reject(req, ctx);
  return json({ error: 'Not found' }, 404);
}
