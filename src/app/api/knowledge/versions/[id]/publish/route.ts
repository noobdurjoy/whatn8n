import { getPool } from '@/lib/db';
import { json, staffRoute } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Roll back (or forward) by publishing a specific stored version.
export const POST = staffRoute<{ id: string }>({ cap: 'knowledge_review' }, async ({ staff, params }) => {
  await getPool().query(`SELECT app.publish_knowledge_version($1, $2)`, [params.id, staff.id]);
  return json({ ok: true });
});
