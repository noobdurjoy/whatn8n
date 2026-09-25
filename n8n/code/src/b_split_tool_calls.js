// @variants R1,R2
// WA · B AI Reply — "__VARIANT__ Split Tool Calls"
// One item per tool call for the shared tool branch (a loop, one call at a time;
// "Tool Return" sends each result back to this round's loop via `round`). The allowlist and
// argument checks happen again inside the Tool Runner; here we only cap the
// number of image analyses per turn (settings.vision.max_images_per_turn).

const state = $input.first().json.state;
let imagesLeft = Math.max(0, (state.max_images || 3) - (state.images_analysed || 0));
const out = [];
for (const c of state.pending_calls || []) {
  let blocked = null;
  if (c.name === 'analyze_image') {
    if (!state.vision_enabled) blocked = 'image_analysis_disabled';
    else if (imagesLeft <= 0) blocked = 'image_limit_reached';
    else imagesLeft--;
  }
  out.push({ json: { round: '__VARIANT__', job_id: state.job_id, conversation_id: state.conversation_id, customer_language: state.customer_language, call_id: c.id, name: c.name, arguments: c.arguments, blocked: blocked } });
}
return out;
