// WA · D Notifications — "Format Notification"
// Staff alerts (handoffs, failed or unknown sends, emergency stop, holds,
// connection problems). They carry facts and a dashboard link only, never
// message content, attachments or customer contact details.
// Input: { f, notify, dash } from "Load Facts"; the request from "Notify Request".

const req = $('Notify Request').first().json || {};
const row = $input.first().json || {};
const notify = row.notify || {};
const f = row.f || {};
const alert = req.alert || null;
const reason = String(req.reason || (alert && alert.kind) || 'notice');
const category = reason.startsWith('ai_handoff') || reason === 'customer_requested_human' ? 'handoff'
  : reason === 'automation_hold' || reason === 'external_human_reply' ? 'hold'
  : reason;
if (!notify.telegram_enabled || !/^-?\d{3,20}$/.test(String(notify.telegram_chat_id || ''))) return [];
if (Array.isArray(notify.notify_on) && notify.notify_on.indexOf(category) < 0 && category !== 'hold') return [];

const LABEL = {
  customer_requested_human: 'Customer asked for a person',
  external_human_reply: 'Someone replied outside the dashboard (AI paused)',
  automation_hold: 'Outgoing message of unknown origin (AI paused)',
  delivery_failed: 'A message was not delivered',
  send_failed: 'A message could not be sent',
  send_unknown: 'A send result is unknown (check before retrying)',
  emergency_stop: 'Emergency stop is active',
  connection_down: 'WhatsApp connection problem',
  response_overdue: 'Customer waiting past the response target',
};
const title = LABEL[reason] || (reason.startsWith('ai_handoff') ? 'AI handed the chat to staff (' + reason.slice(11).replace(/_/g, ' ') + ')' : (alert && alert.message) || reason);
const conv = f.conversation_id || (alert && alert.details && alert.details.conversation_id) || req.conversation_id || null;
const dash = String(row.dash || '').replace(/\/+$/, '');
const lines = ['WhatsApp support: ' + title];
if (f.customer) lines.push('Customer: ' + String(f.customer).slice(0, 60));
if (f.mode) lines.push('Mode: ' + f.mode + (f.assigned_to ? ' · assigned to ' + f.assigned_to : ' · unassigned'));
if (dash && conv) lines.push(dash + '/?c=' + conv);
// Telegram parses HTML: escape everything we did not write ourselves.
const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
return [{ json: { chat_id: String(notify.telegram_chat_id), text: esc(lines.join('\n').slice(0, 1000)), alert_id: alert ? alert.id : null } }];
