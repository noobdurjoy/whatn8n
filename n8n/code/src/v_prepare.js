// WA · B2 Image Analysis — "Prepare Vision Request"
// Input: one row from "Load Image" { cur, vision, models, prompt, budget, reuse, att }.
// The image bytes come from our own database (downloaded earlier through the
// authenticated Zernio media endpoint) and go to the model as a base64 data
// URL. No provider URL, filename or credential is ever put in the prompt, and
// no URL from the customer's message or the image is fetched.
// Output: { route: 'call', request, meta } or { route: 'done', final }.

const call = $('Image Request').first().json;
const row = $input.first().json || {};
const vision = row.vision || {};
const models = row.models || {};
const model = models.vision_model;
const promptVersion = vision.prompt_version || 'vision-v1';
const question = String((call.args && call.args.question) || '').slice(0, 500);
const attachmentId = call.args && call.args.attachment_id;

function done(error, extra) {
  return [{ json: { route: 'done', final: Object.assign({ ok: false, ref: null, result: null, reused: false, attempted: false, usage: null, error: error }, extra || {}) } }];
}

// Staleness: a takeover or a newer customer message ends the job; no analysis
// is started for a job that is no longer current.
if (!row.cur || !row.cur.current) return done('job_not_current');
if (vision.enabled === false) return done('image_analysis_disabled');
if (!model) return done('vision_model_not_configured');
if (row.budget && row.budget.within_budget === false) return done('ai_budget_reached');

// Same image, same model, same prompt version: reuse the stored observations.
if (row.reuse && row.reuse.status === 'ok' && row.reuse.result) {
  return done(null, { ok: true, ref: 'img:' + row.reuse.analysis_id, result: row.reuse.result, reused: true });
}

const att = row.att;
if (!att || !att.data_base64) return done('image_not_available');
const allowed = Array.isArray(vision.allowed_mime_types) && vision.allowed_mime_types.length ? vision.allowed_mime_types : ['image/jpeg', 'image/png', 'image/webp'];
if (allowed.indexOf(att.mime_type) < 0) return done('unsupported_image_type');
const maxBytes = Number(vision.max_image_bytes) || 5 * 1024 * 1024;
if (!att.size_bytes || Number(att.size_bytes) > maxBytes) return done('image_too_large');

const lang = { bn: 'Bangla', en: 'English', banglish: 'Banglish' };
const text = [
  'Question from the support assistant: ' + (question || 'Describe what the customer is showing.'),
  'Customer language: ' + (lang[call.customer_language] || 'unknown') + '. Transcribe Bangla text in Bangla script.',
  'Return only the JSON object described in your instructions.',
].join('\n');

const request = {
  model: model,
  messages: [
    { role: 'system', content: String(row.prompt || '') },
    // Text part first, then the image part (raw HTTP shape: image_url).
    { role: 'user', content: [
      { type: 'text', text: text },
      { type: 'image_url', image_url: { url: 'data:' + att.mime_type + ';base64,' + att.data_base64 } },
    ] },
  ],
  response_format: { type: 'json_object' },
  max_tokens: models.vision_max_tokens || 1200,
  temperature: 0.1,
  provider: { require_parameters: true },
};

return [{ json: { route: 'call', request: request, meta: {
  job_id: call.job_id, attachment_id: attachmentId, model: model, prompt_version: promptVersion,
  question: question, sha256: att.sha256_hex, started_at: Date.now(),
} } }];
