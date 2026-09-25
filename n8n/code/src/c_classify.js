// WA · C Dispatcher — "Classify Result"
// Input: the Zernio send response (full response, errors not thrown) or a
// network error item. A timeout or 5xx is AMBIGUOUS: recorded as 'unknown'
// and reconciled, never blindly retried (the outbox id is also sent as the
// Idempotency-Key, so a replay of the same request cannot double-send).
// @include shared/send-result.js: classifySendResult

const s = $('Send Ready').first().json;
const r = $input.first().json || {};
let input;
if (r.error && typeof r.statusCode !== 'number') {
  const e = r.error || {};
  const code = String(e.code || (e.cause && e.cause.code) || e.message || '').toUpperCase();
  const net = /ETIMEDOUT|ESOCKETTIMEDOUT|ECONNABORTED|TIMEOUT/.test(code) ? 'timeout'
    : /ECONNRESET|EPIPE|SOCKET HANG UP/.test(code) ? 'reset'
    : /ECONNREFUSED/.test(code) ? 'refused'
    : /ENOTFOUND|EAI_AGAIN/.test(code) ? 'dns' : 'unknown';
  input = { status: null, body: null, headers: null, networkError: net };
} else {
  input = { status: r.statusCode, body: r.body, headers: r.headers || null, networkError: null };
}
const c = classifySendResult(input);
let body = r.body;
if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = { raw: body.slice(0, 500) }; } }
// Only the ids and status are stored, not the whole provider response.
const response = body && typeof body === 'object' ? { success: body.success, messageId: body.data && body.data.messageId, status: input.status } : { status: input.status };
return [{ json: { route: 'record', outbound_id: s.outbound_id, attempt_no: s.attempt_no, record: {
  outcome: c.outcome, http_status: input.status, provider_message_id: c.provider_message_id,
  response: response, error: c.error, retry_after_seconds: c.retry_after_seconds,
} } }];
