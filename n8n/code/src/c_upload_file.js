// WA · C Dispatcher — "Prepare Upload"
// Input: the staff upload row (app.get_outbound_upload) and the presign
// response from Zernio (POST /v1/media/presign -> { uploadUrl, publicUrl }).
// Output: the file as binary for the PUT, or a retryable failure (nothing
// has been sent to the customer yet, so retrying is safe).

const b = $('Build Send').first().json;
const up = $('Load Upload').first().json || {};
const pre = $input.first().json || {};
function fail(code) {
  return [{ json: { route: 'record', outbound_id: b.outbound_id, attempt_no: b.attempt_no,
    record: { outcome: 'rejected_retryable', http_status: null, provider_message_id: null, response: null, error: { code: code }, retry_after_seconds: 60 } } }];
}
if (!up.data_base64) return fail('upload_not_found');
const body = pre.body || pre;
const uploadUrl = body && body.uploadUrl;
const publicUrl = body && body.publicUrl;
if (typeof uploadUrl !== 'string' || !/^https:\/\//.test(uploadUrl)) return fail('presign_failed');
if (typeof publicUrl !== 'string' || !/^https:\/\//.test(publicUrl)) return fail('presign_failed');
return [{
  json: { route: 'put', upload_url: uploadUrl, public_url: publicUrl, mime_type: up.mime_type },
  binary: { data: { data: up.data_base64, mimeType: up.mime_type, fileName: up.file_name } },
}];
