// Infinity Digital Shop — WhatsApp AI Support · "Verify Stock"
// Success is reported only when WooCommerce, read back after the write,
// shows the requested values. A timeout with a different read-back is
// "unknown" (checked by a person, never retried automatically).
// @include shared/admin-commands.js: stockMatches
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
