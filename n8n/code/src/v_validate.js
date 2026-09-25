// WA · B2 Image Analysis — "Validate Vision Result"
// Input: the buffered OpenRouter response (streaming is not used; a partial
// or truncated result is discarded). The observations are validated on the
// server; anything malformed becomes a failed analysis, never a guess.
// Usage fields that the provider did not return stay null (unavailable).
// @include shared/validate.js

const prep = $('Prepare Vision Request').first().json;
const meta = prep.meta;
const resp = $input.first().json || {};
const usage = extractUsage(resp, meta.model, Date.now() - meta.started_at);
usage.purpose = 'vision';

const httpError = resp.error ? (typeof resp.error === 'object' ? (resp.error.message || JSON.stringify(resp.error)) : String(resp.error)) : null;
const choice = resp.choices && resp.choices[0];
let status = 'failed';
let result = null;
let error = null;

if (httpError || !choice) {
  error = 'model_error: ' + String(httpError || 'no_choices').slice(0, 300);
} else if (choice.finish_reason === 'length') {
  error = 'incomplete_output';
} else {
  const parsed = parseModelJson(choice.message && choice.message.content);
  if (!parsed.ok) {
    status = 'invalid_output';
    error = 'invalid_json';
  } else {
    const v = validateVisionResult(parsed.value);
    if (!v.ok) { status = 'invalid_output'; error = 'invalid_observations: ' + v.errors.join(','); }
    else if (!v.value.readable) { status = 'unreadable'; result = v.value; error = 'image_unreadable'; }
    else { status = 'ok'; result = v.value; }
  }
}
usage.outcome = status === 'ok' || status === 'unreadable' ? 'ok'
  : status === 'invalid_output' ? 'invalid_output'
  : error === 'incomplete_output' ? 'incomplete' : 'error';
if (error) usage.error = error.slice(0, 500);

return [{ json: { status: status, result: result, error: error, usage: usage, meta: meta } }];
