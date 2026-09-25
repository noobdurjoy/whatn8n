// Infinity Digital Shop — WhatsApp AI Support · "Plan Stock Write"
// Reads the product/variation as WooCommerce reports it right now and plans
// the exact fields to write (never inventing a quantity).
// ---- begin shared/admin-commands.js (planStockWrite) (inlined by n8n/build.mjs; edit the shared file, not this copy) ----
/**
 * Decides the exact WooCommerce fields to write for a stock command, given the
 * product/variation as read from WooCommerce just before. Returns
 * { write: { ...fields } } or { clarify } — never invents a quantity.
 * @param {any} action
 * @param {{ manage_stock: any, stock_quantity: any, stock_status: any }} current
 * @returns {any}
 */
function planStockWrite(action, current) {
  const managed = current.manage_stock === true;
  const qty = typeof current.stock_quantity === 'number' ? current.stock_quantity : null;
  if (action.type === 'stock_set') {
    if (!managed) return { clarify: 'Stock tracking is OFF for this item, so it has no quantity. Turn on "Manage stock" in WooCommerce first, or send "<item> is in stock" / "out of stock".' };
    return { write: { stock_quantity: action.quantity } };
  }
  if (action.type === 'stock_adjust') {
    if (!managed || qty === null) return { clarify: 'Stock tracking is OFF for this item, so I cannot add or remove units. Turn on "Manage stock" in WooCommerce first.' };
    const next = qty + action.delta;
    if (next < 0) return { clarify: 'That would make the stock negative (' + qty + ' ' + (action.delta < 0 ? '−' : '+') + ' ' + Math.abs(action.delta) + '). Send the exact quantity instead, e.g. "set stock ... to 0".' };
    return { write: { stock_quantity: next } };
  }
  if (action.type === 'stock_status') {
    if (!managed) return { write: { stock_status: action.stock_status } };
    if (action.stock_status === 'outofstock') return { write: { stock_quantity: 0 } };
    // "Available" alone gives no quantity for a stock-managed item.
    if (qty !== null && qty > 0) return { noop: 'Already in stock (' + qty + ' units).' };
    return { clarify: 'This item tracks a quantity. How many units are available? e.g. "set stock ... to 5".' };
  }
  return { clarify: 'Unsupported stock action.' };
}
// ---- end shared/admin-commands.js ----
const target = $('Stock Target').first().json.target;
const a = $('Command').first().json.action || {};
const r = $input.first().json || {};
const status = typeof r.statusCode === 'number' ? r.statusCode : null;
if (status === null || status < 200 || status >= 300 || !r.body || r.body.id === undefined) {
  return [{ json: { route: 'reply', reply: 'Could not read the current stock from WooCommerce (' + (status || 'no response') + '). Nothing was changed.' } }];
}
const cur = { manage_stock: r.body.manage_stock === true, stock_quantity: typeof r.body.stock_quantity === 'number' ? r.body.stock_quantity : null, stock_status: r.body.stock_status || null };
const plan = planStockWrite(a, cur);
const label = target.name + (target.sku ? ' (SKU ' + target.sku + ')' : '');
if (plan.clarify) return [{ json: { route: 'reply', reply: label + ': ' + plan.clarify } }];
if (plan.noop) return [{ json: { route: 'reply', reply: label + ': ' + plan.noop + ' Nothing changed.' } }];
const op = a.type === 'stock_set' ? 'set' : a.type === 'stock_adjust' ? 'adjust' : 'status';
return [{ json: { route: 'write', product_id: Number(target.product_id), variation_id: Number(target.variation_id) || 0, label, write: plan.write,
  begin: { command_id: $('Command').first().json.command_id, product_id: Number(target.product_id), variation_id: Number(target.variation_id) || 0,
           sku: target.sku, name: target.name, op, requested: a.type === 'stock_set' ? { quantity: a.quantity } : a.type === 'stock_adjust' ? { delta: a.delta } : { stock_status: a.stock_status },
           previous: cur } } }];
