// Infinity Digital Shop — WhatsApp AI Support · "Check Proposed Action"
// Deterministic validation of the model's proposal (types, integers, exact
// reply text, expiry in the future). Anything doubtful becomes a question.
// @include shared/admin-commands.js: validateAction
// @include shared/validate.js: parseModelJson, extractUsage

const j = $('Build Command Request').first().json;
const resp = $input.first().json || {};
const usage = extractUsage(resp, j.request.model, null);
usage.purpose = 'admin_command';
usage.outcome = resp.error ? 'error' : 'ok';
const base = { update_id: j.update_id, chat_id: j.chat_id, admin_id: j.admin_id, text: j.text, pending: j.pending, usage: usage };
const choice = resp.choices && resp.choices[0];
const parsed = choice && choice.finish_reason !== 'length' ? parseModelJson(choice.message && choice.message.content) : { ok: false };
if (!parsed.ok) return [{ json: Object.assign(base, { route: 'reply', reply: 'I could not process that right now. Try an explicit command (send /help).' }) }];
const raw = parsed.value;
if (j.followup && raw.type === 'notice_temporary') raw.body = j.followup.action.body;
const v = validateAction(raw, j.text);
if (!v.ok) return [{ json: Object.assign(base, { route: 'reply', reply: v.clarify }) }];
return [{ json: Object.assign(base, { route: 'start', action: v.action, parsed_by: j.followup ? 'followup' : 'model', parent_id: j.followup ? j.followup.command_id : null }) }];
