// WA · B AI Reply — "Build Repair Request"
// Sends the validator's findings back once and asks for a corrected object.

const state = JSON.parse(JSON.stringify($input.first().json.state));
if (state.final_content) state.messages.push({ role: 'assistant', content: String(state.final_content).slice(0, 4000) });
state.messages.push({ role: 'system', content: 'Your previous output was rejected by the backend validator for: ' +
  (state.validation_errors_first || []).join(', ') +
  '. Return a corrected JSON object. Do not state prices, payment status, links or image contents that no tool returned in this turn; if you cannot answer with verified data, ask one focused question or set decision to "handoff".' });
state.request = {
  model: state.model,
  messages: state.messages,
  tools: state.tools,
  tool_choice: 'none',
  response_format: { type: 'json_schema', json_schema: state.schema },
  reasoning: { effort: state.reasoning_effort, exclude: true },
  max_tokens: state.max_tokens,
  temperature: 0.2,
  provider: { require_parameters: true },
};
state.request_started_at = Date.now();
return [{ json: { state: state } }];
