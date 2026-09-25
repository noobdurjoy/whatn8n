// Telegram admin commands: deterministic parsing, validation and stock
// arithmetic. Dependency-free; inlined into the workflow's Code nodes.
//
// Nothing here trusts a model: explicit command forms are parsed by rules;
// only free-form instructions go to the model, and whatever it proposes is
// validated here again (types, numbers, exact reply text, expiry in the
// future). The database then checks the sender's authority and state.

export const ACTION_TYPES = ['help', 'status', 'stock_set', 'stock_adjust', 'stock_status', 'knowledge_permanent', 'notice_temporary',
  'notice_cancel', 'notice_list', 'staff_note', 'reply_whatsapp', 'clarify', 'cancel'];

// Bangladesh-first phone normalization for admin replies. Returns digits in
// international form without "+" (e.g. "8801350590593"), or null.
/** @param {unknown} input */
export function normalizePhone(input) {
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

const INT = /^\d{1,7}$/;
const clean = (s) => String(s || '').trim();

function titleFrom(text) {
  const t = clean(text).replace(/\s+/g, ' ');
  return t.length <= 60 ? t : t.slice(0, 57).replace(/\s+\S*$/, '') + '…';
}

// Product reference: { sku } | { product_id, variation_id? } | { query }.
function productRef(s) {
  const t = clean(s);
  let m;
  if ((m = t.match(/^sku\s+([A-Za-z0-9._-]{1,64})$/i))) return { sku: m[1] };
  if ((m = t.match(/^(?:product|id|#)\s*#?\s*(\d{1,12})(?:\s+(?:variation|var)\s*#?\s*(\d{1,12}))?$/i))) {
    return { product_id: Number(m[1]), variation_id: m[2] ? Number(m[2]) : null };
  }
  if (t.length >= 2 && t.length <= 80) return { query: t };
  return null;
}

/**
 * Rules for explicit command forms. Returns { action } or { needs_model: true }.
 * `pending` is the admin's open question (a choice list or a missing expiry).
 * @param {string} text
 * @param {any} [pending]
 * @returns {any}
 */
export function parseCommand(text, pending) {
  const t = clean(text);
  let m;
  if (!t) return { action: { type: 'help' } };
  if (/^\/?(cancel|stop|never ?mind|thak|baad dao)$/i.test(t)) return { action: { type: 'cancel' } };
  if (pending && pending.status === 'awaiting_choice' && (m = t.match(/^#?\s*(\d{1,2})$/))) {
    return { action: Object.assign({}, pending.action, { choice: Number(m[1]) }), parsed_by: 'choice', parent_id: pending.command_id };
  }
  if (pending && pending.status === 'awaiting_expiry') {
    return { needs_model: true, followup: { command_id: pending.command_id, action: pending.action } };
  }
  if (/^\/(start|help|menu)\b/i.test(t) || /^(help|menu|commands?)$/i.test(t)) return { action: { type: 'help' } };
  if (/^\/status\b/i.test(t) || /^status$/i.test(t)) return { action: { type: 'status' } };
  if (/^\/notices\b/i.test(t) || /^(list )?(active )?(temporary )?notices$/i.test(t)) return { action: { type: 'notice_list' } };

  // Reply to <phone>: <exact text>
  if ((m = t.match(/^(?:\/reply|reply(?:\s+to)?)\s+(\+?[\d০-৯][\d০-৯ ()-]{6,20}?)\s*[:：]\s*([\s\S]+)$/i))) {
    const phone = normalizePhone(m[1]);
    const body = m[2].trim();
    if (!phone) return { action: { type: 'clarify', question: 'That phone number does not look valid. Send it like: Reply to 017XXXXXXXX: your message' } };
    return { action: { type: 'reply_whatsapp', phone: phone, text: body } };
  }
  if (/^(\/reply|reply( to)?)\b/i.test(t)) {
    return { action: { type: 'clarify', question: 'Send it as: Reply to 017XXXXXXXX: the exact message. The text after ":" is sent exactly as written.' } };
  }

  // Stock: set / adjust / status
  if ((m = t.match(/^(?:\/stock\s+|set\s+stock\s+(?:for\s+)?|set\s+)(.+?)\s+(?:to|=)\s+(\d{1,7})(?:\s*(?:units?|pcs|pieces))?$/i))) {
    const ref = productRef(m[1]);
    if (ref) return { action: Object.assign({ type: 'stock_set', quantity: Number(m[2]) }, ref) };
  }
  if ((m = t.match(/^(?:add|increase(?:\s+stock)?(?:\s+of)?)\s+(\d{1,6})\s*(?:units?|pcs|pieces)?\s+(?:to|for)\s+(.+)$/i))) {
    const ref = productRef(m[2]);
    if (ref) return { action: Object.assign({ type: 'stock_adjust', delta: Number(m[1]) }, ref) };
  }
  if ((m = t.match(/^(?:remove|subtract|decrease|reduce)\s+(\d{1,6})\s*(?:units?|pcs|pieces)?\s+(?:from|for)\s+(.+)$/i))) {
    const ref = productRef(m[2]);
    if (ref) return { action: Object.assign({ type: 'stock_adjust', delta: -Number(m[1]) }, ref) };
  }
  if ((m = t.match(/^(.+?)\s+(?:is|are)\s+(?:now\s+)?(out of stock|unavailable|sold out|in stock|available|back in stock)\.?$/i))) {
    const ref = productRef(m[1]);
    const out = /out of stock|unavailable|sold out/i.test(m[2]);
    if (ref) return { action: Object.assign({ type: 'stock_status', stock_status: out ? 'outofstock' : 'instock' }, ref) };
  }

  // Knowledge / notes
  if ((m = t.match(/^(?:remember|permanent|policy|faq)\s*[:：-]\s*([\s\S]{3,})$/i))) {
    return { action: { type: 'knowledge_permanent', title: titleFrom(m[1]), body: m[1].trim(), category: 'faq' } };
  }
  if ((m = t.match(/^(?:private\s+note|staff\s+note|note)\s*[:：-]\s*([\s\S]{2,})$/i))) {
    return { action: { type: 'staff_note', body: m[1].trim() } };
  }
  if (/^(?:temporary|temp|notice)\s*[:：-]/i.test(t)) return { needs_model: true };
  if ((m = t.match(/^(?:remove|cancel|delete|end)\s+(?:the\s+)?(?:temporary\s+)?(.*?)\s*(?:temporary\s+)?notice$/i))) {
    return { action: { type: 'notice_cancel', match: m[1].replace(/\btemporary\b/i, '').trim() } };
  }
  return { needs_model: true };
}

const DHAKA_OFFSET_MIN = 6 * 60;

// "Now" in Asia/Dhaka as an ISO string with offset, for the model prompt.
/** @param {Date} [now] */
export function dhakaNowIso(now) {
  const d = new Date((now || new Date()).getTime() + DHAKA_OFFSET_MIN * 60000);
  return d.toISOString().replace(/\.\d{3}Z$/, '+06:00');
}

/** @param {string|Date} iso */
export function formatDhaka(iso) {
  const d = new Date(new Date(iso).getTime() + DHAKA_OFFSET_MIN * 60000);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n) => String(n).padStart(2, '0');
  return days[d.getUTCDay()] + ' ' + p(d.getUTCDate()) + ' ' + months[d.getUTCMonth()] + ' ' + d.getUTCFullYear() + ', ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ' Asia/Dhaka';
}

/**
 * Validates a model-proposed action (or a follow-up) against the original
 * text. Returns { ok, action } or { ok: false, clarify }.
 * @param {any} raw
 * @param {string} originalText
 * @param {{ now?: Date }} [opts]
 * @returns {any}
 */
export function validateAction(raw, originalText, opts) {
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

/**
 * Decides the exact WooCommerce fields to write for a stock command, given the
 * product/variation as read from WooCommerce just before. Returns
 * { write: { ...fields } } or { clarify } — never invents a quantity.
 * @param {any} action
 * @param {{ manage_stock: any, stock_quantity: any, stock_status: any }} current
 * @returns {any}
 */
export function planStockWrite(action, current) {
  const managed = current.manage_stock === true;
  const qty = typeof current.stock_quantity === 'number' ? current.stock_quantity : null;
  if (action.type === 'stock_set') {
    if (!managed) return { clarify: 'Stock tracking is OFF for this item, so it has no quantity. Turn on "Manage stock" in WooCommerce first, or send "<item> is in stock" / "out of stock".' };
    return { write: { stock_quantity: action.quantity } };
  }
  if (action.type === 'stock_adjust') {
    if (!managed || qty === null) return { clarify: 'Stock tracking is OFF for this item, so I cannot add or remove units. Turn on "Manage stock" in WooCommerce first.' };
    const next = qty + action.delta;
    if (next < 0) return { clarify: 'That would make the stock negative (' + qty + ' ' + (action.delta < 0 ? '−' : '+') + ' ' + Math.abs(action.delta) + '). Send the exact quantity instead, e.g. "set stock ... to 0".' };
    return { write: { stock_quantity: next } };
  }
  if (action.type === 'stock_status') {
    if (!managed) return { write: { stock_status: action.stock_status } };
    if (action.stock_status === 'outofstock') return { write: { stock_quantity: 0 } };
    // "Available" alone gives no quantity for a stock-managed item.
    if (qty !== null && qty > 0) return { noop: 'Already in stock (' + qty + ' units).' };
    return { clarify: 'This item tracks a quantity. How many units are available? e.g. "set stock ... to 5".' };
  }
  return { clarify: 'Unsupported stock action.' };
}

// Did WooCommerce end up with what we asked for? (read-back after writing)
/** @param {any} write @param {any} after */
export function stockMatches(write, after) {
  if (!after) return false;
  if ('stock_quantity' in write && after.stock_quantity !== write.stock_quantity) return false;
  if ('stock_status' in write && after.stock_status !== write.stock_status) return false;
  return true;
}
