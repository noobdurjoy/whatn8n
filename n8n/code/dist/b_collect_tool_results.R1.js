// WA · B AI Reply — "R1 Collect Tool Results"
// Appends tool results to the conversation for the next model call and
// tracks which references, prices, links and image analyses are verified in
// this turn (used later by the output validator).

const ROUND = 'R1';
const state = JSON.parse(JSON.stringify($(ROUND + ' Parse Response').first().json.state));
const results = $input.all().map((i) => i.json);
const byId = {};
for (const r of results) byId[r.call_id] = r;

for (const c of state.pending_calls || []) {
  const r = byId[c.id] || { ok: false, content: { error: 'tool_result_missing' } };
  const content = JSON.stringify(r.content === undefined ? { ok: r.ok } : r.content).slice(0, 6000);
  state.messages.push({ role: 'tool', tool_call_id: c.id, content: content });
  const refs = r.refs || {};
  for (const k of ['knowledge', 'tool', 'image']) {
    for (const id of (refs[k] || [])) if (state.refs[k].indexOf(id) < 0) state.refs[k].push(id);
  }
  for (const u of (r.allowed_urls || [])) if (state.allowed_urls.indexOf(u) < 0) state.allowed_urls.push(u);
  if (r.price_data) state.price_tool_used = true;
  if (r.verified_paid) state.verified_paid_order = true;
  if (r.name === 'analyze_image' && r.attempted) state.images_analysed = (state.images_analysed || 0) + 1;
  for (const u of (r.usage || [])) state.usage.push(u);
}
delete state.pending_calls;

// The third round may not call tools again.
state.request = {
  model: state.model,
  messages: state.messages,
  tools: state.tools,
  tool_choice: ROUND === 'R2' ? 'none' : 'auto',
  response_format: { type: 'json_schema', json_schema: state.schema },
  reasoning: { effort: state.reasoning_effort, exclude: true },
  max_tokens: state.max_tokens,
  temperature: 0.3,
  provider: { require_parameters: true },
};
state.request_started_at = Date.now();
return [{ json: { state: state } }];
