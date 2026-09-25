// Strict absolute-URL parsing for n8n Code nodes. n8n's Code sandbox (task
// runner) has no URL or URLSearchParams globals, so the few URL checks the
// workflow needs are done here. Only http(s) URLs with a plain hostname (or
// IPv4 address) are accepted; anything unusual returns null.

/**
 * @param {unknown} s
 * @returns {null | { protocol: string, userinfo: string, hostname: string, port: string, host: string, pathname: string, search: string }}
 */
export function parseUrl(s) {
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

// Raw query pairs, kept exactly as encoded (no decode/re-encode round trip).
/**
 * @param {string} search
 * @returns {string[][]}
 */
export function rawQueryPairs(search) {
  return String(search || '').replace(/^\?/, '').split('&').filter(Boolean).map((p) => {
    const i = p.indexOf('=');
    return i < 0 ? [p, ''] : [p.slice(0, i), p.slice(i + 1)];
  });
}
