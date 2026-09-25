// Infinity Digital Shop — WhatsApp AI Support · "Resolve Stock Target (variations)"
// Finds the EXACT product or variation to change. Several matches → the
// owner chooses from a numbered list; nothing is guessed.
const KIND = 'variations';
const a = $('Command').first().json.action || {};
const r = $input.first().json || {};
const status = typeof r.statusCode === 'number' ? r.statusCode : null;
const body = r.body;
const fail = (reply) => [{ json: { status: 'reply', reply } }];
if (status === 404) return fail('No product found for that reference.');
if (status === null || status < 200 || status >= 300) return fail('WooCommerce did not answer (' + (status || 'no response') + '). Nothing was changed.');
const t = (p, v) => (p.type === 'variation' && p.parent_id && !v
  // A SKU lookup also returns variations (type "variation", parent_id).
  ? { product_id: p.parent_id, variation_id: p.id, sku: p.sku || null, name: String(p.name || '').slice(0, 160), permalink: p.permalink || null }
  : { product_id: p.id, variation_id: v ? v.id : 0, sku: (v || p).sku || null,
    name: String(p.name || '').slice(0, 120) + (v ? ' — ' + (v.attributes || []).map((x) => x.option).join(', ') : ''),
    permalink: p.permalink || null });
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9ঀ-৿]+/g, ' ').trim();
if (KIND === 'products') {
  let list = Array.isArray(body) ? body : body && body.id ? [body] : [];
  list = list.filter((p) => p && p.id && p.status !== 'trash');
  if (a.sku) list = list.filter((p) => String(p.sku || '').toLowerCase() === String(a.sku).toLowerCase());
  if (!list.length) {
    return fail(a.sku ? 'No product or variation has SKU ' + a.sku + '. Check the SKU, or use the product name or id.' : 'No product matched "' + (a.query || '') + '".');
  }
  if (list.length === 1 && list[0].type === 'variable' && !(a.variation_id)) {
    return [{ json: { status: 'need_variations', product: list[0] } }];
  }
  if (list.length === 1 && list[0].type === 'variable' && a.variation_id) {
    return [{ json: { status: 'need_variations', product: list[0], variation_id: a.variation_id } }];
  }
  if (list.length === 1) return [{ json: { status: 'target', target: t(list[0]) } }];
  const choices = list.slice(0, 8).map((p) => t(p));
  return [{ json: { status: 'choices', choices } }];
}
// variations
const product = $('Resolve Stock Target (products)').first().json.product;
const wantVar = $('Resolve Stock Target (products)').first().json.variation_id || null;
let vars = Array.isArray(body) ? body.filter((v) => v && v.id) : [];
if (wantVar) vars = vars.filter((v) => v.id === wantVar);
if (a.query) {
  // Keep only variations whose option text matches words the owner gave beyond the product name.
  const words = norm(a.query).split(' ').filter((w) => w && norm(product.name).split(' ').indexOf(w) < 0);
  if (words.length) {
    const hit = vars.filter((v) => { const opt = norm((v.attributes || []).map((x) => x.option).join(' ')); return words.every((w) => opt.indexOf(w) >= 0); });
    if (hit.length) vars = hit;
  }
}
if (!vars.length) return fail('No matching option of ' + product.name + ' was found.');
if (vars.length === 1) return [{ json: { status: 'target', target: t(product, vars[0]) } }];
return [{ json: { status: 'choices', choices: vars.slice(0, 10).map((v) => t(product, v)) } }];
