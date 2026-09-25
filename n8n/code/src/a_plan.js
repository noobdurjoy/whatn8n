// Infinity Digital Shop — WhatsApp AI Support · "Plan Route"
// Input: one row from "Claim Event" { c } where c = app.claim_event_route().
// The backend verified the signature, stored the event, resolved the customer
// identity, saved the message and ran human-request detection in one
// transaction. This branch claims the stored event ONCE (a re-delivered event
// stops here) and routes on the stored decision plus the conversation's
// CURRENT mode from the database, never on the request body.

const c = ($input.first().json || {}).c || {};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!c.ok) return [{ json: { valid: false, duplicate: Boolean(c.duplicate), reason: c.reason || 'not_claimed' } }];
const r = c.route || {};
const conv = c.conversation || {};
if (!r.conversation_id || !uuid.test(r.conversation_id) || conv.id !== r.conversation_id) {
  return [{ json: { valid: false, duplicate: false, reason: r.action === 'none' ? 'nothing_to_do:' + (r.reason || '') : 'invalid_route' } }];
}
const media = (Array.isArray(r.attachment_ids) ? r.attachment_ids : []).filter((x) => uuid.test(String(x))).slice(0, 10);
const isMessage = r.action === 'customer_message';
const msg = c.message || {};
const genuine = isMessage && msg.saved === true && msg.direction === 'inbound' && !msg.is_historical;
// Human requested: detected by the backend when the message was saved; the
// takeover (HUMAN mode, drafts invalidated, pending AI sends canceled) is
// already committed. Mode check uses the current mode, not the stored one.
const humanRequested = Boolean(r.handoff);
const aiMode = conv.mode === 'AUTO' || conv.mode === 'COPILOT';
return [{ json: {
  valid: true,
  duplicate: false,
  event_id: c.event_id || null,
  action: r.action,
  conversation_id: r.conversation_id,
  mode: conv.mode || null,
  media: media,
  has_media: media.length > 0,
  human_requested: humanRequested,
  // AI reply: genuine customer messages in AUTO/COPILOT without a handoff.
  // start_ai_job re-checks mode, holds, the AI switch and the revision.
  ai: genuine && !humanRequested && aiMode && !conv.automation_hold,
  ai_input: genuine ? { conversation_id: r.conversation_id, message_id: r.message_id, revision: r.revision, possible_handoff: Boolean(r.possible_handoff) } : null,
  // A handoff queued the one fixed acknowledgement: dispatch it now (the
  // dispatcher still applies the emergency stop and every other check).
  dispatch: isMessage && humanRequested,
  // Handoff notifications come from the database (mode change trigger);
  // this branch only queues explicit staff alerts.
  notify: r.action === 'notify_staff',
  notify_input: { conversation_id: r.conversation_id, reason: r.action === 'notify_staff' ? r.reason : 'customer_requested_human', detail: r.detail || null },
} }];
