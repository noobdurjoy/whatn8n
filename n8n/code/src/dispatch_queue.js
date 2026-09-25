// Infinity Digital Shop — WhatsApp AI Support · "Dispatch Queue"
// Every sending route enters the ONE dispatch branch here: the dispatch
// webhook (staff replies, approved drafts, retries), AI replies and handoff
// acknowledgements, the router, and the 15-second recovery sweep. Output: one
// item per outbound id; "Dispatch Loop" then claims and sends them one at a
// time, and app.claim_outbound re-checks mode, mode version, message
// freshness, the 24-hour window and the global controls for each.

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const seen = {};
const out = [];
for (const it of $input.all()) {
  const j = it.json || {};
  const b = j.body && typeof j.body === 'object' ? j.body : j;
  const ids = [b.outbound_id].concat(Array.isArray(b.ack_outbound_ids) ? b.ack_outbound_ids : []);
  for (const id of ids) {
    if (typeof id === 'string' && uuid.test(id) && !seen[id]) { seen[id] = true; out.push({ json: { outbound_id: id } }); }
  }
}
return out;
