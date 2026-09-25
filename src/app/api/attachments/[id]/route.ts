import { getPool } from '@/lib/db';
import { HttpError, staffRoute, uuid } from '@/lib/http';
import { canSeeConversation } from '@/lib/queries';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const INLINE = new Set(['image/jpeg', 'image/png', 'image/webp', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'video/mp4']);

// Customer media is served only to signed-in staff who can see the
// conversation. The provider URL (which needs the Zernio API key) is never
// exposed. Stored bytes were type-checked by magic bytes on download.
export const GET = staffRoute<{ id: string }>({ cap: 'view' }, async ({ staff, params }) => {
  if (!uuid.safeParse(params.id).success) throw new HttpError(404, 'Not found');
  const r = (await getPool().query(
    `SELECT a.mime_type, a.file_name, m.conversation_id, b.data FROM app.attachments a
       JOIN app.messages m ON m.id = a.message_id JOIN app.attachment_blobs b ON b.attachment_id = a.id
      WHERE a.id = $1 AND a.fetch_status = 'stored'`, [params.id])).rows[0];
  if (!r || !(await canSeeConversation(staff, r.conversation_id))) throw new HttpError(404, 'Not found');
  const inline = INLINE.has(r.mime_type);
  const name = (r.file_name || `attachment-${params.id.slice(0, 8)}`).replace(/[^\w.\- ]/g, '_');
  return new Response(r.data, {
    headers: {
      'content-type': inline ? r.mime_type : 'application/octet-stream',
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${name}"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; img-src 'self'; media-src 'self'; sandbox",
    },
  });
});
