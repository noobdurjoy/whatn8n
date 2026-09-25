// Infinity Digital Shop — WhatsApp AI Support · "Connection Check Result"
// One summary item: which connections work, with facts only (status codes,
// counts, model ids, tool names). No keys, message bodies or image bytes.
// The vision answer goes through the same validator as customer images.
// @include shared/validate.js: parseModelJson, validateVisionResult

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
