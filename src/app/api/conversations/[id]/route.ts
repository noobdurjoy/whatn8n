import { staffRoute, json, HttpError, uuid } from '@/lib/http';
import { canSeeConversation, conversationDetail } from '@/lib/queries';
import { getPool } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = staffRoute<{ id: string }>({ cap: 'view' }, async ({ staff, params }) => {
  if (!uuid.safeParse(params.id).success || !(await canSeeConversation(staff, params.id))) throw new HttpError(404, 'Not found');
  const d = await conversationDetail(params.id);
  if (!d) throw new HttpError(404, 'Not found');
  // Opening a conversation marks it read for the inbox counter.
  await getPool().query(`UPDATE app.conversations SET unread_count = 0 WHERE id = $1`, [params.id]);
  return json(d);
});
