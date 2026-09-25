// Infinity Digital Shop — WhatsApp AI Support · "Notification results"
// items: one Telegram message per claimed notification (business facts and
// dashboard links only). results: pairs each send result with its row so
// the outbox records sent/failed. A failed Telegram send never repeats the
// customer action behind it — only the notification is retried (max 3).
const KIND = 'results';
if (KIND === 'items') {
  const list = ($input.first().json || {}).r || [];
  return list.map((n) => ({ json: { notification_id: n.notification_id, chat_id: String(n.chat_id), text: String(n.text || '').slice(0, 4000), buttons: Array.isArray(n.buttons) ? n.buttons : null } }));
}
const out = [];
const rows = $input.all();
for (let i = 0; i < rows.length; i++) {
  const src = $('Notification Items').itemMatching(i).json;
  const j = rows[i].json || {};
  out.push({ json: { id: src.notification_id, ok: !j.error && j.ok !== false, error: j.error ? String(j.error.message || j.error).slice(0, 200) : null } });
}
return out;
