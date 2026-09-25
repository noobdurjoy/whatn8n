// WA · B AI Reply — "R3 Parse Response"
// Input: the OpenRouter response for this round. Reads the state that built
// the request from the node that ran just before the model call, records
// usage (missing usage stays null = unavailable), and decides: run tools,
// or go to validation. Streaming is not used: the whole response is buffered.
// ---- begin shared/validate.js (inlined by n8n/build.mjs; edit the shared file, not this copy) ----
// Server-side validation of model output. Dependency-free; inlined into n8n
// Code nodes and imported by the backend and tests. JSON from a model is never
// trusted to match its schema: everything is checked here before use.

const REPLY_DECISIONS = ['reply', 'handoff', 'no_reply'];
const HANDOFF_REASONS = [
  'customer_requested_human', 'unresolved_complaint', 'repeated_failed_answers', 'refund_request',
  'unavailable_information', 'purchase_intent', 'order_change_request', 'payment_verification',
  'unsupported_media', 'sensitive_request', 'other',
];
const INTENTS = [
  'greeting', 'product_question', 'price_question', 'purchase_intent', 'order_status', 'payment_issue',
  'refund_request', 'cancellation', 'delivery_issue', 'renewal', 'access_issue', 'complaint',
  'human_request', 'image_question', 'thanks', 'other',
];
const LANGS = ['bn', 'en', 'banglish'];

const INTERNAL_LEAK_RE = /<\/?think>|\bchain[- ]of[- ]thought\b|\bsystem prompt\b|\bmy instructions\b|\bas an ai language model\b|\btool_call\b|\bfunction call\b|"decision"\s*:/i;
const VIEWED_IMAGE_RE = /\b(?:i can see|i see (?:in|on) (?:the|your) (?:image|photo|picture|screenshot)|from (?:the|your) (?:image|photo|picture|screenshot)|in (?:the|your) (?:image|photo|picture|screenshot)|looking at (?:the|your)|(?:i(?:'ve| have)? )?(?:checked|reviewed|looked at|viewed|saw|seen|opened) (?:the|your) (?:image|photo|picture|screenshot|receipt|attachment))|(?:ছবিতে|স্ক্রিনশটে|ছবি দেখে|স্ক্রিনশট দেখে|দেখতে পাচ্ছি)|\b(?:chobi(?:te)?|screenshot(?:e)?|pic(?:e)?)\s*(?:e\s*)?(?:dekhchi|dekhlam|dekha jacche|dekhte pacchi)/i;
const PAID_CLAIM_RE = /\b(?:payment|paid|pay)\b[^.!?\n]{0,30}\b(?:received|confirmed|verified|successful|complete[d]?)\b|\b(?:received|confirmed|verified)\b[^.!?\n]{0,20}\b(?:your )?payment\b|\bmark(?:ed)? (?:it |this |the order |your order )?(?:as )?paid\b|পেমেন্ট[^।?!\n]{0,20}(?:পেয়েছি|পেয়েছি|কনফার্ম|নিশ্চিত|সফল)|\bpayment\s*(?:pai(?:si|chi|yechi)|confirm\s*(?:hoise|hoyeche|korchi))/i;
const PRICE_RE = /(?:৳|\bbdt\b|\btk\.?\b|\btaka\b|টাকা|\$|\busd\b)\s*[0-9০-৯]|[0-9০-৯][0-9০-৯,.]*\s*(?:৳|\bbdt\b|\btk\b|\btaka\b|টাকা|\$|\busd\b)/i;
const URL_RE = /\bhttps?:\/\/[^\s<>"')]+/gi;

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

// ctx:
//   mode                 'AUTO' | 'COPILOT' | 'HUMAN' (trusted, from the DB)
//   tool_refs            ids of tool calls that succeeded this turn
//   knowledge_refs       ids of approved knowledge versions supplied this turn
//   image_refs           ids of image analyses that succeeded this turn
//   price_tool_used      true when a product/price tool returned data this turn
//   verified_paid_order  true only when a trusted order-status tool result shows payment
//   allowed_urls         URLs present in tool results / approved knowledge this turn
//   customer_language    detected language (overrides the model's label)
/**
 * @param {any} raw
 * @param {any} [ctx]
 * @returns {{ ok: boolean, errors?: string[], value?: any }}
 */
function validateReply(raw, ctx) {
  const errors = [];
  const c = ctx || {};
  if (!isPlainObject(raw)) return { ok: false, errors: ['not_an_object'] };

  const decision = raw.decision;
  if (!REPLY_DECISIONS.includes(decision)) errors.push('invalid_decision');

  const text = typeof raw.reply_text === 'string' ? raw.reply_text.trim() : '';
  const handoffReason = raw.handoff_reason == null || raw.handoff_reason === '' ? null : raw.handoff_reason;
  if (handoffReason !== null && !HANDOFF_REASONS.includes(handoffReason)) errors.push('invalid_handoff_reason');
  if (decision === 'handoff' && handoffReason === null) errors.push('handoff_reason_required');

  const refs = Array.isArray(raw.references) ? raw.references : [];
  const cleanRefs = [];
  for (const r of refs.slice(0, 20)) {
    if (!isPlainObject(r) || !['knowledge', 'tool', 'image_analysis'].includes(r.type) || typeof r.id !== 'string') {
      errors.push('invalid_reference');
      break;
    }
    const known = r.type === 'knowledge' ? (c.knowledge_refs || []) : r.type === 'tool' ? (c.tool_refs || []) : (c.image_refs || []);
    if (!known.includes(r.id)) { errors.push(`unknown_reference:${r.type}`); break; }
    cleanRefs.push({ type: r.type, id: r.id });
  }

  const intents = Array.isArray(raw.intents) ? raw.intents.filter((i) => INTENTS.includes(i)).slice(0, 5) : [];
  const resolved = typeof raw.resolved === 'boolean' ? raw.resolved : null;

  if (decision === 'reply') {
    if (!text) errors.push('empty_reply');
    if (text.length > 1600) errors.push('reply_too_long');
    if (INTERNAL_LEAK_RE.test(text)) errors.push('internal_content_in_reply');
    if (VIEWED_IMAGE_RE.test(text) && !(c.image_refs && c.image_refs.length)) errors.push('claims_viewed_image_without_analysis');
    if (PAID_CLAIM_RE.test(text) && !c.verified_paid_order) errors.push('unverified_payment_claim');
    if (PRICE_RE.test(text) && !c.price_tool_used) errors.push('price_without_live_tool_data');
    const urls = text.match(URL_RE) || [];
    const allowed = c.allowed_urls || [];
    for (const u of urls) {
      const clean = u.replace(/[.,!?]+$/, '');
      if (!allowed.some((a) => clean === a || clean.startsWith(a))) { errors.push('url_not_from_tool_or_knowledge'); break; }
    }
  }
  if (c.mode === 'HUMAN' && decision === 'reply' && !c.staff_assist) errors.push('reply_in_human_mode');

  const language = c.customer_language || (LANGS.includes(raw.language) ? raw.language : null);
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      decision,
      reply_text: decision === 'reply' ? text : (decision === 'handoff' ? text : ''),
      handoff_reason: handoffReason,
      references: cleanRefs,
      intents,
      resolved,
      language,
    },
  };
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

const ROUND = 'R3';
const PREV = { R1: 'Prepare Turn', R2: 'R1 Collect Tool Results', R3: 'R2 Collect Tool Results', R4: 'Build Repair Request' }[ROUND];
const state = JSON.parse(JSON.stringify($(PREV).first().json.state));
const resp = $input.first().json || {};
const latency = Date.now() - (state.request_started_at || Date.now());

const httpError = resp.error ? (typeof resp.error === 'object' ? (resp.error.message || JSON.stringify(resp.error)) : String(resp.error)) : null;
const usage = extractUsage(resp, state.model, latency);
usage.purpose = state.sandbox ? 'sandbox' : (ROUND === 'R4' ? 'reply_repair' : 'reply');
usage.outcome = httpError ? 'error' : 'ok';
if (httpError) usage.error = httpError.slice(0, 500);
state.usage.push(usage);

const choice = resp.choices && resp.choices[0];
if (httpError || !choice) {
  state.failed = true;
  state.failure = httpError || 'no_choices';
  return [{ json: { next: 'fail', state: state } }];
}
if (choice.finish_reason === 'length') {
  // Truncated output is discarded, never used partially.
  state.usage[state.usage.length - 1].outcome = 'incomplete';
}

const msg = choice.message || {};
const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
if (calls.length && (ROUND === 'R1' || ROUND === 'R2')) {
  state.messages.push({ role: 'assistant', content: msg.content || null, tool_calls: calls });
  state.pending_calls = calls.slice(0, 6).map((c) => ({ id: c.id, name: c.function && c.function.name, arguments: (c.function && c.function.arguments) || '{}' }));
  state.round = ROUND === 'R1' ? 2 : 3;
  return [{ json: { next: 'tools', state: state } }];
}
state.final_content = choice.finish_reason === 'length' ? null : (msg.content || null);
state.final_round = ROUND;
return [{ json: { next: 'validate', state: state } }];
