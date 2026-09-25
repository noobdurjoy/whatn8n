// Infinity Digital Shop — WhatsApp AI Support · "Stock Lookup Plan"
// Decides how to find the exact product/variation: a choice from the list
// the owner was shown, a product id, a SKU, or a name search.
const s = $('Command').first().json;
const a = s.action || {};
const pending = $('Accept Update').first().json.r.pending;
if (a.choice) {
  const list = (pending && Array.isArray(pending.choices)) ? pending.choices : [];
  const t = list[a.choice - 1];
  if (!t) return [{ json: { mode: 'reply', reply: 'There is no option ' + a.choice + '. Send a number from the list, or "cancel".' } }];
  return [{ json: { mode: 'target', target: t } }];
}
if (a.product_id) return [{ json: { mode: 'id', product_id: a.product_id, variation_id: a.variation_id || null } }];
if (a.sku) return [{ json: { mode: 'sku', sku: a.sku } }];
return [{ json: { mode: 'search', query: a.query } }];
