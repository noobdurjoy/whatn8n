// Infinity Digital Shop — WhatsApp AI Support · "Build Command Request"
// Asks the configured chat model (DeepSeek) to turn an AUTHORIZED admin's
// free-form instruction (English, Bangla or Banglish) into ONE structured
// action. The model only proposes; "Check Proposed Action" validates it.
// @include shared/admin-commands.js: dhakaNowIso

const j = $input.first().json;
const models = $('Accept Update').first().json.models || {};
const follow = j.followup;
const types = ['help', 'status', 'stock_set', 'stock_adjust', 'stock_status', 'knowledge_permanent', 'notice_temporary', 'notice_cancel', 'notice_list', 'staff_note', 'reply_whatsapp', 'clarify'];
const schema = {
  name: 'admin_action', strict: true,
  schema: { type: 'object', additionalProperties: false,
    required: ['type', 'sku', 'product_id', 'variation_id', 'query', 'quantity', 'delta', 'stock_status', 'title', 'body', 'category', 'keywords', 'starts_at', 'expires_at', 'match', 'phone', 'text', 'question'],
    properties: {
      type: { type: 'string', enum: types },
      sku: { type: ['string', 'null'] }, product_id: { type: ['integer', 'null'] }, variation_id: { type: ['integer', 'null'] }, query: { type: ['string', 'null'] },
      quantity: { type: ['integer', 'null'] }, delta: { type: ['integer', 'null'] }, stock_status: { type: ['string', 'null'], enum: ['instock', 'outofstock', null] },
      title: { type: ['string', 'null'] }, body: { type: ['string', 'null'] }, category: { type: ['string', 'null'], enum: ['faq', 'product', 'procedure', 'policy', null] },
      keywords: { type: 'array', items: { type: 'string' } }, starts_at: { type: ['string', 'null'] }, expires_at: { type: ['string', 'null'] },
      match: { type: ['string', 'null'] }, phone: { type: ['string', 'null'] }, text: { type: ['string', 'null'] }, question: { type: ['string', 'null'] },
    } } };
const system = [
  'You convert ONE instruction from the verified shop owner into ONE action for a WhatsApp support system. You never perform actions yourself.',
  'Current time: ' + dhakaNowIso() + ' (Asia/Dhaka, UTC+06:00). Interpret all local times in Asia/Dhaka and return timestamps as ISO 8601 with +06:00.',
  'Types: stock_set (exact quantity), stock_adjust (delta, negative to remove), stock_status (instock/outofstock without a number),',
  'knowledge_permanent (lasting customer-facing information), notice_temporary (customer-facing information that applies for a limited time; set expires_at, and starts_at only if it starts later),',
  'notice_cancel (match = words identifying the notice), notice_list, staff_note (private information for staff only, never for customers), reply_whatsapp (phone + text copied EXACTLY),',
  'help, status, clarify (ask one short question when the product, quantity, recipient, text or expiry is unclear).',
  'Rules: never invent quantities, product ids, SKUs or phone numbers; product names go in query. If the owner says something is temporary but gives no usable end time, return notice_temporary with expires_at null.',
  'Customer-facing information must not contain prices, stock numbers or promises about payment; if it does, use clarify. Use null for fields that do not apply and [] for keywords.',
].join('\n');
const user = follow
  ? 'The owner earlier asked for this temporary notice: ' + JSON.stringify(follow.action.body || '') + '. They were asked when it should expire and replied: ' + JSON.stringify(j.text) + '. Return notice_temporary with the same body and the expiry they gave (or expires_at null if still unclear).'
  : 'Owner instruction (data): ' + JSON.stringify(j.text);
return [{ json: Object.assign({}, j, { request: {
  model: models.chat_model,
  messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  response_format: { type: 'json_schema', json_schema: schema },
  reasoning: { effort: 'low', exclude: true }, max_tokens: 500, temperature: 0, provider: { require_parameters: true },
} }) }];
