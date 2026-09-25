// End-to-end environment for the ONE workflow: a real n8n (local install, its
// own PostgreSQL database), the real Next.js backend, the application database
// (migrations + seed; n8n connects as the restricted wa_n8n role) and the HTTPS
// provider mock. Nothing here talks to real customers or real providers.
//
// Requirements: local PostgreSQL reachable as ADMIN_URL, a built Next app
// (npm run build), and n8n installed in N8N_DIR (npm install n8n).
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

export const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');
export const WORK = process.env.E2E_WORK || path.join(ROOT, '.e2e');
export const N8N_DIR = process.env.N8N_DIR || path.join(WORK, 'n8n');
// n8n 2.x needs Node >= 24; N8N_NODE points at that runtime (default: node on PATH).
export const N8N_NODE = process.env.N8N_NODE || 'node';
export const ADMIN_URL = process.env.E2E_ADMIN_URL || 'postgresql://dev:dev@localhost/postgres';
export const APP_DB = 'wa_e2e';
export const N8N_DB = 'n8n_e2e';
export const MOCK_PORT = 4443;
export const N8N_PORT = 5678;
export const APP_PORT = 3100;
export const MOCK = `https://127.0.0.1:${MOCK_PORT}`;
export const APP = `http://127.0.0.1:${APP_PORT}`;
export const N8N = `http://127.0.0.1:${N8N_PORT}`;
export const WORKFLOW_ID = 'IdsWaE2eSingleFlow01';
export const T = {
  zernioSecret: 'e2e-zernio-webhook-secret-0001',
  wooSecret: 'e2e-woo-webhook-secret-00001',
  inbound: 'e2e-inbound-token-backend-to-n8n-000001',
  backend: 'e2e-backend-token-n8n-to-backend-000001',
  encryption: 'e2e-n8n-encryption-key-0000000001',
};

const dbUrl = (name, user = 'dev', pw = 'dev') => { const u = new URL(ADMIN_URL); u.username = user; u.password = pw; u.pathname = '/' + name; return u.toString(); };
export const APP_URL = dbUrl(APP_DB);

export async function sql(q, params = [], url = APP_URL) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try { return (await c.query(q, params)).rows; } finally { await c.end(); }
}

export function certs() {
  mkdirSync(WORK, { recursive: true });
  const key = path.join(WORK, 'mock.key');
  const cert = path.join(WORK, 'mock.crt');
  if (!existsSync(cert)) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '7', '-subj', '/CN=127.0.0.1',
      '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  }
  return { key, cert };
}

export async function databases() {
  const a = new pg.Client({ connectionString: ADMIN_URL });
  await a.connect();
  for (const d of [APP_DB, N8N_DB]) {
    await a.query(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`);
    await a.query(`CREATE DATABASE ${d}`);
  }
  const r = await a.query(`SELECT 1 FROM pg_roles WHERE rolname = 'wa_n8n'`);
  if (!r.rowCount) await a.query(`CREATE ROLE wa_n8n LOGIN PASSWORD 'n8n'`);
  else await a.query(`ALTER ROLE wa_n8n LOGIN PASSWORD 'n8n'`);
  await a.end();
  await sql('CREATE EXTENSION IF NOT EXISTS citext; CREATE EXTENSION IF NOT EXISTS pg_trgm;');
  const env = { ...process.env, DATABASE_URL: APP_URL, WOO_BASE_URL: MOCK + '/shop', APP_ORIGIN: APP };
  execFileSync('node', ['scripts/migrate.mjs'], { cwd: ROOT, env, stdio: 'ignore' });
  execFileSync('node', ['scripts/seed.mjs'], { cwd: ROOT, env, stdio: 'ignore' });
  // Test shop and dashboard addresses; everything else keeps the seeded safe defaults.
  await sql(`UPDATE app.settings SET value = to_jsonb($1::text) WHERE key = 'shop_base_url'`, [MOCK + '/shop']);
  await sql(`UPDATE app.settings SET value = to_jsonb($1::text) WHERE key = 'dashboard_url'`, [APP]);
}

// The generated workflow with test-only changes: provider hosts point at the
// mock, credentials at local test credentials, execution data is kept (for
// evidence) unless `production` is set, and optionally long schedules run every
// minute so the scheduled branches execute during the test.
export function testWorkflow({ production = false, fastSchedules = true, keepManual = null } = {}) {
  const wf = JSON.parse(readFileSync(path.join(ROOT, 'n8n', 'workflow', 'ids-whatsapp-ai-support.json'), 'utf8'));
  const ids = { openrouter: 'e2eOpenRouter001', zernio: 'e2eZernio0000001', telegram: 'hC69Jo0AvNHRZ5PX', pg: 'e2ePostgres00001', woo: 'e2eWooCommerce01', hook: 'e2eInboundToken1', backend: 'e2eBackendToken1' };
  const credByName = Object.fromEntries(Object.entries(JSON.parse(readFileSync(path.join(ROOT, 'n8n', 'credentials.json'), 'utf8'))).filter(([k]) => k !== '_comment').map(([k, v]) => [v.name, ids[k]]));
  for (const n of wf.nodes) {
    for (const c of Object.values(n.credentials || {})) c.id = credByName[c.name] || c.id;
    if (n.type === 'n8n-nodes-base.httpRequest' && typeof n.parameters.url === 'string') {
      n.parameters.url = n.parameters.url.split('https://zernio.com/api').join(MOCK + '/zernio/api')
        .split('https://openrouter.ai/api').join(MOCK + '/openrouter/api')
        .split('https://infinitydigitalshop.com').join(MOCK + '/shop');
    }
    if (n.name === 'Download Media') n.parameters.url = "={{ $json.blocked ? '' : $json.url.replace('https://zernio.com/api', '" + MOCK + "/zernio/api') }}";
    if (fastSchedules && n.type === 'n8n-nodes-base.scheduleTrigger' && !['Every 15 Seconds', 'Every Minute'].includes(n.name)) {
      n.parameters.rule = { interval: [{ field: 'minutes', minutesInterval: 1 }] };
    }
  }
  if (keepManual) wf.nodes = wf.nodes.filter((n) => n.type !== 'n8n-nodes-base.manualTrigger' || n.name === keepManual);
  if (!production) Object.assign(wf.settings, { saveDataSuccessExecution: 'all', saveDataErrorExecution: 'all' });
  wf.id = keepManual ? WORKFLOW_ID.slice(0, 16) + keepManual.replace(/\W/g, '').slice(0, 4) : WORKFLOW_ID;
  if (keepManual) { wf.name += ' (manual test copy)'; wf.nodes = wf.nodes.filter((n) => n.type !== 'n8n-nodes-base.webhook' && n.type !== 'n8n-nodes-base.scheduleTrigger'); }
  const names = new Set(wf.nodes.map((n) => n.name));
  for (const k of Object.keys(wf.connections)) if (!names.has(k)) delete wf.connections[k];
  // The workflow is its own error workflow (section 14), as configured on the instance.
  wf.settings.errorWorkflow = wf.id;
  wf.active = false;
  return wf;
}

export function credentials() {
  return [
    { id: 'e2eOpenRouter001', name: 'IDS WA · OpenRouter', type: 'httpHeaderAuth', data: { name: 'Authorization', value: 'Bearer test-openrouter-key' } },
    { id: 'e2eZernio0000001', name: 'IDS WA · Zernio', type: 'httpHeaderAuth', data: { name: 'Authorization', value: 'Bearer test-zernio-key' } },
    { id: 'hC69Jo0AvNHRZ5PX', name: 'Telegram account', type: 'telegramApi', data: { accessToken: '123456:e2e-not-a-real-token' } },
    { id: 'e2ePostgres00001', name: 'IDS WA · Postgres (wa_n8n)', type: 'postgres',
      data: { host: new URL(ADMIN_URL).hostname, port: 5432, database: APP_DB, user: 'wa_n8n', password: 'n8n', ssl: 'disable', allowUnauthorizedCerts: false } },
    { id: 'e2eWooCommerce01', name: 'IDS WA · WooCommerce (read-only)', type: 'wooCommerceApi', data: { url: MOCK + '/shop', consumerKey: 'ck_test', consumerSecret: 'cs_test', includeCredentialsInQuery: false } },
    { id: 'e2eInboundToken1', name: 'IDS WA · Inbound token (backend to n8n)', type: 'httpHeaderAuth', data: { name: 'Authorization', value: 'Bearer ' + T.inbound } },
    { id: 'e2eBackendToken1', name: 'IDS WA · Backend token (n8n to backend)', type: 'httpHeaderAuth', data: { name: 'X-Internal-Token', value: T.backend } },
  ];
}

export function n8nEnv() {
  const u = new URL(ADMIN_URL);
  return {
    ...process.env,
    N8N_USER_FOLDER: path.join(WORK, 'n8n-home'),
    N8N_PORT: String(N8N_PORT), N8N_LISTEN_ADDRESS: '127.0.0.1', WEBHOOK_URL: N8N + '/',
    N8N_ENCRYPTION_KEY: T.encryption,
    DB_TYPE: 'postgresdb', DB_POSTGRESDB_HOST: u.hostname, DB_POSTGRESDB_PORT: '5432', DB_POSTGRESDB_DATABASE: N8N_DB,
    DB_POSTGRESDB_USER: decodeURIComponent(u.username), DB_POSTGRESDB_PASSWORD: decodeURIComponent(u.password),
    GENERIC_TIMEZONE: 'Asia/Dhaka', N8N_DIAGNOSTICS_ENABLED: 'false', N8N_VERSION_NOTIFICATIONS_ENABLED: 'false', N8N_PERSONALIZATION_ENABLED: 'false',
    N8N_RUNNERS_ENABLED: 'true', N8N_BLOCK_ENV_ACCESS_IN_NODE: 'true', N8N_SECURE_COOKIE: 'false',
    // The mock uses a self-signed certificate.
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    PATH: path.dirname(N8N_NODE === 'node' ? process.execPath : N8N_NODE) + path.delimiter + process.env.PATH,
  };
}

const n8nBin = () => path.join(N8N_DIR, 'node_modules', 'n8n', 'bin', 'n8n');

export function n8nCli(args, opts = {}) {
  return execFileSync(N8N_NODE, [n8nBin(), ...args], { env: n8nEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: opts.timeout || 240000 });
}

export function importWorkflow(wf) {
  const f = path.join(WORK, 'wf-' + wf.id + '.json');
  writeFileSync(f, JSON.stringify(wf));
  n8nCli(['import:workflow', '--input=' + f]);
  return wf.id;
}

export async function setupN8n({ production = false } = {}) {
  mkdirSync(path.join(WORK, 'n8n-home'), { recursive: true });
  const cf = path.join(WORK, 'credentials.json');
  writeFileSync(cf, JSON.stringify(credentials()));
  n8nCli(['import:credentials', '--input=' + cf]);
  importWorkflow(testWorkflow({ production }));
  n8nCli(['publish:workflow', '--id=' + WORKFLOW_ID]);
}

export function startProcess(name, cmd, args, env, cwd = ROOT) {
  const fd = openSync(path.join(WORK, name + '.log'), 'a');
  const p = spawn(cmd, args, { cwd, env, stdio: ['ignore', fd, fd], detached: true });
  p.unref();
  return p;
}

export async function waitFor(fn, { timeout = 60000, every = 500, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, every));
  }
  throw new Error('timed out waiting for ' + what + (last instanceof Error ? ': ' + last.message : ''));
}

// Stops every process a previous run started (n8n and its task runner, the
// backend — Next renames itself "next-server" — and the mock).
export async function stopAll() {
  const out = execFileSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' });
  const pids = out.split('\n').filter((l) => /n8n\/bin\/n8n start|next-server|\.next\/standalone\/server\.js|tests\/e2e\/mock-providers\.mjs|@n8n\/task-runner|task-runner\/dist/.test(l))
    .map((l) => Number(l.trim().split(/\s+/)[0])).filter((p) => p && p !== process.pid);
  for (const p of pids) { try { process.kill(p, 'SIGTERM'); } catch { /* gone */ } }
  await waitFor(async () => {
    for (const url of [N8N + '/healthz', APP + '/api/health']) { try { await fetch(url); return false; } catch { /* closed */ } }
    return true;
  }, { timeout: 60000, what: 'ports free' });
}

export function startN8n() {
  return startProcess('n8n', N8N_NODE, [n8nBin(), 'start'], n8nEnv(), N8N_DIR);
}

export function startApp() {
  // The production build is standalone (as in the Dockerfile).
  return startProcess('app', 'node', [path.join(ROOT, '.next', 'standalone', 'server.js')], {
    ...process.env, NODE_ENV: 'production', PORT: String(APP_PORT), HOSTNAME: '127.0.0.1', DATABASE_URL: APP_URL, APP_ORIGIN: APP, COOKIE_SECURE: 'false',
    ZERNIO_WEBHOOK_SECRET: T.zernioSecret, WOO_WEBHOOK_SECRET: T.wooSecret,
    N8N_WEBHOOK_BASE: N8N + '/webhook', N8N_INTERNAL_TOKEN: T.inbound, BACKEND_INTERNAL_TOKEN: T.backend,
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
  });
}

export function startMockProcess() {
  const { key, cert } = certs();
  return startProcess('mock', 'node', [path.join(ROOT, 'tests', 'e2e', 'mock-providers.mjs'), String(MOCK_PORT), key, cert], process.env);
}

// The mock's certificate is self-signed; run.mjs sets NODE_TLS_REJECT_UNAUTHORIZED=0.
export async function mock(pathName, body) {
  const r = await fetch(MOCK + pathName, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
}
