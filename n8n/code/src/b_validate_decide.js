// WA · B AI Reply — "Validate & Decide"
// Server-side validation of the final model output, plus the owner's
// escalation rules. The model never decides permissions: an invalid output
// gets ONE repair attempt; if it is still invalid the job hands off (AUTO)
// or fails (drafts), and nothing unvalidated is ever sent.
// @include shared/validate.js: parseModelJson, validateReply
// @include shared/escalation.js: evaluateEscalation

const state = JSON.parse(JSON.stringify($input.first().json.state));
const staffAssist = state.kind !== 'reply';
const ctx = {
  mode: state.mode,
  staff_assist: staffAssist,
  tool_refs: state.refs.tool,
  knowledge_refs: state.refs.knowledge,
  image_refs: state.refs.image,
  price_tool_used: state.price_tool_used,
  verified_paid_order: state.verified_paid_order,
  allowed_urls: state.allowed_urls,
  customer_language: state.customer_language,
};

let parsed = state.failed ? { ok: false, error: state.failure } : parseModelJson(state.final_content);
let v = parsed.ok ? validateReply(parsed.value, ctx) : { ok: false, errors: [parsed.error || 'no_output'] };

if (!v.ok && !state.failed && !state.repaired) {
  // One repair attempt with the validator's findings.
  state.repaired = true;
  state.validation_errors_first = v.errors;
  return [{ json: { next: 'repair', state: state } }];
}

let decision;
let text = '';
let reason = null;
let intents = [];
let resolved = null;
let references = [];
if (v.ok) {
  decision = v.value.decision;
  text = v.value.reply_text;
  reason = v.value.handoff_reason;
  intents = v.value.intents;
  resolved = v.value.resolved;
  references = v.value.references;
  const esc = evaluateEscalation({ rules: state.escalation.rules, intents: intents, decision: decision, handoffReason: reason, state: state.escalation.state, handoffPhrase: state.escalation.handoff_phrase });
  if (esc.handoff && !staffAssist) {
    decision = 'handoff';
    reason = esc.reason;
  } else if (esc.suppressed && decision === 'handoff') {
    // Owner disabled this handoff type: fall back to a holding reply if the
    // model wrote one, otherwise hand off anyway (never leave it unanswered).
    decision = text ? 'reply' : 'handoff';
  }
} else {
  // Still invalid after repair (or the model call failed).
  decision = staffAssist || state.mode !== 'AUTO' ? 'fail' : 'handoff';
  reason = 'other';
}

return [{ json: {
  next: decision === 'fail' ? 'fail' : 'submit',
  job_id: state.job_id,
  conversation_id: state.conversation_id,
  submit: {
    job_id: state.job_id,
    decision: decision === 'fail' ? 'no_reply' : decision,
    reply_text: text,
    handoff_reason: reason,
    references: references,
    result: {
      intents: intents,
      resolved: resolved,
      language: state.customer_language,
      validation_errors: v.ok ? (state.validation_errors_first || null) : v.errors,
      repaired: state.repaired,
      rounds: state.final_round || null,
      tools_used: state.refs,
      images_analysed: state.images_analysed || 0,
    },
  },
  failure: decision === 'fail' ? ('invalid_output: ' + (v.errors || []).join(',')).slice(0, 400) : null,
  usage: state.usage,
} }];
