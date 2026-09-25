// @variants R1,R2,R3,R4
// WA · B AI Reply — "__VARIANT__ Parse Response"
// Input: the OpenRouter response for this round. Reads the state that built
// the request from the node that ran just before the model call, records
// usage (missing usage stays null = unavailable), and decides: run tools,
// or go to validation. Streaming is not used: the whole response is buffered.
// @include shared/validate.js

const ROUND = '__VARIANT__';
const PREV = { R1: 'Prepare Turn', R2: 'R1 Collect Tool Results', R3: 'R2 Collect Tool Results', R4: 'Build Repair Request' }[ROUND];
const state = JSON.parse(JSON.stringify($(PREV).first().json.state));
const resp = $input.first().json || {};
const latency = Date.now() - (state.request_started_at || Date.now());

const httpError = resp.error ? (typeof resp.error === 'object' ? (resp.error.message || JSON.stringify(resp.error)) : String(resp.error)) : null;
const usage = extractUsage(resp, state.model, latency);
usage.purpose = state.sandbox ? 'sandbox' : (ROUND === 'R4' ? 'reply_repair' : 'reply');
usage.outcome = httpError ? 'error' : 'ok';
if (httpError) usage.error = httpError.slice(0, 500);
state.usage.push(usage);

const choice = resp.choices && resp.choices[0];
if (httpError || !choice) {
  state.failed = true;
  state.failure = httpError || 'no_choices';
  return [{ json: { next: 'fail', state: state } }];
}
if (choice.finish_reason === 'length') {
  // Truncated output is discarded, never used partially.
  state.usage[state.usage.length - 1].outcome = 'incomplete';
}

const msg = choice.message || {};
const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
if (calls.length && (ROUND === 'R1' || ROUND === 'R2')) {
  state.messages.push({ role: 'assistant', content: msg.content || null, tool_calls: calls });
  state.pending_calls = calls.slice(0, 6).map((c) => ({ id: c.id, name: c.function && c.function.name, arguments: (c.function && c.function.arguments) || '{}' }));
  state.round = ROUND === 'R1' ? 2 : 3;
  return [{ json: { next: 'tools', state: state } }];
}
state.final_content = choice.finish_reason === 'length' ? null : (msg.content || null);
state.final_round = ROUND;
return [{ json: { next: 'validate', state: state } }];
