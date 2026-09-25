// Infinity Digital Shop — WhatsApp AI Support · "Pick Notice"
// Which active notice to remove: a number from the earlier list, the only
// match, or a list to choose from.
const a = $('Command').first().json.action || {};
const pending = $('Accept Update').first().json.r.pending;
const found = ($input.first().json || {}).n || [];
if (a.choice) {
  const t = pending && Array.isArray(pending.choices) ? pending.choices[a.choice - 1] : null;
  if (!t) return [{ json: { route: 'reply', reply: 'There is no option ' + a.choice + '.' } }];
  return [{ json: { route: 'cancel', notice_key: t.notice_key } }];
}
if (!found.length) return [{ json: { route: 'reply', reply: 'No active temporary notice matches "' + (a.match || '') + '". Send /notices to see them.' } }];
if (found.length === 1) return [{ json: { route: 'cancel', notice_key: found[0].notice_key } }];
return [{ json: { route: 'choices', choices: found.slice(0, 10).map((n) => ({ notice_key: n.notice_key, body: n.body, expires_local: n.expires_local })) } }];
