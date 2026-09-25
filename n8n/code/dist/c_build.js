// WA · C Dispatcher — "Build Send"
// Input: { claim } from "Claim Outbound" (app.claim_outbound). Every sender
// (AI replies, staff replies, approved drafts, handoff acknowledgements,
// scheduled and system messages, retries) comes through this one path, and
// claim_outbound has already re-checked the emergency stop, AI switch, mode,
// mode version, revision, holds, window, consent and pacing under the
// conversation lock. Nothing is sent unless the claim succeeded.
// ---- begin shared/send-result.js (inlined by n8n/build.mjs; edit the shared file, not this copy) ----
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

// Builds the Zernio request body from a claimed outbox row. Only fields the
// API documents are used; unknown payload keys are dropped.
/**
 * @param {any} claim
 * @returns {Record<string, any>}
 */
function buildSendBody(claim) {
  /** @type {Record<string, any>} */
  const body = { accountId: claim.provider_account_id };
  const p = claim.payload || {};
  if (p.template && typeof p.template.name === 'string') {
    body.template = { elements: [{ name: p.template.name, language: p.template.language || 'en_US', components: Array.isArray(p.template.components) ? p.template.components : [] }] };
  } else {
    if (claim.body) body.message = claim.body;
    if (p.attachment && typeof p.attachment.url === 'string') {
      body.attachmentUrl = p.attachment.url;
      body.attachmentType = ['image', 'video', 'audio', 'file'].includes(p.attachment.type) ? p.attachment.type : 'file';
      if (p.attachment.filename && body.attachmentType === 'file') body.attachmentName = String(p.attachment.filename).slice(0, 120);
    }
    if (p.reply_to && typeof p.reply_to === 'string') body.replyTo = p.reply_to;
  }
  return body;
}
// ---- end shared/send-result.js ----

const claim = ($input.first().json || {}).claim || {};
if (!claim.claimed) {
  return [{ json: { route: 'skip', reason: claim.reason || 'not_claimed', final: Boolean(claim.final) } }];
}
const base = { outbound_id: claim.outbound_id, attempt_no: claim.attempt_no, idempotency_key: claim.idempotency_key, kind: claim.kind };
function reject(code) {
  return [{ json: Object.assign({ route: 'record', record: { outcome: 'rejected_permanent', http_status: null, provider_message_id: null, response: null, error: { code: code }, retry_after_seconds: null } }, base) }];
}
if (!claim.provider_conversation_id || !/^[\w-]{1,128}$/.test(claim.provider_conversation_id)) return reject('missing_provider_conversation');
if (!claim.provider_account_id) return reject('missing_provider_account');

const p = claim.payload || {};
if (p.attachment && p.attachment.upload_id && !p.attachment.url) {
  // A staff file stored in our database: upload it to Zernio's media storage
  // first (presigned PUT), then send the public URL Zernio returns.
  return [{ json: Object.assign({ route: 'upload', claim: claim }, base) }];
}

const body = buildSendBody(claim);
if (!body.message && !body.template && !body.attachmentUrl) return reject('empty_message');
return [{ json: Object.assign({ route: 'send', path: '/v1/inbox/conversations/' + encodeURIComponent(claim.provider_conversation_id) + '/messages', send_body: body }, base) }];
