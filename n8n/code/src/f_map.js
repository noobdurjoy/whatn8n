// @variants webhook,catalogue
// WA · F Woo Sync — "Map __VARIANT__"
// Keeps a local reference copy of products and order states for the
// dashboard, metrics and order-status notifications. WooCommerce stays the
// source of truth: the AI tools always read live data, never this cache.
//  webhook:   input { ev } from app.get_webhook_event (REST v3 payload).
//  catalogue: input = Store API product pages (scheduled full refresh).
// Output: { route: 'products', items } | { route: 'order', order } | { route: 'ignore', reason }

const KIND = '__VARIANT__';
function minor(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Math.round(Number(v) * 100);
  return Number.isFinite(n) ? n : null;
}
function fromRest(p) {
  const isVar = p.type === 'variation';
  return {
    product_id: isVar ? p.parent_id : p.id,
    variation_id: isVar ? p.id : 0,
    name: String(p.name || '').slice(0, 300),
    sku: p.sku || null,
    type: p.type || null,
    attributes: Object.fromEntries((p.attributes || []).map((a) => [a.name, a.option !== undefined ? a.option : (a.options || [])])),
    price_minor: minor(p.price),
    currency: null,
    stock_status: p.stock_status || null,
    stock_quantity: Number.isInteger(p.stock_quantity) ? p.stock_quantity : null,
    permalink: p.permalink || null,
    status: p.status || null,
    modified_at: p.date_modified_gmt ? p.date_modified_gmt + 'Z' : null,
  };
}
function fromStore(p) {
  const pr = p.prices || {};
  const unit = Math.pow(10, Number(pr.currency_minor_unit || 0));
  const raw = pr.price_range && pr.price_range.min_amount !== undefined ? pr.price_range.min_amount : pr.price;
  const price = raw === undefined || raw === null || raw === '' ? null : Math.round((Number(raw) / unit) * 100);
  return {
    product_id: p.id, variation_id: 0, name: String(p.name || '').replace(/<[^>]*>/g, '').slice(0, 300), sku: p.sku || null, type: p.type || null,
    attributes: Object.fromEntries((p.attributes || []).map((a) => [a.name, (a.terms || []).map((t) => t.name)])),
    price_minor: Number.isFinite(price) ? price : null, currency: pr.currency_code || null,
    stock_status: p.is_in_stock ? 'instock' : 'outofstock', stock_quantity: null,
    permalink: p.permalink || null, status: 'publish', modified_at: null,
  };
}

if (KIND === 'catalogue') {
  const items = [];
  for (const it of $input.all()) {
    const j = it.json;
    const list = Array.isArray(j) ? j : Array.isArray(j.body) ? j.body : (j && j.id ? [j] : []);
    for (const p of list) if (p && p.id) items.push(fromStore(p));
  }
  if (!items.length) return [{ json: { route: 'ignore', reason: 'no_products' } }];
  return [{ json: { route: 'products', items: items } }];
}

const ev = ($input.first().json || {}).ev;
if (!ev || ev.source !== 'woocommerce') return [{ json: { route: 'ignore', reason: 'event_not_found' } }];
const topic = String(ev.event_type || '');
const p = ev.payload || {};
if (/^product\.(created|updated|restored)$/.test(topic) && p.id) return [{ json: { route: 'products', items: [fromRest(p)] } }];
if (topic === 'product.deleted' && p.id) return [{ json: { route: 'products', items: [Object.assign(fromRest(p), { status: 'trash' })] } }];
if (/^order\.(created|updated|restored)$/.test(topic) && p.id && p.status) {
  // Only the fields upsert_woo_order_ref reads; contact details are hashed there.
  return [{ json: { route: 'order', order: {
    id: p.id, status: p.status, currency: p.currency, total: p.total, customer_id: p.customer_id, payment_method: p.payment_method,
    date_paid_gmt: p.date_paid_gmt, date_modified_gmt: p.date_modified_gmt,
    billing: { phone: p.billing && p.billing.phone, email: p.billing && p.billing.email },
  } } }];
}
return [{ json: { route: 'ignore', reason: 'topic_' + topic } }];
