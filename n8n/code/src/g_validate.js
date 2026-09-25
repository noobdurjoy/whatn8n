// WA · G Memory — "Validate Summary"
// Server-side checks on the summary model's output. Only preferences the
// customer stated, with a known key and a source message from that customer,
// are kept (the database checks the source again). Values with secrets are
// dropped, not stored.
// @include shared/validate.js
// @include shared/redact.js

const meta = $('Prepare Summary Request').first().json.meta;
const resp = $input.first().json || {};
const usage = extractUsage(resp, null, Date.now() - meta.started_at);
usage.purpose = 'summary';
const choice = resp.choices && resp.choices[0];
const parsed = choice && choice.finish_reason !== 'length' ? parseModelJson(choice.message && choice.message.content) : { ok: false };
const KEYS = ['preferred_language', 'preferred_payment_method', 'device', 'preferred_contact_time', 'preferred_name', 'operating_system'];
function list(v, n, len) { return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, n).map((x) => redactSecretsText(x).slice(0, len)) : []; }

if (!parsed.ok || typeof parsed.value.summary !== 'string') {
  usage.outcome = resp.error ? 'error' : 'invalid_output';
  return [{ json: { ok: false, save: { usage: usage } } }];
}
usage.outcome = 'ok';
const v = parsed.value;
const memories = [];
for (const p of (Array.isArray(v.preferences) ? v.preferences : []).slice(0, 6)) {
  if (!p || KEYS.indexOf(p.key) < 0 || typeof p.value !== 'string') continue;
  if (meta.customer_message_ids.indexOf(p.source_message_id) < 0) continue;
  const red = redactSecrets(p.value);
  if (red.redacted.length) continue;
  memories.push({ key: p.key, value: p.value.trim().slice(0, 120), source_message_id: p.source_message_id });
}
return [{ json: { ok: true, save: {
  conversation_id: meta.conversation_id,
  summary: redactSecretsText(v.summary).slice(0, 600),
  actions: list(v.actions_taken, 8, 200),
  open: list(v.open_issues, 5, 200),
  covers_until: meta.covers_until,
  memories: memories,
  usage: usage,
} } }];
