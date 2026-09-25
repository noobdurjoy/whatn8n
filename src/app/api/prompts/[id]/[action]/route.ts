import type { NextRequest } from 'next/server';
import { getPool, withTx } from '@/lib/db';
import { HttpError, json, staffRoute, uuid } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type P = { id: string; action: string };

// Publish a version (or roll back by publishing an older one). A version must
// have a successful sandbox test recorded after it was created.
const publish = staffRoute<P>({ cap: 'prompts' }, async ({ staff, params }) => {
  if (!uuid.safeParse(params.id).success) throw new HttpError(404, 'Not found');
  const r = await withTx(async (c) => {
    const v = (await c.query(`SELECT * FROM app.prompt_versions WHERE id = $1 FOR UPDATE`, [params.id])).rows[0];
    if (!v) throw new HttpError(404, 'Not found');
    if (v.status === 'published') return { ok: true, already: true };
    if (!v.tested_at || v.tested_at < v.created_at) throw new HttpError(409, 'Run this version in the test area before publishing it.');
    await c.query(`UPDATE app.prompt_versions SET status = 'archived' WHERE name = $1 AND status = 'published'`, [v.name]);
    await c.query(`UPDATE app.prompt_versions SET status = 'published', published_by = $2, published_at = now() WHERE id = $1`, [v.id, staff.id]);
    await c.query(`SELECT app.audit('staff', $1, 'prompt.published', 'prompt_version', $2, $3)`,
      [staff.id, v.id, { name: v.name, version_no: v.version_no }]);
    return { ok: true };
  });
  return json(r);
});

export async function POST(req: NextRequest, ctx: { params: Promise<P> }) {
  const { action } = await ctx.params;
  if (action === 'publish') return publish(req, ctx);
  return json({ error: 'Not found' }, 404);
}
