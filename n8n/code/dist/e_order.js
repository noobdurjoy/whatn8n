// WA · E WooCommerce Tools — "Format Order"
// Private order data is shown only when the order is linked to THIS customer:
// either already verified, or the order's billing phone equals the WhatsApp
// number the customer is writing from. An order number alone is never
// enough, and a failed check does not reveal whether the order exists.
// Payment state comes from WooCommerce only (never from customer claims or
// screenshots). Billing address, email and phone are never returned.
// Output: { ok, content, ref, allowed_urls, price_data, verified_paid, error, propose }

const req = $('Woo Tool Request').first().json;
const o = $('Get Order').first().json || {};
const link = ($input.first().json || {}).link || {};
const orderId = req.args.order_id;
const found = o && o.id === orderId && !o.error;

if (!found || !link.linked) {
  return [{ json: { ok: true, propose: false, ref: null, allowed_urls: [], price_data: false, verified_paid: false, error: null,
    content: { verified: false, order_id: orderId,
      note: 'This order could not be verified for this WhatsApp number. Do not say whether the order exists or share any detail. Offer to connect the customer with a person who can verify ownership.' } } }];
}

const paidStatuses = ['processing', 'completed'];
const verifiedPaid = paidStatuses.indexOf(o.status) >= 0 && Boolean(o.date_paid || o.date_paid_gmt);
const dec = (s) => String(s || '').replace(/<[^>]*>/g, '').replace(/&amp;|&#038;/g, '&').slice(0, 120);
const facts = {
  verified: true,
  order_id: o.id,
  status: o.status,
  created_at: o.date_created_gmt || o.date_created || null,
  paid_at: o.date_paid_gmt || o.date_paid || null,
  payment_confirmed_by_shop: verifiedPaid,
  payment_method: dec(o.payment_method_title),
  total: o.total, currency: o.currency,
  items: (o.line_items || []).slice(0, 10).map((li) => ({ name: dec(li.name), quantity: li.quantity, total: li.total })),
};

if (req.name === 'verify_order_access') {
  return [{ json: { ok: true, propose: false, ref: 'order:' + o.id, allowed_urls: [], price_data: false, verified_paid: false, error: null,
    content: { verified: true, order_id: o.id, note: 'Ownership verified. Call get_order_status for details.' } } }];
}
if (req.name === 'propose_order_change') {
  return [{ json: { ok: true, propose: true, ref: 'order:' + o.id, allowed_urls: [], price_data: false, verified_paid: false, error: null,
    operation: {
      // One pending request per job, type and order (retries do not duplicate it).
      operation_id: 'ai:' + req.job_id + ':' + req.args.type + ':' + o.id,
      type: req.args.type, order_id: o.id,
      payload: { details: String(req.args.details || '').slice(0, 1000), requested_via: 'whatsapp_ai' },
      quote: { order_status: o.status, total: o.total, currency: o.currency },
    },
    content: facts } }];
}
return [{ json: { ok: true, propose: false, ref: 'order:' + o.id, allowed_urls: [], price_data: true, verified_paid: verifiedPaid, error: null,
  content: Object.assign(facts, { note: verifiedPaid ? 'Payment is confirmed by the shop.' : 'Payment is NOT confirmed by the shop. Do not say it is paid.' }) } }];
