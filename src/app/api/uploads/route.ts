import { createHash } from 'node:crypto';
import { getPool } from '@/lib/db';
import { HttpError, json, staffRoute } from '@/lib/http';
import { canSeeConversation } from '@/lib/queries';
import { sniffMime } from '@/lib/files';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX = 16 * 1024 * 1024;
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'video/mp4', 'audio/mpeg', 'audio/ogg']);

export const POST = staffRoute({ cap: 'reply' }, async ({ req, staff }) => {
  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  const conversationId = String(form?.get('conversation_id') || '');
  if (!(file instanceof File)) throw new HttpError(400, 'No file');
  if (!(await canSeeConversation(staff, conversationId))) throw new HttpError(404, 'Not found');
  if (file.size > MAX) throw new HttpError(413, 'File is larger than 16 MB');
  const buf = Buffer.from(await file.arrayBuffer());
  const mime = sniffMime(buf);
  if (!mime || !ALLOWED.has(mime)) throw new HttpError(415, 'Only JPEG, PNG, WebP, PDF, MP4, MP3 and OGG files can be sent');
  const name = (file.name || 'file').replace(/[^\p{L}\p{M}\p{N}.\- _]/gu, '_').slice(0, 120);
  const r = await getPool().query(
    `INSERT INTO app.staff_uploads (conversation_id, staff_id, file_name, mime_type, size_bytes, sha256, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [conversationId, staff.id, name, mime, buf.length, createHash('sha256').update(buf).digest(), buf]);
  return json({ upload_id: r.rows[0].id, mime_type: mime, file_name: name, size_bytes: buf.length });
});
