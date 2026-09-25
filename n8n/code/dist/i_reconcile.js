// WA · I Maintenance — "Match Unknown Send"
// Input: the conversation's recent messages from Zernio for ONE send whose
// outcome is unknown (timeout or 5xx). Exactly one outgoing message with the
// same text, sent after the outbox row was created, is provider evidence and
// resolves the send as sent. Anything else is attached to the alert for a
// person to decide; nothing is re-sent automatically.

const u = $('Unknown Send').first().json;
const r = $input.first().json || {};
const status = typeof r.statusCode === 'number' ? r.statusCode : null;
if (r.error || status === null || status < 200 || status >= 300) {
  return [{ json: { action: 'evidence', outbound_id: u.outbound_id, evidence: { error: 'provider_lookup_failed', http_status: status } } }];
}
const body = typeof r.body === 'string' ? JSON.parse(r.body) : (r.body || {});
const created = Date.parse(u.created_at) - 60 * 1000;
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const want = norm(u.body);
const candidates = (Array.isArray(body.messages) ? body.messages : [])
  .filter((m) => m.direction === 'outgoing' && Date.parse(m.createdAt) >= created)
  .map((m) => ({ id: m.id, created_at: m.createdAt, same_text: want !== '' && norm(m.message) === want }));
const exact = candidates.filter((c) => c.same_text);
if (exact.length === 1 && exact[0].id) {
  return [{ json: { action: 'resolve', outbound_id: u.outbound_id, provider_message_id: exact[0].id,
    evidence: { method: 'provider_message_list_exact_text', candidate: exact[0], checked_at: new Date().toISOString() } } }];
}
return [{ json: { action: 'evidence', outbound_id: u.outbound_id, evidence: { candidates: candidates.slice(0, 10), exact_matches: exact.length } } }];
