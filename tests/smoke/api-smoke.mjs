// API smoke test against a running server (npm run start) with a migrated,
// seeded database containing at least one ingested conversation.
//   BASE=http://localhost:3100 OWNER_EMAIL=... OWNER_PASSWORD=... AGENT_EMAIL=... AGENT_PASSWORD=... node tests/smoke/api-smoke.mjs
// Exercises every staff endpoint once (reads and safe writes) and checks that
// permissions are enforced for the agent role and that CSRF is required.
const BASE = process.env.BASE || 'http://localhost:3100';
let failures = 0;

async function session(email, password) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (!r.ok) throw new Error(`login ${email}: ${r.status}`);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const me = await (await fetch(`${BASE}/api/auth/me`, { headers: { cookie } })).json();
  const call = async (method, path, body, opts = {}) => {
    const headers = { cookie };
    if (method !== 'GET' && !opts.noCsrf) headers['x-csrf-token'] = me.csrf_token;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  };
  return { call, me };
}

function expect(name, cond, detail) {
  if (cond) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}`, typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 300)); }
}

const owner = await session(process.env.OWNER_EMAIL, process.env.OWNER_PASSWORD);
const agent = await session(process.env.AGENT_EMAIL, process.env.AGENT_PASSWORD);

const list = await owner.call('GET', '/api/conversations');
expect('list conversations', list.status === 200 && list.data.conversations.length > 0, list);
const convId = list.data.conversations.find((c) => c.mode !== 'HUMAN')?.id ?? list.data.conversations[0].id;
for (const q of ['?queue=attention', '?queue=waiting', '?mode=HUMAN', '?q=netflix', '?status=resolved']) {
  const r = await owner.call('GET', `/api/conversations${q}`);
  expect(`list ${q}`, r.status === 200, r);
}
const detail = await owner.call('GET', `/api/conversations/${convId}`);
expect('conversation detail', detail.status === 200 && Array.isArray(detail.data.messages), detail);

for (const path of ['/api/controls', '/api/alerts', '/api/health', '/api/metrics?days=7', '/api/order-ops', '/api/audit', '/api/settings',
  '/api/prompts', '/api/knowledge', '/api/canned', '/api/staff']) {
  const r = await owner.call('GET', path);
  expect(`GET ${path}`, r.status === 200, r);
}

// CSRF is required on mutations.
const noCsrf = await owner.call('POST', `/api/conversations/${convId}/notes`, { body: 'x' }, { noCsrf: true });
expect('mutation without CSRF is refused', noCsrf.status === 403, noCsrf);

// Agent permissions.
expect('agent cannot read settings', (await agent.call('GET', '/api/settings')).status === 403);
expect('agent cannot flip global AI', (await agent.call('POST', '/api/controls', { ai_enabled: true })).status === 403);
expect('agent cannot emergency-stop', (await agent.call('POST', '/api/controls', { sending_enabled: false })).status === 403);
expect('agent cannot resume AI', (await agent.call('POST', `/api/conversations/${convId}/mode`, { mode: 'AUTO' })).status === 403);
expect('agent cannot export customer data', (await agent.call('GET', `/api/customers/${detail.data.customer.id}/export`)).status === 403);
expect('agent cannot delete customer data', (await agent.call('DELETE', `/api/customers/${detail.data.customer.id}`, { confirm: 'DELETE' })).status === 403);
expect('agent cannot view audit', (await agent.call('GET', '/api/audit')).status === 403);
expect('unauthenticated is refused', (await fetch(`${BASE}/api/conversations`)).status === 401);

// Safe writes.
let r = await owner.call('POST', `/api/conversations/${convId}/notes`, { body: 'Smoke test note' });
expect('add internal note', r.status === 200, r);
r = await owner.call('POST', `/api/conversations/${convId}/tags`, { tags: ['smoke', 'নেটফ্লিক্স'], priority: 'high' });
expect('set tags (Bangla tag)', r.status === 200, r);
r = await owner.call('POST', `/api/conversations/${convId}/assign`, { staff_id: owner.me.id });
expect('assign to self', r.status === 200, r);
r = await owner.call('POST', `/api/conversations/${convId}/mode`, { mode: 'COPILOT' });
expect('set COPILOT', r.status === 200, r);
r = await owner.call('POST', `/api/conversations/${convId}/takeover`, {});
expect('take over', r.status === 200 && r.data.mode === 'HUMAN', r);
r = await owner.call('POST', `/api/conversations/${convId}/reply`, { text: 'স্মোক টেস্ট reply', client_request_id: `smoke-${Date.now()}` });
expect('staff reply queued', r.status === 200 && r.data.outbound_id, r);
r = await owner.call('POST', `/api/conversations/${convId}/reply`, { client_request_id: `smoke-e-${Date.now()}` });
expect('empty reply is rejected', r.status === 400, r);
r = await owner.call('POST', `/api/conversations/${convId}/mode`, { mode: 'AUTO' });
expect('owner resumes AI', r.status === 200 && r.data.mode === 'AUTO', r);
r = await owner.call('POST', `/api/conversations/${convId}/status`, { status: 'pending' });
expect('set status', r.status === 200, r);

const drafts = (await owner.call('GET', `/api/conversations/${convId}`)).data.drafts.filter((d) => d.status === 'pending_review');
if (drafts[0]) {
  r = await owner.call('POST', `/api/drafts/${drafts[0].id}/reject`, { note: 'smoke' });
  expect('reject draft', r.status === 200, r);
}

r = await owner.call('POST', '/api/canned', { title: 'Smoke', body: 'ধন্যবাদ', language: 'bn' });
expect('create canned reply', r.status === 200, r);
r = await owner.call('POST', '/api/knowledge', { slug: `smoke-${Date.now() % 100000}`, category: 'faq', title: 'Delivery time', body: 'Most subscriptions are delivered within 20 minutes after payment is confirmed.' });
expect('create knowledge entry', r.status === 200, r);
r = await owner.call('PUT', '/api/settings', { key: 'burst_debounce_seconds', value: 6 });
expect('update a setting', r.status === 200, r);
r = await owner.call('PUT', '/api/settings', { key: 'burst_debounce_seconds', value: 999 });
expect('invalid setting is rejected', r.status === 400, r);
r = await owner.call('PUT', '/api/settings', { key: 'ai_enabled', value: true });
expect('global AI cannot be set via settings', r.status === 400, r);
r = await owner.call('POST', '/api/prompts', { name: 'customer_system', body: 'Draft prompt for smoke test. '.repeat(3) });
expect('create prompt draft', r.status === 200, r);
r = await owner.call('POST', `/api/prompts/${r.data.id}/publish`, {});
expect('untested prompt cannot be published', r.status === 409, r);
r = await owner.call('GET', `/api/customers/${detail.data.customer.id}/export`);
expect('export customer data', r.status === 200 && typeof r.data === 'object', r);

// Internal endpoints need the internal token.
const sweepNoAuth = await fetch(`${BASE}/api/internal/events/sweep`, { method: 'POST' });
expect('internal sweep refuses without token', sweepNoAuth.status === 401);
if (process.env.BACKEND_INTERNAL_TOKEN) {
  const s = await fetch(`${BASE}/api/internal/events/sweep`, { method: 'POST', headers: { 'x-internal-token': process.env.BACKEND_INTERNAL_TOKEN } });
  expect('internal sweep with token', s.status === 200, await s.text());
}

console.log(failures ? `\n${failures} failure(s)` : '\nall smoke checks passed');
process.exit(failures ? 1 : 0);
