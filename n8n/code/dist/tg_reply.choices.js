// Infinity Digital Shop — WhatsApp AI Support · "Reply: choices"
// Builds the Telegram answer for the owner. Telegram parses HTML, so every
// value is escaped. No secrets, raw logs or customer data beyond what the
// owner asked about.
// ---- begin shared/admin-commands.js (formatDhaka) (inlined by n8n/build.mjs; edit the shared file, not this copy) ----
const DHAKA_OFFSET_MIN = 6 * 60;

/** @param {string|Date} iso */
function formatDhaka(iso) {
  const d = new Date(new Date(iso).getTime() + DHAKA_OFFSET_MIN * 60000);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n) => String(n).padStart(2, '0');
  return days[d.getUTCDay()] + ' ' + p(d.getUTCDate()) + ' ' + months[d.getUTCMonth()] + ' ' + d.getUTCFullYear() + ', ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ' Asia/Dhaka';
}
// ---- end shared/admin-commands.js ----

const KIND = 'choices';
const up = $('Accept Update').first().json;
const r = up.r || {};
const dash = String(up.dash || '').replace(/\/+$/, '');
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inp = $input.first().json || {};
let text;
const HELP = [
  '<b>Infinity Digital Shop admin bot</b>',
  'Write normally in English, Bangla or Banglish. Examples:',
  '• <code>Set stock for SKU SPOTIFY-1M to 5</code>',
  '• <code>Add 3 units to product 123</code> / <code>Remove 2 units from SKU NF-1M</code>',
  '• <code>Netflix 1 month is out of stock</code>',
  '• <code>Remember: support hours are 10am to 10pm.</code> (customers can be told)',
  '• <code>Temporary: Netflix delivery is delayed until tomorrow 6pm.</code>',
  '• <code>Remove the temporary Netflix delivery notice</code> · <code>/notices</code>',
  '• <code>Note: supplier is late this week</code> (private, never shown to customers)',
  '• <code>Reply to 017XXXXXXXX: your exact message</code> (sent as a human reply)',
  '• <code>/status</code> · <code>cancel</code>',
].join('\n');

if (KIND === 'pair') {
  const p = inp.r || {};
  const why = { invalid_code: 'That code is not valid.', code_already_used: 'That code was already used.', code_expired: 'That code has expired. Create a new one in the dashboard.',
    too_many_attempts: 'Too many attempts. Try again in an hour.', owner_account_required: 'Only the owner account can pair.' };
  text = p.ok ? '✅ Paired with your dashboard owner account. Send /help for what I can do.' : '❌ ' + (why[p.reason] || 'Pairing failed.');
} else if (KIND === 'unauthorized') {
  text = 'This is a private bot.';
} else if (KIND === 'direct') {
  text = esc(inp.reply || inp.text || r.text || '');
  if (!text) text = HELP;
} else if (KIND === 'refused') {
  const s = inp.r || {};
  const why = { duplicate: 'Already handled.', not_allowed_for_role: 'Your role is not allowed to do that.', unknown_action: 'I cannot do that.', not_an_active_admin: 'This Telegram account is not paired.' };
  text = '⛔ ' + (why[s.reason] || 'Not done.');
} else if (KIND === 'info') {
  const a = $('Command').first().json.action || {};
  const d = inp.d || {};
  if (a.type === 'help') text = HELP;
  else if (a.type === 'notice_list') {
    const n = d.notices || [];
    text = n.length ? '<b>Active temporary notices</b>\n' + n.map((x, i) => (i + 1) + '. ' + esc(x.body) + '\n   until ' + esc(x.expires_local) + ' (Dhaka)').join('\n') : 'No active temporary notices.';
  } else {
    text = ['<b>Status</b>', 'AI replies: ' + (d.ai_enabled ? 'on' : 'off') + ' · Sending: ' + (d.sending_enabled ? 'on' : '⛔ stopped'),
      'Open conversations: ' + d.open + ' · waiting for staff: ' + d.waiting, 'Unknown send outcomes: ' + d.unknown_sends + ' · failed events: ' + d.dead_events,
      'Automation heartbeat: ' + (d.automation_ok ? 'ok' : '⚠ stale'), 'Active notices: ' + d.notices_active, dash ? dash + '/operations' : ''].filter(Boolean).join('\n');
  }
} else if (KIND === 'knowledge') {
  const k = inp.r || {};
  text = k.ok ? '✅ Saved as customer-facing knowledge (published).' : '❌ Not saved: ' + esc(k.reason);
} else if (KIND === 'notice') {
  const n = inp.r || {};
  if (inp.ask) text = '⏳ When should this temporary notice expire? Reply e.g. "tomorrow 6pm" or "in 3 hours". (Send "cancel" to drop it.)';
  else text = n.ok ? '✅ Temporary notice saved (v' + n.version + ').\nVisible to customers until <b>' + esc(n.expires_local || formatDhaka(n.expires_at)) + '</b>.' : '❌ Not saved: ' + esc(String(n.reason || '').replace(/_/g, ' '));
} else if (KIND === 'note') {
  const n = inp.r || {};
  text = n.ok ? '✅ Private staff note saved (not visible to customers or the AI).' : '❌ Not saved: ' + esc(n.reason);
} else if (KIND === 'cancel_notice') {
  const c = inp.r || inp;
  text = c.reply ? esc(c.reply) : c.ok ? '✅ Temporary notice removed.' : '❌ No active notice was removed.';
} else if (KIND === 'whatsapp') {
  const w = inp.r || {};
  if (w.ok) text = '📨 Queued for WhatsApp ' + esc(w.phone) + ' as a human reply (AI replies for this chat are stopped).\nI will report when WhatsApp accepts and delivers it; "queued" is not "delivered".' + (w.link ? '\n' + esc(w.link) : '');
  else if (w.reason === 'ambiguous') text = '';
  else {
    const why = { no_whatsapp_conversation: 'No WhatsApp conversation exists with ' + (w.phone || 'that number') + '. I can only reply to customers who have written to the shop.',
      invalid_phone: 'That phone number is not valid.', empty_text: 'The message is empty.', not_allowed_for_role: 'Your role cannot reply to customers.', command_not_open: 'Already handled.' };
    text = '❌ Not sent. ' + esc(why[w.reason] || w.reason);
  }
} else if (KIND === 'stock') {
  const v = inp;
  const f = (o) => (o ? (o.stock_quantity === null || o.stock_quantity === undefined ? '' : o.stock_quantity + ' units, ') + (o.stock_status || '') : '?');
  if (v.reply) text = esc(v.reply);
  else if (v.status === 'succeeded') text = '✅ ' + esc(v.label) + '\nBefore: ' + esc(f(v.previous)) + '\nNow (read back from WooCommerce): ' + esc(f(v.result));
  else if (v.status === 'failed') text = '❌ WooCommerce refused the change for ' + esc(v.label) + ' (HTTP ' + esc(v.put_status) + '). Stock is unchanged.';
  else if (v.status === 'unknown') text = '⚠️ The result for ' + esc(v.label) + ' is UNKNOWN (no confirmation from WooCommerce). Check the product before trying again; nothing will be retried automatically.';
  else if (v.begin_refused) text = '⏳ ' + esc(v.begin_refused === 'another_change_in_progress' ? 'Another stock change for this item is still running.' : 'Already handled.');
  else text = 'Nothing changed.';
} else if (KIND === 'choices') {
  const list = inp.choices || [];
  const lines = list.map((c, i) => (i + 1) + '. ' + esc(c.name || c.title || c.body || c.customer || '') + (c.sku ? ' — SKU ' + esc(c.sku) : '') + (c.product_id ? ' (#' + c.product_id + (c.variation_id ? '/' + c.variation_id : '') + ')' : '') + (c.account ? ' — account ' + esc(c.account) : '') + (c.expires_local ? ' — until ' + esc(c.expires_local) : ''));
  text = 'Several matches. Reply with the number (or "cancel"):\n' + lines.join('\n');
} else if (KIND === 'draft') {
  const d = $('Draft Decision').first().json.r || {};
  const why = { stale_draft: 'The customer wrote again after this draft, so it was NOT sent. A newer draft will follow.',
    draft_approved: 'Already approved.', draft_rejected: 'Already declined.', draft_invalidated: 'This draft is no longer valid (the chat changed or a person took over). Nothing was sent.',
    draft_not_found: 'Draft not found.', not_allowed_for_role: 'Your role cannot approve drafts.', not_authorized: 'Not allowed.', unknown_button: 'Unknown button.' };
  if (d.ok && d.decision === 'approve') text = '✅ Approved. Sending this reply to the customer now (the usual send checks still apply). You get a message here if it cannot be sent.';
  else if (d.ok) text = '🗑 Declined. Nothing was sent to the customer.';
  else text = '❌ ' + esc(why[d.reason] || String(d.reason || 'Not done.'));
} else if (KIND === 'canceled') {
  text = 'Canceled.';
}
return [{ json: { chat_id: r.chat_id || up.r.chat_id, update_id: r.update_id, text: String(text || '').slice(0, 4000) || '…' } }];
