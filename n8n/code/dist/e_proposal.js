// WA · E WooCommerce Tools — "Format Proposal"
// The model can only PROPOSE a refund, cancellation, address change, renewal
// or access fix. The request waits for staff approval in the dashboard;
// nothing is executed here.

const prev = $('Format Order').first().json;
const r = ($input.first().json || {}).result || {};
if (!r.ok) {
  return [{ json: { ok: false, ref: prev.ref, allowed_urls: [], price_data: false, verified_paid: false, error: r.reason || 'proposal_failed',
    content: { error: r.reason || 'proposal_failed', note: 'The request could not be recorded. Offer to connect the customer with a person.' } } }];
}
return [{ json: { ok: true, ref: prev.ref, allowed_urls: [], price_data: false, verified_paid: false, error: null,
  content: { request_recorded: true, status: r.status, requires_staff_approval: r.requires_staff_approval !== false,
    note: 'Tell the customer the request was passed to the team for review. Do not promise the outcome, a refund amount or a time.' } } }];
