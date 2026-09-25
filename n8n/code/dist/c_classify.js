// WA · C Dispatcher — "Classify Result"
// Input: the Zernio send response (full response, errors not thrown) or a
// network error item. A timeout or 5xx is AMBIGUOUS: recorded as 'unknown'
// and reconciled, never blindly retried (the outbox id is also sent as the
// Idempotency-Key, so a replay of the same request cannot double-send).
// ---- begin shared/send-result.js (classifySendResult) (inlined by n8n/build.mjs; edit the shared file, not this copy) ----
// Classifies a Zernio "send message" HTTP result for the dispatcher.
// Dependency-free; inlined into the n8n dispatch workflow.
//
// Based on Zernio's documented contract for
// POST /v1/inbox/conversations/{conversationId}/messages:
// - 2xx: accepted; data.messageId is the WhatsApp wamid.
// - Idempotency-Key: same key + same body replays the original 2xx;
//   409 = same key still in flight; 422 = same key reused with another body.
// - A 5xx or a network timeout is AMBIGUOUS: the platform may have accepted
//   the message, the key may have been released, and a blind retry could send
//   twice. Reconcile first (list the conversation's messages), never auto-retry.
// - WhatsApp rejects bursts to one recipient with error 131056.
//
// input: { status: number|null, body: object|string|null, headers: object|null,
//          networkError: string|null }   networkError: 'timeout' | 'reset' | 'refused' | 'dns' | other
// output: { outcome, provider_message_id, retry_after_seconds, error }
function header(headers, name) {
  if (!headers) return null;
  const k = Object.keys(headers).find((h) => h.toLowerCase() === name);
  return k ? headers[k] : null;
}

function classifySendResult(input) {
  const status = input && typeof input.status === 'number' ? input.status : null;
  let body = input ? input.body : null;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = { raw: body.slice(0, 500) }; }
  }
  body = body || {};
  const retryAfter = Number(header(input && input.headers, 'retry-after')) || null;
  const platformCode = body.platformError && typeof body.platformError.code === 'number' ? body.platformError.code : null;
  const err = (code, extra) => Object.assign({ code, http_status: status, message: String(body.error || body.message || '').slice(0, 300), platform_code: platformCode }, extra || {});

  if (input && input.networkError) {
    // Refused / DNS failure: the request never reached Zernio. Safe to retry.
    if (['refused', 'dns'].includes(input.networkError)) {
      return { outcome: 'rejected_retryable', provider_message_id: null, retry_after_seconds: 30, error: err('network_' + input.networkError) };
    }
    // Timeout / reset after sending: unknown whether it was accepted.
    return { outcome: 'ambiguous', provider_message_id: null, retry_after_seconds: null, error: err('network_' + input.networkError) };
  }
  if (status === null) {
    return { outcome: 'ambiguous', provider_message_id: null, retry_after_seconds: null, error: err('no_status') };
  }
  if (status >= 200 && status < 300) {
    const id = body.data && typeof body.data.messageId === 'string' ? body.data.messageId : null;
    return { outcome: 'accepted', provider_message_id: id, retry_after_seconds: null, error: null };
  }
  if (status === 409) {
    return { outcome: 'rejected_retryable', provider_message_id: null, retry_after_seconds: retryAfter || 10, error: err('idempotency_in_flight') };
  }
  if (status === 422) {
    return { outcome: 'rejected_permanent', provider_message_id: null, retry_after_seconds: null, error: err('idempotency_key_reused') };
  }
  if (status === 429) {
    return { outcome: 'rejected_retryable', provider_message_id: null, retry_after_seconds: retryAfter || 60, error: err('rate_limited') };
  }
  if (status === 400 && platformCode === 131056) {
    return { outcome: 'rejected_retryable', provider_message_id: null, retry_after_seconds: 60, error: err('recipient_rate_limited') };
  }
  if (status === 400 && platformCode === 131047) {
    return { outcome: 'rejected_permanent', provider_message_id: null, retry_after_seconds: null, error: err('outside_customer_service_window') };
  }
  if (status === 401 || status === 403) {
    return { outcome: 'rejected_permanent', provider_message_id: null, retry_after_seconds: null, error: err('provider_auth_or_access') };
  }
  if (status >= 500) {
    return { outcome: 'ambiguous', provider_message_id: null, retry_after_seconds: null, error: err('provider_5xx') };
  }
  return { outcome: 'rejected_permanent', provider_message_id: null, retry_after_seconds: null, error: err(body.code || 'rejected') };
}
// ---- end shared/send-result.js ----

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
