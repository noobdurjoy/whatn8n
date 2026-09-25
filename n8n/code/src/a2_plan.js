// WA · A2 Media Download — "Plan Downloads"
// Input: { list, cfg } from app.pending_attachments and the attachments
// setting. Only Zernio's own authenticated media endpoint is ever fetched:
// the URL must be https://zernio.com/api/v1/... . Links that appear inside
// customer messages or images are never fetched.
// @include shared/url.js: parseUrl

const row = $input.first().json || {};
const list = Array.isArray(row.list) ? row.list : [];
const out = [];
for (const a of list) {
  let ok = false;
  try {
    const u = parseUrl(a.media_ref);
    ok = Boolean(u) && u.protocol === 'https:' && u.host === 'zernio.com' && u.pathname.startsWith('/api/v1/') && !u.userinfo && !u.port && u.pathname.indexOf('..') < 0;
  } catch (e) { ok = false; }
  out.push({ json: { attachment_id: a.attachment_id, url: ok ? String(a.media_ref) : null, blocked: !ok } });
}
// Always at least one item, so the branch reaches "Media Done" and the
// router continues even when there is nothing to download.
return out.length ? out : [{ json: { skip: true } }];
