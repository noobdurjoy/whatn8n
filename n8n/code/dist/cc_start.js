// Infinity Digital Shop — WhatsApp AI Support · "Connection Check Plan"
// Manual, read-only check of every connection this workflow uses. It sends
// nothing to WhatsApp, writes nothing to WooCommerce and changes no settings.
// Model ids mirror the seeded defaults (Settings → AI models in the dashboard
// is authoritative for customer traffic).

const SHOP = 'https://infinitydigitalshop.com';
return [{ json: {
  shop: SHOP,
  chat_model: 'deepseek/deepseek-v4.1-flash',
  vision_model: 'stealth/space-bunny-alpha',
  image_types: ['product_photo', 'error_screenshot', 'payment_receipt', 'order_screenshot', 'chat_screenshot', 'document', 'other', 'unclear'],
  chat_request: {
    model: 'deepseek/deepseek-v4.1-flash',
    messages: [
      { role: 'system', content: 'You are the support assistant of an online shop. Use the tools for any price or product question. Never guess prices.' },
      { role: 'user', content: 'bhai netflix er dam koto?' },
    ],
    tools: [{ type: 'function', function: { name: 'search_products', description: 'Search the live shop catalogue.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } } }],
    tool_choice: 'auto',
    reasoning: { effort: 'low', exclude: true },
    max_tokens: 300,
    provider: { require_parameters: true },
  },
} }];
