// Infinity Digital Shop — WhatsApp AI Support · "Parse Command"
// Explicit command forms are parsed by rules; everything else goes to the
// model (as an authorized admin's text only). The result is validated again
// before the database checks authority and state.
// ---- begin shared/admin-commands.js (parseCommand) (inlined by n8n/build.mjs; edit the shared file, not this copy) ----
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
function parseCommand(text, pending) {
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
// ---- end shared/admin-commands.js ----

const r = ($input.first().json || {}).r || {};
const res = parseCommand(r.text, r.pending);
const base = { update_id: r.update_id, chat_id: r.chat_id, admin_id: r.admin_id, text: r.text, pending: r.pending || null };
if (res.needs_model) return [{ json: Object.assign(base, { route: 'model', followup: res.followup || null }) }];
const action = res.action;
if (action.type === 'clarify') return [{ json: Object.assign(base, { route: 'reply', reply: action.question }) }];
let parent = res.parent_id || null;
if (action.type === 'cancel') {
  if (!r.pending) return [{ json: Object.assign(base, { route: 'reply', reply: 'Nothing to cancel.' }) }];
  parent = r.pending.command_id;
}
return [{ json: Object.assign(base, { route: 'start', action: action, parsed_by: res.parsed_by || 'rules', parent_id: parent }) }];
