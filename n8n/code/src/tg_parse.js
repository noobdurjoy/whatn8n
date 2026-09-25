// Infinity Digital Shop — WhatsApp AI Support · "Parse Command"
// Explicit command forms are parsed by rules; everything else goes to the
// model (as an authorized admin's text only). The result is validated again
// before the database checks authority and state.
// @include shared/admin-commands.js: parseCommand

const r = ($input.first().json || {}).r || {};
const res = parseCommand(r.text, r.pending);
const base = { update_id: r.update_id, chat_id: r.chat_id, admin_id: r.admin_id, text: r.text, pending: r.pending || null };
if (res.needs_model) return [{ json: Object.assign(base, { route: 'model', followup: res.followup || null }) }];
const action = res.action;
if (action.type === 'clarify') return [{ json: Object.assign(base, { route: 'reply', reply: action.question }) }];
let parent = res.parent_id || null;
if (action.type === 'cancel') {
  if (!r.pending) return [{ json: Object.assign(base, { route: 'reply', reply: 'Nothing to cancel.' }) }];
  parent = r.pending.command_id;
}
return [{ json: Object.assign(base, { route: 'start', action: action, parsed_by: res.parsed_by || 'rules', parent_id: parent }) }];
