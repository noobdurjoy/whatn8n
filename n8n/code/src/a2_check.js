// WA · A2 Media Download — "Check Download"
// One output item per planned attachment (same order as "Plan Downloads").
// The bytes go to the database as base64; store_attachment_blob re-checks
// size, allowed type and the file's magic bytes. Nothing is logged.
// Expired media (Meta keeps it for a limited time) is marked 'expired' so
// the assistant asks the customer to send it again.

const plans = $('Plan Downloads').all().map((i) => i.json);
const cfg = $('Load Pending').first().json.cfg || {};
const maxBytes = Number(cfg.max_bytes) || 16 * 1024 * 1024;
const allowed = Array.isArray(cfg.allowed_mime_types) ? cfg.allowed_mime_types : ['image/jpeg', 'image/png', 'image/webp'];
const items = $input.all();
const out = [];
for (let i = 0; i < items.length; i++) {
  const plan = plans[i] || {};
  const j = items[i].json || {};
  if (!plan.attachment_id) continue;
  if (plan.blocked) { out.push({ json: { ok: false, attachment_id: plan.attachment_id, status: 'failed', error: 'media_url_not_allowed' } }); continue; }
  const status = typeof j.statusCode === 'number' ? j.statusCode : null;
  if (j.error || status === null) { out.push({ json: { ok: false, attachment_id: plan.attachment_id, status: 'failed', error: 'download_error' } }); continue; }
  if (status === 400 || status === 404 || status === 410) { out.push({ json: { ok: false, attachment_id: plan.attachment_id, status: 'expired', error: 'http_' + status } }); continue; }
  if (status < 200 || status >= 300 || !items[i].binary || !items[i].binary.data) {
    out.push({ json: { ok: false, attachment_id: plan.attachment_id, status: 'failed', error: 'http_' + status } });
    continue;
  }
  const buf = await this.helpers.getBinaryDataBuffer(i, 'data');
  const headers = j.headers || {};
  const ct = String(headers['content-type'] || items[i].binary.data.mimeType || '').split(';')[0].trim().toLowerCase();
  if (buf.length > maxBytes) { out.push({ json: { ok: false, attachment_id: plan.attachment_id, status: 'failed', error: 'too_large: ' + buf.length + ' bytes' } }); continue; }
  out.push({ json: { ok: true, attachment_id: plan.attachment_id, mime: ct, data_base64: buf.toString('base64'), max_bytes: maxBytes, allowed: allowed } });
}
return out;
