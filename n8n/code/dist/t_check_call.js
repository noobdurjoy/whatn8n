// WA · B1 Tool Runner — "Check Tool Call"
// Runs once per tool call. Only allow-listed tools with validated arguments
// get through; the model never supplies ids that grant access (the job id and
// conversation come from the backend, not from the model).

const item = $input.first().json;
const ALLOWED = {
  search_knowledge: { query: 'string' },
  search_products: { query: 'string' },
  get_product_details: { product_id: 'int' },
  create_checkout_link: { product_id: 'int', variation_id: 'int', quantity: 'int' },
  verify_order_access: { order_id: 'int' },
  get_order_status: { order_id: 'int' },
  propose_order_change: { type: 'string', order_id: 'int', details: 'string' },
  analyze_image: { attachment_id: 'uuid', question: 'string' },
};
function fail(error) {
  return [{ json: { route: 'invalid', call_id: item.call_id, name: item.name, job_id: item.job_id, error: error } }];
}
if (item.blocked) return fail(item.blocked);
const spec = ALLOWED[item.name];
if (!spec) return fail('unknown_tool');
let args;
try { args = typeof item.arguments === 'string' ? JSON.parse(item.arguments || '{}') : (item.arguments || {}); } catch (e) { return fail('arguments_not_json'); }
if (!args || typeof args !== 'object' || Array.isArray(args)) return fail('arguments_not_object');
const clean = {};
for (const k of Object.keys(spec)) {
  const t = spec[k];
  const val = args[k];
  if (t === 'string') {
    if (typeof val !== 'string' || !val.trim()) return fail('invalid_' + k);
    clean[k] = val.trim().slice(0, k === 'details' ? 1000 : 200);
  } else if (t === 'int') {
    const n = typeof val === 'string' ? Number(val) : val;
    if (!Number.isInteger(n) || n < 0 || n > 1e12) return fail('invalid_' + k);
    clean[k] = n;
  } else if (t === 'uuid') {
    if (typeof val !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val)) return fail('invalid_' + k);
    clean[k] = val.toLowerCase();
  }
}
if (item.name === 'create_checkout_link' && (clean.quantity < 1 || clean.quantity > 10)) return fail('invalid_quantity');
if (item.name === 'propose_order_change' && ['refund', 'cancel_order', 'address_change', 'renewal', 'access_issue'].indexOf(clean.type) < 0) return fail('invalid_type');
const route = item.name === 'search_knowledge' ? 'knowledge' : item.name === 'analyze_image' ? 'image' : 'woo';
return [{ json: { route: route, call_id: item.call_id, name: item.name, job_id: item.job_id, conversation_id: item.conversation_id, customer_language: item.customer_language || null, args: clean } }];
