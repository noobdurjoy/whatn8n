// Infinity Digital Shop — WhatsApp AI Support · "Connection Check Result"
// One summary item: which connections work, with facts only (status codes,
// counts, model ids, tool names). No keys, message bodies or image bytes.
// The vision answer goes through the same validator as customer images.
// ---- begin shared/validate.js (parseModelJson, validateVisionResult) (inlined by n8n/build.mjs; edit the shared file, not this copy) ----
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
// ---- end shared/validate.js ----

const get = (n) => { try { return $(n).isExecuted ? $(n).first().json : null; } catch (e) { return null; } };
const code = (r) => (r && typeof r.statusCode === 'number' ? r.statusCode : null);
const body = (r) => (r && r.body !== undefined ? (typeof r.body === 'string' ? (() => { try { return JSON.parse(r.body); } catch (e) { return r.body; } })() : r.body) : null);
const res = {};

const store = get('Check Store API');
const products = Array.isArray(body(store)) ? body(store) : [];
res.woocommerce_store_api = { ok: code(store) === 200 && products.length > 0, http_status: code(store), products_found: products.length,
  sample: products[0] ? { id: products[0].id, name: String(products[0].name || '').slice(0, 80), price_minor: products[0].prices && products[0].prices.price, currency: products[0].prices && products[0].prices.currency_code } : null };

const chat = body(get('Check Chat Model')) || {};
const cm = chat.choices && chat.choices[0] && chat.choices[0].message;
const calls = cm && Array.isArray(cm.tool_calls) ? cm.tool_calls : [];
res.openrouter_chat = { ok: calls.length > 0 && calls[0].function && calls[0].function.name === 'search_products', http_status: code(get('Check Chat Model')),
  model: chat.model || null, tool_called: calls[0] && calls[0].function ? calls[0].function.name : null,
  tool_arguments: calls[0] && calls[0].function ? String(calls[0].function.arguments || '').slice(0, 200) : null,
  usage_available: Boolean(chat.usage), error: chat.error ? String(chat.error.message || chat.error).slice(0, 200) : null };

const vp = get('Prepare Vision Check') || {};
const vis = body(get('Check Vision Model')) || {};
const pj = parseModelJson(String(vis.choices && vis.choices[0] && vis.choices[0].message && vis.choices[0].message.content || ''));
const vv = pj.ok ? validateVisionResult(pj.value) : { ok: false, errors: [pj.error || 'not_json'] };
res.openrouter_vision = { ok: Boolean(vv.ok && vv.value.readable), http_status: code(get('Check Vision Model')), model: vis.model || null,
  image_bytes_sent: vp.image_bytes || 0, validator: vv.ok ? 'passed' : (vv.errors || []).join(','),
  image_type: vv.ok ? vv.value.image_type : null, visible_details: vv.ok ? vv.value.visible_details.slice(0, 4) : null,
  usage_available: Boolean(vis.usage), error: vp.error || (vis.error ? String(vis.error.message || vis.error).slice(0, 200) : null) };

const z = get('Check Zernio');
const zb = body(z) || {};
const accts = Array.isArray(zb.accounts) ? zb.accounts : Array.isArray(zb) ? zb : [];
res.zernio = { ok: code(z) === 200, http_status: code(z), accounts: accts.length,
  whatsapp_accounts: accts.filter((a) => String(a.platform || '').toLowerCase() === 'whatsapp').length };

const pg = get('Check Postgres');
res.postgres = { ok: Boolean(pg && pg.db_user), db_user: pg && pg.db_user || null, ai_enabled: pg ? pg.ai_enabled : null, sending_enabled: pg ? pg.sending_enabled : null,
  error: pg && pg.error ? String(pg.error.message || pg.error).slice(0, 200) : (pg ? null : 'not_run') };

const h = get('Check Backend Health');
res.backend_health = { ok: code(h) === 200, http_status: code(h), url: pg && pg.dashboard_url || null };
const t = get('Check Backend Token');
res.backend_token = { ok: code(t) === 200, http_status: code(t) };

const w = get('Check WooCommerce REST');
res.woocommerce_rest = { ok: Boolean(w && w.id && !w.error), error: w && w.error ? String(w.error.message || w.error).slice(0, 200) : (w ? null : 'not_run') };

const failed = Object.keys(res).filter((k) => !res[k].ok);
return [{ json: { all_ok: failed.length === 0, failed: failed, checked_at: new Date().toISOString(), results: res } }];
