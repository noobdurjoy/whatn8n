// Configurable escalation rules. Dependency-free; inlined into n8n Code nodes.
// Inputs are trusted values from the database (rules, counters) plus the
// validated classifier/model intents for this turn. The model never decides
// whether a rule is enabled.

/**
 * @param {{ rules: any, intents?: string[], decision?: string, handoffReason?: string | null, state?: any, handoffPhrase?: string | null }} input
 * @returns {{ handoff: boolean, reason: string | null, suppressed?: string }}
 */
export function evaluateEscalation({ rules, intents, decision, handoffReason, state, handoffPhrase }) {
  const r = rules || {};
  const on = (k) => Boolean(r[k] && r[k].enabled);
  const has = (i) => Array.isArray(intents) && intents.includes(i);
  const st = state || {};

  if (on('customer_requests_human') && (handoffPhrase === 'explicit' || has('human_request'))) {
    return { handoff: true, reason: 'customer_requested_human' };
  }
  if (on('refund_request') && (has('refund_request') || has('cancellation'))) {
    return { handoff: true, reason: 'refund_request' };
  }
  if (on('unresolved_complaint') && has('complaint')
      && (st.complaint_turns_24h || 0) + 1 >= ((r.unresolved_complaint && r.unresolved_complaint.complaint_turns) || 2)) {
    return { handoff: true, reason: 'unresolved_complaint' };
  }
  if (on('repeated_failed_answers')
      && (st.ai_unresolved_turns_24h || 0) >= ((r.repeated_failed_answers && r.repeated_failed_answers.unresolved_turns) || 2)) {
    return { handoff: true, reason: 'repeated_failed_answers' };
  }
  if (on('purchase_intent') && has('purchase_intent')) {
    return { handoff: true, reason: 'purchase_intent' };
  }
  if (decision === 'handoff') {
    // The model asked for a person. Honour it, except that an
    // "unavailable information" handoff can be switched off by the owner, in
    // which case the reply workflow asks the model for a holding answer.
    if (handoffReason === 'unavailable_information' && !on('unavailable_information')) {
      return { handoff: false, reason: null, suppressed: 'unavailable_information' };
    }
    return { handoff: true, reason: handoffReason || 'other' };
  }
  return { handoff: false, reason: null };
}

// Business hours check in the shop's timezone. hours.days: { mon: ['10:00','22:00'], ... }
export function isWithinBusinessHours(hours, now) {
  if (!hours || !hours.days) return true;
  const d = now || new Date();
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: hours.timezone || 'UTC', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  const day = String(parts.weekday || '').toLowerCase().slice(0, 3);
  const span = hours.days[day];
  if (!span) return false;
  const cur = `${parts.hour}:${parts.minute}`;
  return cur >= span[0] && cur < span[1];
}
