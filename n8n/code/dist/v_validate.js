// WA · B2 Image Analysis — "Validate Vision Result"
// Input: the buffered OpenRouter response (streaming is not used; a partial
// or truncated result is discarded). The observations are validated on the
// server; anything malformed becomes a failed analysis, never a guess.
// Usage fields that the provider did not return stay null (unavailable).
// ---- begin shared/validate.js (parseModelJson, validateVisionResult, extractUsage) (inlined by n8n/build.mjs; edit the shared file, not this copy) ----
function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

// Pull the first JSON object out of a model message. Accepts a bare object or
// one wrapped in a ```json fence; anything else is a failure, not a guess.
function parseModelJson(content) {
  if (isPlainObject(content)) return { ok: true, value: content };
  if (typeof content !== 'string') return { ok: false, error: 'no_content' };
  let s = content.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1].trim();
  if (!s.startsWith('{') || !s.endsWith('}')) return { ok: false, error: 'not_a_json_object' };
  try {
    const v = JSON.parse(s);
    return isPlainObject(v) ? { ok: true, value: v } : { ok: false, error: 'not_a_json_object' };
  } catch (e) {
    return { ok: false, error: 'invalid_json' };
  }
}

const IMAGE_TYPES = ['product_photo', 'error_screenshot', 'payment_receipt', 'order_screenshot', 'chat_screenshot', 'document', 'other', 'unclear'];

const REF_KINDS = ['product', 'order_number', 'transaction_id', 'amount', 'error_code', 'other'];

function cleanStrList(v, maxItems, maxLen) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const x of v.slice(0, maxItems)) {
    if (typeof x !== 'string') return null;
    const t = x.trim();
    if (t) out.push(t.slice(0, maxLen));
  }
  return out;
}

// Validates the vision model's observation object. Returns a normalized copy
// or errors; an invalid result is recorded as a failed analysis, never used.
/**
 * @param {any} raw
 * @returns {{ ok: boolean, errors?: string[], value?: any }}
 */
function validateVisionResult(raw) {
  const errors = [];
  if (!isPlainObject(raw)) return { ok: false, errors: ['not_an_object'] };
  if (!IMAGE_TYPES.includes(raw.image_type)) errors.push('invalid_image_type');
  const visible = cleanStrList(raw.visible_details, 12, 200);
  if (visible === null) errors.push('invalid_visible_details');
  const unreadable = cleanStrList(raw.unreadable_areas, 12, 200);
  if (unreadable === null) errors.push('invalid_unreadable_areas');
  const uncertain = cleanStrList(raw.uncertainties, 12, 200);
  if (uncertain === null) errors.push('invalid_uncertainties');
  let texts = [];
  if (!Array.isArray(raw.extracted_text)) errors.push('invalid_extracted_text');
  else {
    for (const t of raw.extracted_text.slice(0, 20)) {
      if (!isPlainObject(t) || typeof t.text !== 'string') { errors.push('invalid_extracted_text_item'); break; }
      texts.push({ text: t.text.trim().slice(0, 500), language: ['bn', 'en', 'other'].includes(t.language) ? t.language : 'other' });
    }
  }
  let refs = [];
  if (!Array.isArray(raw.references)) errors.push('invalid_references');
  else {
    for (const r of raw.references.slice(0, 12)) {
      if (!isPlainObject(r) || typeof r.value !== 'string') { errors.push('invalid_reference_item'); break; }
      refs.push({ kind: REF_KINDS.includes(r.kind) ? r.kind : 'other', value: r.value.trim().slice(0, 120) });
    }
  }
  if (typeof raw.suggested_next_step !== 'string') errors.push('invalid_suggested_next_step');
  if (errors.length) return { ok: false, errors };

  // Secrets that slipped into transcriptions are removed, not trusted.
  const scrub = (s) => s.replace(/\b\d{4,8}\b(?=[^\d]*(?:otp|code|কোড))/gi, '[hidden]');
  const hasSubstance = (visible && visible.length) || texts.length || refs.length;
  return {
    ok: true,
    value: {
      image_type: raw.image_type,
      visible_details: visible.map(scrub),
      extracted_text: texts.map((t) => ({ text: scrub(t.text), language: t.language })),
      references: refs,
      unreadable_areas: unreadable,
      uncertainties: uncertain,
      suggested_next_step: raw.suggested_next_step.trim().slice(0, 300),
      // Nothing usable was observed: treat as unreadable, ask for a clearer image.
      readable: Boolean(hasSubstance) && raw.image_type !== 'unclear',
      // Receipts are references to check, never proof of payment.
      payment_proof: false,
    },
  };
}

// Reduce OpenRouter's response metadata to what we store. Missing usage stays
// null ("unavailable"), never 0.
function extractUsage(resp, model, latencyMs) {
  const u = resp && resp.usage;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    model: (resp && resp.model) || model,
    provider: (resp && resp.provider) || null,
    request_id: (resp && resp.id) || null,
    latency_ms: typeof latencyMs === 'number' ? Math.round(latencyMs) : null,
    prompt_tokens: u ? num(u.prompt_tokens) : null,
    completion_tokens: u ? num(u.completion_tokens) : null,
    reasoning_tokens: u && u.completion_tokens_details ? num(u.completion_tokens_details.reasoning_tokens) : null,
    cost_usd: u ? num(u.cost) : null,
  };
}
// ---- end shared/validate.js ----

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
