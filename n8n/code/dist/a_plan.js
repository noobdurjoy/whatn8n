// WA · A Router — "Plan Route"
// Input: the backend's call { event_id, route } (the backend already verified
// the Zernio signature, stored the event and applied it to the database).
// Decides which workflows run; every one of them re-checks state in the
// database, so a repeated or late call is harmless.

const b = ($input.first().json || {}).body || {};
const r = b.route || {};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!r.conversation_id || !uuid.test(r.conversation_id)) return [{ json: { valid: false, reason: 'invalid_route' } }];
const media = (Array.isArray(r.attachment_ids) ? r.attachment_ids : []).filter((x) => uuid.test(String(x))).slice(0, 10);
const isMessage = r.action === 'customer_message';
return [{ json: {
  valid: true,
  event_id: b.event_id || null,
  action: r.action,
  conversation_id: r.conversation_id,
  media: media,
  has_media: media.length > 0,
  // AI reply: only for customer messages in AUTO/COPILOT without a handoff.
  // start_ai_job re-checks mode, holds, the AI switch and the revision.
  ai: isMessage && !r.handoff && (r.mode === 'AUTO' || r.mode === 'COPILOT'),
  ai_input: isMessage ? { conversation_id: r.conversation_id, message_id: r.message_id, revision: r.revision, possible_handoff: Boolean(r.possible_handoff) } : null,
  // A handoff queued the one fixed acknowledgement: dispatch it now.
  dispatch: isMessage && Boolean(r.handoff),
  notify: (isMessage && Boolean(r.handoff)) || r.action === 'notify_staff',
  notify_input: { conversation_id: r.conversation_id, reason: r.action === 'notify_staff' ? r.reason : 'customer_requested_human', detail: r.detail || null },
} }];
