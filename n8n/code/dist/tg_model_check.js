// Infinity Digital Shop — WhatsApp AI Support · "Check Proposed Action"
// Deterministic validation of the model's proposal (types, integers, exact
// reply text, expiry in the future). Anything doubtful becomes a question.
// ---- begin shared/admin-commands.js (validateAction) (inlined by n8n/build.mjs; edit the shared file, not this copy) ----
// Telegram admin commands: deterministic parsing, validation and stock
// arithmetic. Dependency-free; inlined into the workflow's Code nodes.
//
// Nothing here trusts a model: explicit command forms are parsed by rules;
// only free-form instructions go to the model, and whatever it proposes is
// validated here again (types, numbers, exact reply text, expiry in the
// future). The database then checks the sender's authority and state.
const ACTION_TYPES = ['help', 'status', 'stock_set', 'stock_adjust', 'stock_status', 'knowledge_permanent', 'notice_temporary',
  'notice_cancel', 'notice_list', 'staff_note', 'reply_whatsapp', 'clarify', 'cancel'];

// Bangladesh-first phone normalization for admin replies. Returns digits in
// international form without "+" (e.g. "8801350590593"), or null.
/** @param {unknown} input */

function normalizePhone(input) {
  const bn = '০১২৩৪৫৬৭৮৯';
  const s = String(input == null ? '' : input).replace(/[০-৯]/g, (d) => String(bn.indexOf(d)));
  const hadPlus = /^\s*\+/.test(s);
  let d = s.replace(/[^0-9]/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  else if (/^01[3-9]\d{8}$/.test(d)) d = '88' + d;
  else if (/^1[3-9]\d{8}$/.test(d) && !hadPlus) d = '880' + d;
  if (/^880/.test(d) && !/^8801[3-9]\d{8}$/.test(d)) return null;
  return /^[1-9]\d{7,14}$/.test(d) ? d : null;
}

const clean = (s) => String(s || '').trim();

function titleFrom(text) {
  const t = clean(text).replace(/\s+/g, ' ');
  return t.length <= 60 ? t : t.slice(0, 57).replace(/\s+\S*$/, '') + '…';
}

/**
 * Validates a model-proposed action (or a follow-up) against the original
 * text. Returns { ok, action } or { ok: false, clarify }.
 * @param {any} raw
 * @param {string} originalText
 * @param {{ now?: Date }} [opts]
 * @returns {any}
 */
function validateAction(raw, originalText, opts) {
  const now = (opts && opts.now) || new Date();
  const a = raw && typeof raw === 'object' ? raw : {};
  const type = a.type;
  const q = (question) => ({ ok: false, clarify: question });
  if (!ACTION_TYPES.includes(type)) return q('I could not understand that. Send /help for examples.');
  if (type === 'clarify') return q(clean(a.question).slice(0, 300) || 'Could you say that differently?');
  if (['help', 'status', 'notice_list', 'cancel'].includes(type)) return { ok: true, action: { type } };

  const ref = {};
  if (a.sku && /^[A-Za-z0-9._-]{1,64}$/.test(String(a.sku))) ref.sku = String(a.sku);
  if (a.product_id !== undefined && a.product_id !== null) {
    if (!Number.isInteger(a.product_id) || a.product_id <= 0) return q('Which product id?');
    ref.product_id = a.product_id;
    if (Number.isInteger(a.variation_id) && a.variation_id > 0) ref.variation_id = a.variation_id;
  }
  if (!ref.sku && !ref.product_id && clean(a.query).length >= 2) ref.query = clean(a.query).slice(0, 80);

  if (type === 'stock_set') {
    if (!Number.isInteger(a.quantity) || a.quantity < 0 || a.quantity > 1000000) return q('What exact quantity should I set?');
    if (!ref.sku && !ref.product_id && !ref.query) return q('Which product (SKU, product id or name)?');
    return { ok: true, action: Object.assign({ type, quantity: a.quantity }, ref) };
  }
  if (type === 'stock_adjust') {
    if (!Number.isInteger(a.delta) || a.delta === 0 || Math.abs(a.delta) > 100000) return q('By how many units should I change the stock?');
    if (!ref.sku && !ref.product_id && !ref.query) return q('Which product (SKU, product id or name)?');
    return { ok: true, action: Object.assign({ type, delta: a.delta }, ref) };
  }
  if (type === 'stock_status') {
    if (!['instock', 'outofstock'].includes(a.stock_status)) return q('Should the product be in stock or out of stock?');
    if (!ref.sku && !ref.product_id && !ref.query) return q('Which product (SKU, product id or name)?');
    return { ok: true, action: Object.assign({ type, stock_status: a.stock_status }, ref) };
  }
  if (type === 'knowledge_permanent' || type === 'staff_note') {
    const body = clean(a.body).slice(0, type === 'staff_note' ? 4000 : 8000);
    if (body.length < 3) return q('What exactly should I save?');
    const category = ['faq', 'product', 'procedure', 'policy'].includes(a.category) ? a.category : 'faq';
    return { ok: true, action: type === 'staff_note' ? { type, body } : { type, title: clean(a.title).slice(0, 120) || titleFrom(body), body, category } };
  }
  if (type === 'notice_temporary') {
    const body = clean(a.body).slice(0, 2000);
    if (body.length < 3) return q('What should the temporary notice say?');
    const keywords = Array.isArray(a.keywords) ? a.keywords.map((k) => clean(k).toLowerCase()).filter((k) => k.length >= 2 && k.length <= 40).slice(0, 8) : [];
    const exp = a.expires_at ? new Date(a.expires_at) : null;
    if (!exp || isNaN(exp.getTime())) return { ok: true, action: { type, body, keywords, title: clean(a.title).slice(0, 120) || titleFrom(body), expires_at: null } };
    if (exp.getTime() <= now.getTime()) return q('That expiry time is already in the past. When should the notice end? (e.g. "tomorrow 6pm")');
    if (exp.getTime() > now.getTime() + 180 * 86400000) return q('Temporary notices can last at most 180 days. When should it end?');
    const start = a.starts_at ? new Date(a.starts_at) : null;
    const startsAt = start && !isNaN(start.getTime()) && start.getTime() > now.getTime() && start.getTime() < exp.getTime() ? start.toISOString() : null;
    return { ok: true, action: { type, body, keywords, title: clean(a.title).slice(0, 120) || titleFrom(body), expires_at: exp.toISOString(), starts_at: startsAt } };
  }
  if (type === 'notice_cancel') return { ok: true, action: { type, match: clean(a.match).slice(0, 80) } };
  if (type === 'reply_whatsapp') {
    const phone = normalizePhone(a.phone);
    const text = typeof a.text === 'string' ? a.text.trim() : '';
    if (!phone) return q('Which WhatsApp number? Send it like: Reply to 017XXXXXXXX: your message');
    // The customer gets EXACTLY what the admin wrote: the proposed text must
    // be the whole part after the first ":" or a whole quoted part of the
    // admin's message, never a paraphrase or a cut-down piece of it.
    const orig = String(originalText || '');
    const afterColon = orig.indexOf(':') >= 0 ? orig.slice(orig.indexOf(':') + 1).trim() : null;
    const quoted = [];
    const qre = /["“«]([^"“”«»]{1,2000})["”»]/g;
    let qm;
    while ((qm = qre.exec(orig))) quoted.push(qm[1].trim());
    if (!text || (text !== afterColon && quoted.indexOf(text) < 0)) {
      return q('To send a WhatsApp reply, write it as: Reply to 017XXXXXXXX: the exact message');
    }
    return { ok: true, action: { type, phone, text } };
  }
  return q('I could not understand that. Send /help for examples.');
}
// ---- end shared/admin-commands.js ----
// ---- begin shared/validate.js (parseModelJson, extractUsage) (inlined by n8n/build.mjs; edit the shared file, not this copy) ----
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

const j = $('Build Command Request').first().json;
const resp = $input.first().json || {};
const usage = extractUsage(resp, j.request.model, null);
usage.purpose = 'admin_command';
usage.outcome = resp.error ? 'error' : 'ok';
const base = { update_id: j.update_id, chat_id: j.chat_id, admin_id: j.admin_id, text: j.text, pending: j.pending, usage: usage };
const choice = resp.choices && resp.choices[0];
const parsed = choice && choice.finish_reason !== 'length' ? parseModelJson(choice.message && choice.message.content) : { ok: false };
if (!parsed.ok) return [{ json: Object.assign(base, { route: 'reply', reply: 'I could not process that right now. Try an explicit command (send /help).' }) }];
const raw = parsed.value;
if (j.followup && raw.type === 'notice_temporary') raw.body = j.followup.action.body;
const v = validateAction(raw, j.text);
if (!v.ok) return [{ json: Object.assign(base, { route: 'reply', reply: v.clarify }) }];
return [{ json: Object.assign(base, { route: 'start', action: v.action, parsed_by: j.followup ? 'followup' : 'model', parent_id: j.followup ? j.followup.command_id : null }) }];
