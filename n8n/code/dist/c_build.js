// WA · C Dispatcher — "Build Send"
// Input: { claim } from "Claim Outbound" (app.claim_outbound). Every sender
// (AI replies, staff replies, approved drafts, handoff acknowledgements,
// scheduled and system messages, retries) comes through this one path, and
// claim_outbound has already re-checked the emergency stop, AI switch, mode,
// mode version, revision, holds, window, consent and pacing under the
// conversation lock. Nothing is sent unless the claim succeeded.
// ---- begin shared/send-result.js (buildSendBody) (inlined by n8n/build.mjs; edit the shared file, not this copy) ----
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
