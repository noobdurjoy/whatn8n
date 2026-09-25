// WA · B AI Reply — "R3 Parse Response"
// Input: the OpenRouter response for this round. Reads the state that built
// the request from the node that ran just before the model call, records
// usage (missing usage stays null = unavailable), and decides: run tools,
// or go to validation. Streaming is not used: the whole response is buffered.
// ---- begin shared/validate.js (parseModelJson, extractUsage) (inlined by n8n/build.mjs; edit the shared file, not this copy) ----
function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

// Pull the first JSON object out of a model message. Accepts a bare object or
// one wrapped in a ```json fence; anything else is a failure, not a guess.
function parseModelJson(content) {
  if (isPlainObject(content)) return { ok: true, value: content };
  if (typeof content !== 'string') return { ok: false, error: 'no_content' };
  let s = content.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1].trim();
  if (!s.startsWith('{') || !s.endsWith('}')) return { ok: false, error: 'not_a_json_object' };
  try {
    const v = JSON.parse(s);
    return isPlainObject(v) ? { ok: true, value: v } : { ok: false, error: 'not_a_json_object' };
  } catch (e) {
    return { ok: false, error: 'invalid_json' };
  }
}

// Reduce OpenRouter's response metadata to what we store. Missing usage stays
// null ("unavailable"), never 0.
function extractUsage(resp, model, latencyMs) {
  const u = resp && resp.usage;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    model: (resp && resp.model) || model,
    provider: (resp && resp.provider) || null,
    request_id: (resp && resp.id) || null,
    latency_ms: typeof latencyMs === 'number' ? Math.round(latencyMs) : null,
    prompt_tokens: u ? num(u.prompt_tokens) : null,
    completion_tokens: u ? num(u.completion_tokens) : null,
    reasoning_tokens: u && u.completion_tokens_details ? num(u.completion_tokens_details.reasoning_tokens) : null,
    cost_usd: u ? num(u.cost) : null,
  };
}
// ---- end shared/validate.js ----

const ROUND = 'R3';
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
