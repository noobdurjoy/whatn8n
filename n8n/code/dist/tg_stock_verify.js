// Infinity Digital Shop — WhatsApp AI Support · "Verify Stock"
// Success is reported only when WooCommerce, read back after the write,
// shows the requested values. A timeout with a different read-back is
// "unknown" (checked by a person, never retried automatically).
// ---- begin shared/admin-commands.js (stockMatches) (inlined by n8n/build.mjs; edit the shared file, not this copy) ----
// Did WooCommerce end up with what we asked for? (read-back after writing)
/** @param {any} write @param {any} after */
function stockMatches(write, after) {
  if (!after) return false;
  if ('stock_quantity' in write && after.stock_quantity !== write.stock_quantity) return false;
  if ('stock_status' in write && after.stock_status !== write.stock_status) return false;
  return true;
}
// ---- end shared/admin-commands.js ----
const plan = $('Plan Stock Write').first().json;
const put = $('Write Stock').first().json || {};
const rb = $input.first().json || {};
const putStatus = typeof put.statusCode === 'number' ? put.statusCode : null;
const after = rb.body && rb.body.id !== undefined ? { stock_quantity: typeof rb.body.stock_quantity === 'number' ? rb.body.stock_quantity : null, stock_status: rb.body.stock_status || null, manage_stock: rb.body.manage_stock === true } : null;
let status;
if (after && stockMatches(plan.write, after)) status = 'succeeded';
else if (putStatus !== null && putStatus >= 400 && putStatus < 500) status = 'failed';
else status = 'unknown';
return [{ json: { stock_change_id: $('Begin Stock Change').first().json.r.stock_change_id, status, target: plan.write, result: after || { read_back: 'unavailable', put_status: putStatus },
  label: plan.label, previous: plan.begin.previous, put_status: putStatus } }];
