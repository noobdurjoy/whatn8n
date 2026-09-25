// WA · H Daily Learning — "Validate Proposals"
// Every proposal is re-checked on the server: known kind and category,
// revisions only of existing entries, evidence only from this run, and the
// text is redacted again. A proposal that still carries personal data,
// prices or order numbers is dropped. Proposals wait for owner approval.
// @include shared/validate.js: parseModelJson, extractUsage
// @include shared/redact.js: redactPersonal

const meta = $('Prepare Learning Request').first().json.meta;
const resp = $input.first().json || {};
const usage = extractUsage(resp, null, Date.now() - meta.started_at);
usage.purpose = 'learning';
const choice = resp.choices && resp.choices[0];
const parsed = choice && choice.finish_reason !== 'length' ? parseModelJson(choice.message && choice.message.content) : { ok: false };
usage.outcome = parsed.ok ? 'ok' : (resp.error ? 'error' : 'invalid_output');
const out = [];
const list = parsed.ok && Array.isArray(parsed.value.proposals) ? parsed.value.proposals.slice(0, 5) : [];
for (const p of list) {
  if (!p || ['new', 'revise'].indexOf(p.kind) < 0) continue;
  if (['faq', 'product', 'procedure', 'policy'].indexOf(p.category) < 0) continue;
  if (typeof p.title !== 'string' || typeof p.body !== 'string' || !p.title.trim() || !p.body.trim()) continue;
  if (p.kind === 'revise' && meta.slugs.indexOf(p.document_slug) < 0) continue;
  const title = redactPersonal(p.title).slice(0, 200);
  const body = redactPersonal(p.body).slice(0, 4000);
  const rationale = redactPersonal(String(p.rationale || '')).slice(0, 1000);
  const all = title + ' ' + body;
  // Placeholders mean personal data was present: such text is not general guidance.
  if (/\[(EMAIL|PHONE|ORDER|TRANSACTION)\]|\[secret removed\]|\[hidden\]|\[card number hidden\]/.test(all)) continue;
  // Prices and stock are always read live; they never belong in the FAQ.
  if (/(৳|tk\.?\s*\d|\d+\s*(tk|taka|টাকা|bdt)\b|\$\s*\d)/i.test(all)) continue;
  const evidence = (Array.isArray(p.evidence) ? p.evidence : []).filter((r) => meta.refs[r]).map((r) => meta.refs[r]);
  out.push({ json: { proposal: {
    kind: p.kind, slug: p.kind === 'revise' ? p.document_slug : null, category: p.category, title: title, body: body, rationale: rationale,
    evidence: { conversation_ids: evidence },
    redaction: { method: 'redactPersonal', checked_at: new Date().toISOString() },
    run: meta.run,
  }, usage: usage } });
}
// Usage is recorded once per run by "Record Learning Usage" (first item).
return out.length ? out : [{ json: { proposal: null, usage: usage } }];
