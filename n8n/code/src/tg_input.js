// Infinity Digital Shop — WhatsApp AI Support · "Telegram Update Input"
// Reduces the Telegram update to the few fields the database needs to
// deduplicate and authorize it. Nothing else from the update is used, and
// nothing reaches a model before "Accept Update" has authorized the sender.

const u = $input.first().json || {};
const m = u.message || u.edited_message || null;
const cb = u.callback_query || null;
const msg = m || (cb && cb.message) || {};
const from = (m && m.from) || (cb && cb.from) || {};
const chat = msg.chat || {};
return [{ json: { p: {
  update_id: typeof u.update_id === 'number' ? u.update_id : null,
  kind: m ? (u.edited_message ? 'edited_message' : 'message') : cb ? 'callback_query' : 'other',
  user_id: typeof from.id === 'number' ? from.id : null,
  chat_id: typeof chat.id === 'number' ? chat.id : null,
  chat_type: chat.type || null,
  // Edited messages are never executed again as commands.
  text: m && !u.edited_message && typeof m.text === 'string' ? m.text : '',
  forwarded: Boolean(m && (m.forward_origin || m.forward_from || m.forward_from_chat || m.forward_sender_name || m.forward_date)),
} } }];
