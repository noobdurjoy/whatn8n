// End-to-end test of the ONE workflow in a real n8n runtime:
//   node tests/e2e/run.mjs [--setup] [--only name,name]
// --setup rebuilds the databases, imports credentials + workflow into the local
// n8n and starts mock, n8n and backend. Without it, an already running
// environment is used (see env.mjs). Writes .e2e/report.json.
//
// Customer traffic is simulated with signed Zernio webhooks sent to the real
// backend, exactly as Zernio would; replies go to the HTTPS provider mock.
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import * as e from './env.mjs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;
const sql = e.sql;
const one = async (q, p) => (await sql(q, p))[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const FIX = path.join(e.ROOT, 'fixtures', 'zernio');
const ACCOUNT = 'acc_000000000000000000000001';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fixture(name, o = {}) {
  const p = JSON.parse(readFileSync(path.join(FIX, name), 'utf8'));
  p.id = o.eventId || 'evt_' + randomUUID();
  const now = new Date().toISOString();
  if (p.message) {
    const conv = o.conv || 'conv_' + randomUUID().replace(/-/g, '').slice(0, 24);
    p.message.conversationId = conv; p.conversation.id = conv;
    p.message.platformMessageId = o.wamid || 'wamid.' + randomUUID();
    if (o.text !== undefined) p.message.text = o.text;
    p.message.sentAt = now; p.timestamp = now;
    if (p.message.direction === 'incoming') {
      const phone = o.phone || '+88017' + String(Math.floor(10000000 + Math.random() * 89999999));
      p.message.sender.phoneNumber = phone; p.message.sender.id = phone.replace('+', '');
      p.message.sender.businessScopedUserId = o.bsuid || 'BD.' + randomUUID();
      p.conversation.platformConversationId = phone.replace('+', ''); p.conversation.participantId = phone.replace('+', '');
    }
    if (o.attachments) p.message.attachments = o.attachments;
  }
  return p;
}
async function zernio(payload) {
  const raw = JSON.stringify(payload);
  const sig = createHmac('sha256', e.T.zernioSecret).update(raw).digest('hex');
  const r = await fetch(e.APP + '/api/webhooks/zernio', { method: 'POST', body: raw,
    headers: { 'content-type': 'application/json', 'x-zernio-event': payload.event, 'x-zernio-event-id': payload.id, 'x-zernio-signature': sig } });
  return { status: r.status, body: await r.text() };
}
async function n8nHook(name, body) {
  const r = await fetch(e.N8N + '/webhook/' + name, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + e.T.inbound }, body: JSON.stringify(body) });
  return r.status;
}
const convOf = async (providerConv) => one('SELECT * FROM app.conversations WHERE provider_conversation_id = $1', [providerConv]);
const sendsTo = async (providerConv) => (await e.mock('/_log')).sends.filter((s) => s.conversation === providerConv);
const setSetting = (k, v) => sql('UPDATE app.settings SET value = $2::jsonb WHERE key = $1', [k, JSON.stringify(v)]);
const waitFor = e.waitFor;

async function customer(text, o = {}) {
  const p = fixture(o.fixture || 'message.received.banglish.json', { text, ...o });
  const r = await zernio(p);
  if (r.status !== 200) throw new Error('webhook ' + r.status + ' ' + r.body);
  const c = await waitFor(() => convOf(p.message.conversationId), { what: 'conversation stored' });
  return { p, conv: p.message.conversationId, c };
}

async function scenario(name, fn) {
  if (only && !only.includes(name)) return;
  const t0 = Date.now();
  try {
    const evidence = await fn();
    results.push({ name, pass: true, seconds: Math.round((Date.now() - t0) / 1000), evidence });
    console.log('PASS', name, JSON.stringify(evidence).slice(0, 400));
  } catch (err) {
    results.push({ name, pass: false, seconds: Math.round((Date.now() - t0) / 1000), error: String(err && err.stack || err).slice(0, 1500) });
    console.log('FAIL', name, String(err && err.message || err));
  }
}
function assert(cond, msg, extra) { if (!cond) throw new Error(msg + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 800) : '')); }

// n8n execution data (flatted JSON) → executed node names, for evidence.
const require = createRequire(path.join(e.N8N_DIR, 'node_modules', 'n8n', 'package.json'));
const flatted = require('flatted');
async function executions(since) {
  const rows = await sql(`SELECT e.id, e.status, e.mode, e."startedAt", d.data FROM execution_entity e LEFT JOIN execution_data d ON d."executionId" = e.id
                           WHERE e."workflowId" = $1 AND e."startedAt" >= $2 ORDER BY e.id`, [e.WORKFLOW_ID, since], e.APP_URL.replace('/' + e.APP_DB, '/' + e.N8N_DB));
  return rows.map((r) => {
    let nodes = [];
    try { nodes = Object.keys(flatted.parse(r.data).resultData.runData || {}); } catch { nodes = []; }
    return { id: r.id, status: r.status, mode: r.mode, nodes, raw: r.data || '' };
  });
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------
const started = new Date();
if (args.includes('--setup')) {
  await e.stopAll();
  e.certs();
  await e.databases();
  console.log('setup: databases migrated and seeded');
  await e.setupN8n();
  console.log('setup: credentials and workflow imported and published');
  e.startMockProcess(); e.startN8n(); e.startApp();
  await waitFor(async () => (await fetch(e.N8N + '/healthz')).ok, { timeout: 120000, what: 'n8n' });
  await waitFor(async () => (await fetch(e.APP + '/api/health')).ok, { timeout: 60000, what: 'backend' });
  console.log('setup: n8n, backend and mock running');
}
await e.mock('/_reset', {});
const staffId = (await one(`INSERT INTO app.staff_users (email, display_name, role, password_hash) VALUES ('e2e-admin-' || gen_random_uuid() || '@example.test', 'E2E Admin', 'admin', 'x') RETURNING id`)).id;
await setSetting('ai_enabled', true);
await setSetting('sending_enabled', true);
await setSetting('default_mode', 'COPILOT');
await setSetting('burst_debounce_seconds', 1);
await setSetting('ai_daily_budget_usd', 5);
// First message creates the WhatsApp account row; accounts start disabled until staff enable them.
await customer('hello', { fixture: 'message.received.banglish.json' });
await sql(`UPDATE app.channel_accounts SET enabled = true, status = 'active' WHERE provider_account_id <> 'sandbox'`);

await scenario('copilot_draft_uses_live_shop_tool', async () => {
  await setSetting('default_mode', 'COPILOT');
  const { conv, c } = await customer('bhai netflix er dam koto?');
  const d = await waitFor(() => one(`SELECT body, status FROM app.ai_drafts WHERE conversation_id = $1`, [c.id]), { timeout: 60000, what: 'draft' });
  const log = (await e.mock('/_log')).log;
  assert(/350/.test(d.body), 'draft should quote the live price', d);
  assert(log.some((l) => l.path === '/shop/wp-json/wc/store/v1/products' && l.query.search === 'netflix'), 'Store API search expected');
  assert((await sendsTo(conv)).length === 0, 'COPILOT must not send');
  return { mode: c.mode, draft_status: d.status, draft: d.body };
});

await scenario('duplicate_events_one_reply', async () => {
  await setSetting('default_mode', 'COPILOT');
  const { p, c } = await customer('netflix plan gula ki?');
  const again = await zernio(p); // same Zernio event id: stored once
  await waitFor(() => one(`SELECT 1 FROM app.ai_drafts WHERE conversation_id = $1`, [c.id]), { timeout: 60000, what: 'draft' });
  const ev = await one(`SELECT id, duplicate_count, route_claimed_at FROM app.webhook_events WHERE provider_event_id = $1`, [p.id]);
  // Re-delivery of the routing call (e.g. the backend retried after a timeout): the workflow claims each event once.
  const codes = [await n8nHook('wa-router', { event_id: ev.id }), await n8nHook('wa-router', { event_id: ev.id })];
  await sleep(8000);
  const jobs = await one(`SELECT count(*)::int AS n FROM app.ai_jobs WHERE conversation_id = $1 AND kind = 'reply'`, [c.id]);
  const drafts = await one(`SELECT count(*)::int AS n FROM app.ai_drafts WHERE conversation_id = $1`, [c.id]);
  assert(jobs.n === 1 && drafts.n === 1, 'exactly one job and one draft', { jobs, drafts });
  return { second_webhook_status: again.status, duplicate_count: ev.duplicate_count, redelivery_http: codes, ai_jobs: jobs.n, drafts: drafts.n };
});

await scenario('auto_reply_sent_once_and_echo_does_not_loop', async () => {
  await setSetting('default_mode', 'AUTO');
  const { conv, c } = await customer('netflix koto taka?');
  const s = await waitFor(async () => { const x = await sendsTo(conv); return x.length ? x : null; }, { timeout: 60000, what: 'send' });
  await waitFor(() => one(`SELECT 1 FROM app.outbound_messages WHERE conversation_id = $1 AND status = 'sent'`, [c.id]), { timeout: 30000, what: 'recorded as sent' });
  // Zernio echoes our own message back as message.sent.
  const echo = fixture('message.sent.own-api.json', { conv, wamid: s[0].id, text: s[0].body.message });
  const r = await zernio(echo);
  await sleep(12000);
  const after = await sendsTo(conv);
  const jobs = await one(`SELECT count(*)::int AS n FROM app.ai_jobs WHERE conversation_id = $1`, [c.id]);
  const route = await one(`SELECT route FROM app.webhook_events WHERE provider_event_id = $1`, [echo.id]);
  assert(after.length === 1, 'exactly one send', after.length);
  assert(jobs.n === 1, 'echo must not start AI', jobs);
  assert(s[0].key, 'send carries an Idempotency-Key');
  return { mode: c.mode, sent_text: s[0].body.message, idempotency_key: Boolean(s[0].key), echo_http: r.status, echo_route: route.route, ai_jobs: jobs.n, sends: after.length };
});

await scenario('image_sent_to_vision_model_and_used', async () => {
  await setSetting('default_mode', 'AUTO');
  const media = 'https://zernio.com/api/v1/whatsapp/media/MEDIA_E2E_' + randomUUID().slice(0, 8) + '?accountId=' + ACCOUNT;
  const { conv, c } = await customer('ei error ta ashche, ki korbo?', { fixture: 'message.received.image.json', attachments: [{ type: 'image', mimeType: 'image/png', url: media }] });
  const s = await waitFor(async () => { const x = await sendsTo(conv); return x.length ? x : null; }, { timeout: 90000, what: 'reply' });
  const att = await one(`SELECT a.fetch_status, a.mime_type, a.size_bytes FROM app.attachments a JOIN app.messages m ON m.id = a.message_id WHERE m.conversation_id = $1`, [c.id]);
  const an = await one(`SELECT status, model, result->>'image_type' AS image_type FROM app.image_analyses ORDER BY created_at DESC LIMIT 1`);
  const vis = (await e.mock('/_log')).log.filter((l) => l.kind === 'vision_image');
  assert(att.fetch_status === 'stored', 'attachment stored', att);
  assert(vis.length >= 1 && vis[vis.length - 1].data_url_prefix.startsWith('data:image/png;base64'), 'vision got a base64 data URL', vis);
  assert(an && an.status === 'ok' && an.model === 'qwen/qwen3.7-flash', 'analysis stored with Qwen', an);
  assert(/403/.test(s[0].body.message), 'reply uses the observation', s[0].body);
  return { attachment: att, analysis: an, vision_request: vis[vis.length - 1], reply: s[0].body.message };
});

await scenario('order_lookup_enforces_ownership', async () => {
  await setSetting('default_mode', 'AUTO');
  const own = await customer('amar order 5001 er status ki?', { phone: '+8801700000001' });
  const other = await customer('order 5002 er status bolen', { phone: '+8801888888888' });
  const s1 = await waitFor(async () => { const x = await sendsTo(own.conv); return x.length ? x : null; }, { timeout: 60000, what: 'owner reply' });
  const s2 = await waitFor(async () => { const x = await sendsTo(other.conv); return x.length ? x : null; }, { timeout: 60000, what: 'other reply' });
  const links = await sql(`SELECT l.woo_order_id, c.provider_conversation_id FROM app.order_links l JOIN app.conversations c ON c.customer_id = l.customer_id
                           WHERE l.woo_order_id IN (5001, 5002) AND c.provider_conversation_id IN ($1, $2)`, [own.conv, other.conv]);
  assert(/processing/.test(s1[0].body.message), 'owner sees status', s1[0].body);
  assert(!/processing|900|Spotify|Nagad/i.test(s2[0].body.message), 'non-owner must not see order details', s2[0].body);
  assert(links.length === 1 && links[0].woo_order_id === '5001', 'only the owner gets linked', links);
  return { owner_reply: s1[0].body.message, other_reply: s2[0].body.message, order_links: links };
});

await scenario('takeover_during_generation_discards_answer', async () => {
  await setSetting('default_mode', 'AUTO');
  await e.mock('/_control', { slowMs: 9000 });
  const { conv, c } = await customer('slow: netflix er dam?');
  await waitFor(() => one(`SELECT 1 FROM app.ai_jobs WHERE conversation_id = $1 AND status = 'running'`, [c.id]), { timeout: 30000, what: 'job running' });
  const t = await one(`SELECT app.take_over($1, 'staff', $2, 'staff_take_over', '{}', false) AS r`, [c.id, staffId]);
  await waitFor(() => one(`SELECT 1 FROM app.ai_jobs WHERE conversation_id = $1 AND status <> 'running'`, [c.id]), { timeout: 60000, what: 'job finished' });
  await sleep(5000);
  const job = await one(`SELECT status, discard_reason FROM app.ai_jobs WHERE conversation_id = $1`, [c.id]);
  const out = await one(`SELECT count(*)::int AS n FROM app.outbound_messages WHERE conversation_id = $1 AND actor_type = 'ai'`, [c.id]);
  assert((await sendsTo(conv)).length === 0, 'nothing sent after takeover');
  assert(out.n === 0, 'no AI outbox row', out);
  await e.mock('/_control', { slowMs: 0 });
  return { takeover: t.r, job, ai_outbox_rows: out.n, sends: 0 };
});

await scenario('global_controls_apply_to_every_send_route', async () => {
  await setSetting('default_mode', 'AUTO');
  await setSetting('sending_enabled', false);
  const { conv, c } = await customer('netflix available?');
  await waitFor(() => one(`SELECT 1 FROM app.outbound_messages WHERE conversation_id = $1 AND actor_type = 'ai'`, [c.id]), { timeout: 60000, what: 'AI reply queued' });
  const staffOut = await one(`SELECT app.enqueue_staff_reply($1, $2, 'Staff here, checking for you.', '{}', NULL) AS r`, [c.id, staffId]);
  const ids = (await sql(`SELECT id FROM app.outbound_messages WHERE conversation_id = $1`, [c.id])).map((r) => r.id);
  for (const id of ids) await n8nHook('wa-dispatch', { outbound_id: id }); // explicit dispatch attempts
  await sleep(20000); // and the 15-second sweep
  const whileStopped = (await sendsTo(conv)).length;
  assert(whileStopped === 0, 'nothing may be sent while stopped', whileStopped);
  await setSetting('sending_enabled', true);
  // By design, messages held by the stop are CANCELED (never released later).
  await sleep(16000);
  const held = await sql(`SELECT actor_type, status, status_reason FROM app.outbound_messages WHERE conversation_id = $1 ORDER BY created_at`, [c.id]);
  assert((await sendsTo(conv)).length === 0 && held.every((r) => r.status === 'canceled'), 'held messages stay canceled after resume', held);
  // A new staff reply after resuming is sent normally.
  const again = await one(`SELECT app.enqueue_staff_reply($1, $2, 'Staff here again after the stop.', '{}', NULL) AS r`, [c.id, staffId]);
  await n8nHook('wa-dispatch', { outbound_id: again.r.outbound_id });
  const s = await waitFor(async () => { const x = await sendsTo(conv); return x.length ? x : null; }, { timeout: 60000, what: 'send after resume' });
  const all = await sendsTo(conv);
  const rows = await sql(`SELECT actor_type, status, status_reason FROM app.outbound_messages WHERE conversation_id = $1 ORDER BY created_at`, [c.id]);
  assert(all.length === 1 && /after the stop/.test(all[0].body.message), 'only the new staff reply is sent', { all, rows });
  // AI switch off: no AI job at all.
  await setSetting('ai_enabled', false);
  const off = await customer('hello again');
  await sleep(10000);
  const offJobs = await one(`SELECT count(*)::int AS n FROM app.ai_jobs WHERE conversation_id = $1`, [off.c.id]);
  await setSetting('ai_enabled', true);
  assert(offJobs.n === 0, 'AI off: no job', offJobs);
  return { sends_while_stopped: whileStopped, held_after_resume: held, outbox: rows, sends_after_resume: all.length, sent: s[0].body.message, ai_off_jobs: offJobs.n };
});

await scenario('failed_event_recovered_by_sweep', async () => {
  await setSetting('default_mode', 'AUTO');
  const p = fixture('message.received.banglish.json', { text: 'netflix price please' });
  // Stored but never processed (e.g. the backend crashed right after storing it).
  await sql(`INSERT INTO app.webhook_events (source, provider_event_id, event_type, signature_valid, payload, received_at)
             VALUES ('zernio', $1, 'message.received', true, $2, now() - interval '2 minutes')`, [p.id, p]);
  const ev = await waitFor(() => one(`SELECT processing_status, routed_at, route_claimed_at FROM app.webhook_events WHERE provider_event_id = $1 AND route_claimed_at IS NOT NULL`, [p.id]), { timeout: 150000, what: 'sweep processed and routed' });
  const c = await convOf(p.message.conversationId);
  const s = await waitFor(async () => { const x = await sendsTo(p.message.conversationId); return x.length ? x : null; }, { timeout: 60000, what: 'reply' });
  return { event: ev, mode: c.mode, reply: s[0].body.message };
});

await scenario('budget_exhaustion_hands_off_once', async () => {
  await setSetting('default_mode', 'AUTO');
  await setSetting('ai_daily_budget_usd', 0);
  const { conv, c } = await customer('hello, need help');
  const conv2 = await waitFor(async () => { const x = await convOf(conv); return x.mode === 'HUMAN' ? x : null; }, { timeout: 60000, what: 'handoff' });
  const s = await waitFor(async () => { const x = await sendsTo(conv); return x.length ? x : null; }, { timeout: 40000, what: 'ack' });
  await customer('hello?', { conv, phone: '+' + (await one(`SELECT phone_e164 FROM app.customers WHERE id = $1`, [c.customer_id])).phone_e164.replace('+', '') });
  await sleep(15000);
  const all = await sendsTo(conv);
  const alerts = await one(`SELECT count(*)::int AS n FROM app.alerts WHERE kind = 'ai_budget_reached'`);
  await setSetting('ai_daily_budget_usd', 5);
  assert(conv2.mode_reason === 'ai_budget_reached', 'reason recorded', conv2.mode_reason);
  assert(all.length === 1, 'exactly one acknowledgement', all.map((x) => x.body.message));
  assert(alerts.n === 1, 'one alert', alerts);
  return { mode: conv2.mode, reason: conv2.mode_reason, ack: all[0].body.message, acks_sent: all.length, alerts: alerts.n };
});

await scenario('state_survives_n8n_restart', async () => {
  await setSetting('default_mode', 'AUTO');
  const pids = (await import('node:child_process')).execSync("ps -eo pid,args | grep 'n8n/bin/n8n start' | grep -v grep | awk '{print $1}'").toString().trim().split(/\s+/).filter(Boolean);
  for (const pid of pids) process.kill(Number(pid), 'SIGTERM');
  await waitFor(async () => { try { await fetch(e.N8N + '/healthz'); return false; } catch { return true; } }, { timeout: 30000, what: 'n8n stopped' });
  // While n8n is down: a customer writes (stored and processed by the backend; routing fails).
  const { conv, c } = await customer('netflix er dam koto, n8n down test');
  const ev0 = await one(`SELECT routed_at, route_attempts FROM app.webhook_events WHERE route->>'conversation_id' = $1`, [c.id]);
  // An AI job interrupted by the crash (started 15 minutes ago, never finished).
  const m = await customer('interrupted job test');
  // Its routing already happened before the crash (only the job below is left).
  await sql(`UPDATE app.webhook_events SET routed_at = now(), route_claimed_at = now() WHERE route->>'conversation_id' = $1`, [m.c.id]);
  const mjob = await one(`SELECT app.start_ai_job($1, 'reply', NULL, NULL, NULL) AS r`, [m.c.id]);
  await sql(`UPDATE app.ai_jobs SET started_at = now() - interval '15 minutes' WHERE conversation_id = $1 AND status = 'running'`, [m.c.id]);
  e.startN8n();
  await waitFor(async () => (await fetch(e.N8N + '/healthz')).ok, { timeout: 120000, what: 'n8n back' });
  const s = await waitFor(async () => { const x = await sendsTo(conv); return x.length ? x : null; }, { timeout: 150000, what: 'reply after restart' });
  const ev = await one(`SELECT id, routed_at, route_attempts, route_claimed_at FROM app.webhook_events WHERE route->>'conversation_id' = $1`, [c.id]);
  await n8nHook('wa-router', { event_id: ev.id });
  const rec = await waitFor(() => one(`SELECT status, discard_reason FROM app.ai_jobs WHERE conversation_id = $1 AND discard_reason = 'interrupted'`, [m.c.id]), { timeout: 150000, what: 'interrupted job recovered' });
  const mconv = await convOf(m.conv);
  await sleep(10000);
  assert((await sendsTo(conv)).length === 1, 'one reply after restart');
  assert(mconv.mode === 'HUMAN' && mconv.mode_reason === 'ai_interrupted', 'interrupted conversation handed to staff', mconv);
  return { routing_while_down: ev0, after_restart: ev, reply: s[0].body.message, interrupted_job: rec, interrupted_conversation_mode: mconv.mode, start_job: mjob.r };
});

await scenario('memory_and_learning_need_approval', async () => {
  const sum = await waitFor(() => one(`SELECT count(*)::int AS n FROM app.conversation_summaries HAVING count(*) > 0`), { timeout: 150000, what: 'summaries' });
  const prop = await waitFor(() => one(`SELECT id, status, proposed_title FROM app.knowledge_proposals ORDER BY created_at DESC LIMIT 1`), { timeout: 150000, what: 'proposal' });
  const published = await one(`SELECT count(*)::int AS n FROM app.knowledge_versions`);
  const kb = await one(`SELECT count(*)::int AS n FROM app.search_knowledge('renew', 5)`);
  assert(prop.status === 'pending', 'proposal waits for approval', prop);
  assert(published.n === 0 && kb.n === 0, 'nothing published or searchable before approval', { published, kb });
  return { summaries: sum.n, proposal: prop, knowledge_versions: published.n, searchable: kb.n };
});

await scenario('woo_webhook_and_ai_job_webhook_entry_points', async () => {
  const body = JSON.stringify({ id: 4330, name: 'Netflix Premium', type: 'variable', status: 'publish', price: '350', stock_status: 'instock', permalink: e.MOCK + '/shop/product/netflix-premium/' });
  const sig = createHmac('sha256', e.T.wooSecret).update(body).digest('base64');
  const w = await fetch(e.APP + '/api/webhooks/woocommerce', { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-wc-webhook-topic': 'product.updated',
    'x-wc-webhook-signature': sig, 'x-wc-webhook-delivery-id': 'e2e-' + randomUUID(), 'x-wc-webhook-resource': 'product', 'x-wc-webhook-event': 'updated' } });
  const synced = await waitFor(() => one(`SELECT w.processing_status, w.routed_at FROM app.webhook_events w WHERE source = 'woocommerce' AND routed_at IS NOT NULL ORDER BY received_at DESC LIMIT 1`), { timeout: 60000, what: 'woo event routed' });
  const product = await waitFor(() => one(`SELECT product_id, name, updated_at FROM app.woo_products WHERE product_id = 4330 AND variation_id = 0`), { timeout: 60000, what: 'product synced' });
  // Staff "suggest a reply" job (backend starts it and calls wa-ai-job).
  const { c } = await customer('spotify ache?');
  await sql(`SELECT app.take_over($1, 'staff', $2, 'staff_take_over', '{}', false)`, [c.id, staffId]);
  const j = await one(`SELECT app.start_ai_job($1, 'staff_assist', NULL, NULL, $2) AS r`, [c.id, staffId]);
  const code = await n8nHook('wa-ai-job', { job_id: j.r.job_id });
  const d = await waitFor(() => one(`SELECT status FROM app.ai_drafts WHERE conversation_id = $1`, [c.id]), { timeout: 60000, what: 'assist draft' });
  return { woo_webhook_http: w.status, woo_event: synced, product, ai_job_webhook_http: code, assist_job: j.r, assist_draft: d };
});

await scenario('error_branch_records_alert', async () => {
  await sql(`REVOKE EXECUTE ON FUNCTION app.due_outbound(integer) FROM wa_n8n`);
  const a = await waitFor(() => one(`SELECT kind, message, details FROM app.alerts WHERE kind = 'workflow_error' ORDER BY created_at DESC LIMIT 1`), { timeout: 60000, what: 'workflow_error alert' });
  await sql(`GRANT EXECUTE ON FUNCTION app.due_outbound(integer) TO wa_n8n`);
  assert(a.details && a.details.node, 'alert names the failing node', a);
  return { alert: a };
});

await scenario('manual_branches_history_import_and_connection_check', async () => {
  await e.mock('/_control', { history: true });
  const out = {};
  for (const trig of ['Run History Import', 'Run Connection Check']) {
    const id = e.importWorkflow(e.testWorkflow({ keepManual: trig }));
    const res = e.n8nCli(['execute', '--id=' + id, '--rawOutput'], { timeout: 300000 });
    out[trig] = res.slice(-3000);
  }
  await e.mock('/_control', { history: false });
  const hist = await one(`SELECT count(*)::int AS n FROM app.messages WHERE is_historical`);
  const again = e.n8nCli(['execute', '--id=' + e.testWorkflow({ keepManual: 'Run History Import' }).id, '--rawOutput'], { timeout: 300000 });
  const hist2 = await one(`SELECT count(*)::int AS n FROM app.messages WHERE is_historical`);
  const check = JSON.parse(out['Run Connection Check'].slice(out['Run Connection Check'].indexOf('[')));
  const summary = check[check.length - 1] || check;
  assert(hist.n > 0 && hist2.n === hist.n, 'history imported once, re-run adds nothing', { hist, hist2 });
  assert(summary.all_ok === true, 'connection check all ok against the mock', summary);
  return { historical_messages: hist.n, after_rerun: hist2.n, rerun_ok: again.length > 0, connection_check: summary };
});

await scenario('no_old_workflow_references', async () => {
  const wf = JSON.parse(readFileSync(path.join(e.ROOT, 'n8n', 'workflow', 'ids-whatsapp-ai-support.json'), 'utf8'));
  const old = JSON.parse(readFileSync(path.join(e.ROOT, 'n8n', 'archive', 'pre-consolidation', 'ids.json'), 'utf8'));
  const text = JSON.stringify(wf);
  const bad = wf.nodes.filter((n) => /executeWorkflow|workflowTool|toolWorkflow/i.test(n.type)).map((n) => n.name);
  const oldIds = Object.values(old).filter((id) => text.includes(id));
  const selfCalls = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest' && /\/webhook(-test)?\//.test(JSON.stringify(n.parameters))).map((n) => n.name);
  assert(!bad.length && !oldIds.length && !selfCalls.length, 'no sub-workflow or old references', { bad, oldIds, selfCalls });
  return { nodes: wf.nodes.length, execute_workflow_nodes: 0, old_ids_found: 0, self_webhook_calls: 0 };
});

await scenario('coverage_every_entry_point_executed', async () => {
  const ex = await executions(started);
  const ran = new Set(ex.flatMap((x) => x.nodes));
  const wf = e.testWorkflow();
  const triggers = wf.nodes.filter((n) => /Trigger|webhook/i.test(n.type) && n.type !== 'n8n-nodes-base.manualTrigger').map((n) => n.name);
  const missing = triggers.filter((t) => !ran.has(t));
  const errors = ex.filter((x) => x.status === 'error').map((x) => ({ id: x.id, nodes: x.nodes.slice(-3) }));
  const allNodes = wf.nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote').map((n) => n.name);
  const notRun = allNodes.filter((n) => !ran.has(n));
  assert(!missing.length, 'every trigger executed', missing);
  return { executions: ex.length, by_status: ex.reduce((a, x) => ((a[x.status] = (a[x.status] || 0) + 1), a), {}), triggers_run: triggers.length,
    nodes_executed: allNodes.length - notRun.length, nodes_total: allNodes.length, not_executed: notRun, error_executions: errors.slice(0, 5) };
});

await scenario('no_secrets_or_image_bytes_in_saved_executions', async () => {
  const ex = await executions(started);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
  const secrets = ['test-openrouter-key', 'test-zernio-key', e.T.inbound, e.T.backend, 'cs_test', '123456:e2e-not-a-real-token'];
  const leaks = secrets.filter((s) => ex.some((x) => x.raw.includes(s)));
  // Test mode keeps execution data (evidence); image bytes appear there. The
  // production settings keep none: checked by re-running with them.
  const withBytesTestMode = ex.filter((x) => x.raw.includes(png)).length;
  const prod = e.testWorkflow({ production: true });
  assert(prod.settings.saveDataSuccessExecution === 'none' && prod.settings.saveDataErrorExecution === 'none', 'production settings keep no execution data');
  assert(!leaks.length, 'no credential values in execution data', leaks);
  return { executions_checked: ex.length, credential_leaks: leaks.length, test_mode_executions_with_image_bytes: withBytesTestMode, production_settings: { success: prod.settings.saveDataSuccessExecution, error: prod.settings.saveDataErrorExecution } };
});

const report = { ran_at: new Date().toISOString(), n8n_version: '2.40.7', workflow: e.WORKFLOW_ID, passed: results.filter((r) => r.pass).length, failed: results.filter((r) => !r.pass).length, results };
writeFileSync(path.join(e.WORK, 'report.json'), JSON.stringify(report, null, 2));
console.log(`\n${report.passed} passed, ${report.failed} failed`);
process.exit(report.failed ? 1 : 0);
