// WA · A2 Media Download — "Plan Downloads"
// Input: { list, cfg } from app.pending_attachments and the attachments
// setting. Only Zernio's own authenticated media endpoint is ever fetched:
// the URL must be https://zernio.com/api/v1/... . Links that appear inside
// customer messages or images are never fetched.

const row = $input.first().json || {};
const list = Array.isArray(row.list) ? row.list : [];
const out = [];
for (const a of list) {
  let ok = false;
  try {
    const u = new URL(String(a.media_ref || ''));
    ok = u.protocol === 'https:' && u.host === 'zernio.com' && u.pathname.startsWith('/api/v1/') && !u.username && !u.password && !u.port;
  } catch (e) { ok = false; }
  out.push({ json: { attachment_id: a.attachment_id, url: ok ? String(a.media_ref) : null, blocked: !ok } });
}
return out.length ? out : [];
