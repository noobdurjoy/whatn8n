// WA · B AI Reply — "After Submit"
// Input: { r, conversation_id, handoff_reason } from "Submit Result"
// (app.submit_ai_result plus the job's conversation). Queued replies and the handoff
// acknowledgement go to the central dispatcher (which re-checks everything
// under the conversation lock before sending); handoffs notify staff.

const row = $input.first().json || {};
const r = row.r || {};
const out = [];
if (r.result === 'queued' && r.outbound_id) out.push({ json: { kind: 'dispatch', outbound_id: r.outbound_id } });
if (r.result === 'handoff') {
  const t = r.takeover || {};
  if (t.ack_outbound_id) out.push({ json: { kind: 'dispatch', outbound_id: t.ack_outbound_id } });
  out.push({ json: { kind: 'notify', conversation_id: row.conversation_id, reason: 'ai_handoff:' + String(row.handoff_reason || 'other') } });
}
if (r.result === 'drafted') out.push({ json: { kind: 'none', draft_id: r.draft_id } });
return out.length ? out : [{ json: { kind: 'none', result: r.result || null, reason: r.reason || null } }];
