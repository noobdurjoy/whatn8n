// WA · F Woo Sync — "Order Update Messages"
// Input: { r, followups } from "Upsert Order" (app.upsert_woo_order_ref and the
// followups setting): r = { previous_status, status, linked }.
// When the owner enabled order-update notifications, a short status message
// is queued for the customer's verified conversation. It goes through the
// central outbox, so the window, emergency stop and HUMAN-mode rules apply.

const row = $input.first().json || {};
const r = row.r || {};
const enabled = Boolean((row.followups || {}).order_update_notifications_enabled);
const order = $('Map webhook').first().json.order;
const TEXT = {
  processing: 'Update on order #{id}: payment received and the order is being processed. / অর্ডার #{id}: পেমেন্ট পাওয়া গেছে, অর্ডারটি প্রসেস করা হচ্ছে।',
  completed: 'Update on order #{id}: the order is completed. / অর্ডার #{id}: অর্ডারটি সম্পন্ন হয়েছে।',
  cancelled: 'Update on order #{id}: the order was cancelled. Reply here if you have questions. / অর্ডার #{id}: অর্ডারটি বাতিল করা হয়েছে।',
  refunded: 'Update on order #{id}: the order was refunded. / অর্ডার #{id}: অর্ডারের টাকা ফেরত দেওয়া হয়েছে।',
};
if (!enabled || !r.status || r.previous_status === r.status || !TEXT[r.status]) return [];
return (r.linked || []).map((l) => ({ json: {
  conversation_id: l.conversation_id,
  body: TEXT[r.status].split('{id}').join(String(order.id)),
  dedupe: 'order:' + order.id + ':' + r.status,
} }));
