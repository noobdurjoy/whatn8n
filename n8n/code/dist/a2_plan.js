// WA · A2 Media Download — "Plan Downloads"
// Input: { list, cfg } from app.pending_attachments and the attachments
// setting. Only Zernio's own authenticated media endpoint is ever fetched:
// the URL must be https://zernio.com/api/v1/... . Links that appear inside
// customer messages or images are never fetched.
// ---- begin shared/url.js (parseUrl) (inlined by n8n/build.mjs; edit the shared file, not this copy) ----
// Strict absolute-URL parsing for n8n Code nodes. n8n's Code sandbox (task
// runner) has no URL or URLSearchParams globals, so the few URL checks the
// workflow needs are done here. Only http(s) URLs with a plain hostname (or
// IPv4 address) are accepted; anything unusual returns null.
/**
 * @param {unknown} s
 * @returns {null | { protocol: string, userinfo: string, hostname: string, port: string, host: string, pathname: string, search: string }}
 */
function parseUrl(s) {
  const str = String(s == null ? '' : s).trim();
  if (!str || str.length > 4096 || /[\s\\<>"'`]/.test(str)) return null;
  const m = /^(https?):\/\/(?:([^@/?#]*)@)?([A-Za-z0-9.-]+)(?::(\d{1,5}))?(\/[^?#]*)?(\?[^#]*)?(?:#.*)?$/i.exec(str);
  if (!m) return null;
  const hostname = m[3].toLowerCase();
  if (hostname.startsWith('.') || hostname.endsWith('.') || hostname.includes('..')) return null;
  const port = m[4] || '';
  return {
    protocol: m[1].toLowerCase() + ':',
    userinfo: m[2] || '',
    hostname,
    port,
    host: hostname + (port ? ':' + port : ''),
    pathname: m[5] || '/',
    search: m[6] || '',
  };
}
// ---- end shared/url.js ----

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
