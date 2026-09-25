// Infinity Digital Shop — WhatsApp AI Support · "Plan Stock Write"
// Reads the product/variation as WooCommerce reports it right now and plans
// the exact fields to write (never inventing a quantity).
// @include shared/admin-commands.js: planStockWrite
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
