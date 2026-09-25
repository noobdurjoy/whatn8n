// WA · C Dispatcher — "After Upload"
// Input: the response of the presigned PUT. On success the outbox payload
// gets the public URL (app.set_outbound_media_url, next node) and the send
// continues; on failure the attempt is recorded as retryable.
// @include shared/send-result.js

const b = $('Build Send').first().json;
const prep = $('Prepare Upload').first().json;
const r = $input.first().json || {};
const status = typeof r.statusCode === 'number' ? r.statusCode : null;
if (r.error || status === null || status < 200 || status >= 300) {
  return [{ json: { route: 'record', outbound_id: b.outbound_id, attempt_no: b.attempt_no,
    record: { outcome: 'rejected_retryable', http_status: status, provider_message_id: null, response: null, error: { code: 'media_upload_failed' }, retry_after_seconds: 60 } } }];
}
const claim = JSON.parse(JSON.stringify(b.claim));
claim.payload.attachment.url = prep.public_url;
if (!claim.payload.attachment.type) {
  const m = String(prep.mime_type || '');
  claim.payload.attachment.type = m.startsWith('image/') ? 'image' : m.startsWith('video/') ? 'video' : m.startsWith('audio/') ? 'audio' : 'file';
}
return [{ json: { route: 'send', outbound_id: b.outbound_id, attempt_no: b.attempt_no, idempotency_key: b.idempotency_key, kind: b.kind,
  public_url: prep.public_url,
  path: '/v1/inbox/conversations/' + encodeURIComponent(claim.provider_conversation_id) + '/messages',
  send_body: buildSendBody(claim) } }];
