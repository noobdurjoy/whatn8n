// Single source of truth for the ONE n8n workflow of this system:
//   "Infinity Digital Shop — WhatsApp AI Support"
//
//   node n8n/workflow.mjs             writes n8n/workflow/ids-whatsapp-ai-support.json
//                                     (importable) and n8n/workflow/code-nodes.json
//   node n8n/workflow.mjs --sdk DIR   also writes Workflow-SDK code (full and
//                                     with stubbed Code nodes) and one
//                                     setNodeParameter op per Code node, used to
//                                     create/update it through the n8n MCP server
//
// Everything runs inside this one workflow: no sub-workflows, no Execute
// Workflow or workflow-tool nodes, no separate error workflow, no calls to its
// own webhooks. Where the old design called a sub-workflow once per item, a
// "Loop Over Items" node (batch size 1) now walks the items through a shared
// branch, and every path of that branch returns to the loop.
//
// Code nodes get their JavaScript from n8n/code/dist (see n8n/build.mjs).
// Credential ids of the live instance are in n8n/credentials.json.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { buildAll } from './build.mjs';

const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
export const outDir = path.join(root, 'n8n', 'workflow');
export const WORKFLOW_NAME = 'Infinity Digital Shop — WhatsApp AI Support';
export const WORKFLOW_FILE = 'ids-whatsapp-ai-support.json';

const ZERNIO = 'https://zernio.com/api';
const OPENROUTER = 'https://openrouter.ai/api/v1/chat/completions';
const SHOP = 'https://infinitydigitalshop.com';
const UUID = '0b7c5a4e-1111-4222-8333-944444444444';

let dist = {};
let CRED = {};

// ---------------------------------------------------------------------------
// Node helpers
// ---------------------------------------------------------------------------
const cred = (key) => { const c = CRED[key]; return { [c.type]: c.id ? { id: c.id, name: c.name } : { id: null, name: c.name } }; };
const stableId = (s) => { const h = createHash('sha256').update(s).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };

function code(name, file) {
  if (!dist[file]) throw new Error('missing dist file ' + file);
  return { name, type: 'n8n-nodes-base.code', version: 2, parameters: { jsCode: dist[file] }, codeFile: file };
}
// Every query takes one JSON parameter ($1::jsonb) built by one expression,
// so values with commas or quotes can never split into extra parameters.
function pg(name, query, json, extra = {}) {
  return {
    name, type: 'n8n-nodes-base.postgres', version: 2.6,
    parameters: { operation: 'executeQuery', query, options: json ? { queryReplacement: '={{ JSON.stringify(' + json + ') }}' } : {} },
    credentials: cred('pg'), sample: extra.sample, ...pick(extra),
  };
}
function pick(extra) {
  const o = {};
  for (const k of ['onError', 'executeOnce', 'alwaysOutputData', 'retryOnFail', 'maxTries', 'waitBetweenTries']) if (k in extra) o[k] = extra[k];
  return o;
}
function http(name, p, extra = {}) {
  const parameters = { method: p.method || 'GET', url: p.url };
  if (p.auth) { parameters.authentication = 'genericCredentialType'; parameters.genericAuthType = CRED[p.auth].type; }
  if (p.query) { parameters.sendQuery = true; parameters.queryParameters = { parameters: p.query.map(([n, v]) => ({ name: n, value: v })) }; }
  if (p.headers) { parameters.sendHeaders = true; parameters.headerParameters = { parameters: p.headers.map(([n, v]) => ({ name: n, value: v })) }; }
  if (p.json) { parameters.sendBody = true; parameters.contentType = 'json'; parameters.specifyBody = 'json'; parameters.jsonBody = p.json; }
  if (p.binary) { parameters.sendBody = true; parameters.contentType = 'binaryData'; parameters.inputDataFieldName = 'data'; }
  const options = { timeout: p.timeout || 30000 };
  options.response = { response: { fullResponse: Boolean(p.full), neverError: true, ...(p.file ? { responseFormat: 'file' } : {}) } };
  if (p.pagination) options.pagination = { pagination: p.pagination };
  parameters.options = options;
  return {
    name, type: 'n8n-nodes-base.httpRequest', version: 4.2, parameters,
    ...(p.auth ? { credentials: cred(p.auth) } : {}),
    onError: 'continueRegularOutput', ...pick(extra),
  };
}
function model(name, requestExpr, timeout) {
  return http(name, { method: 'POST', url: OPENROUTER, auth: 'openrouter', headers: [['X-Title', 'IDS WhatsApp Support']], json: '={{ JSON.stringify(' + requestExpr + ') }}', timeout: timeout || 120000 });
}
const cond = (left, op, right) => {
  const c = { leftValue: left, operator: op };
  if (right !== undefined) c.rightValue = right;
  return { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, conditions: [c], combinator: 'and' };
};
const isTrue = (left) => cond(left, { type: 'boolean', operation: 'true', singleValue: true });
const isFalse = (left) => cond(left, { type: 'boolean', operation: 'false', singleValue: true });
const eq = (left, right) => cond(left, { type: 'string', operation: 'equals' }, right);
function ifNode(name, conditions) {
  return { name, type: 'n8n-nodes-base.if', version: 2.2, parameters: { conditions, options: {} } };
}
// outputs: [[key, conditions], ...]
function switchNode(name, outputs, all = false) {
  return {
    name, type: 'n8n-nodes-base.switch', version: 3.2,
    parameters: { rules: { values: outputs.map(([k, c]) => ({ outputKey: k, renameOutput: true, conditions: c })) }, options: all ? { allMatchingOutputs: true } : {} },
  };
}
const routeSwitch = (name, keys, field = '$json.route') => switchNode(name, keys.map((k) => [k, eq('={{ ' + field + ' }}', k)]));
// Loop Over Items, one item per iteration. Output 0 = done, 1 = next item.
// `reset` starts a new set whenever the input does not come from the loop's
// own return path, so a second feeder in the same execution starts cleanly.
const loop = (name, returnFrom) => ({
  name, type: 'n8n-nodes-base.splitInBatches', version: 3,
  parameters: { batchSize: 1, options: { reset: '={{ ' + JSON.stringify(returnFrom) + '.indexOf($prevNode.name) < 0 }}' } },
});
const webhook = (name, pathName) => ({
  name, type: 'n8n-nodes-base.webhook', version: 2,
  parameters: { httpMethod: 'POST', path: pathName, authentication: 'headerAuth', responseMode: 'onReceived', options: { noResponseBody: false } },
  credentials: cred('hook'), trigger: true, webhookId: stableId('ids-wa-webhook:' + pathName),
});
const schedule = (name, interval) => ({ name, type: 'n8n-nodes-base.scheduleTrigger', version: 1.2, parameters: { rule: { interval: [interval] } }, trigger: true });
const manual = (name) => ({ name, type: 'n8n-nodes-base.manualTrigger', version: 1, parameters: {}, trigger: true });
const noop = (name) => ({ name, type: 'n8n-nodes-base.noOp', version: 1, parameters: {} });
const setRaw = (name, jsonExpr) => ({ name, type: 'n8n-nodes-base.set', version: 3.4, parameters: { mode: 'raw', jsonOutput: '={{ JSON.stringify(' + jsonExpr + ') }}', options: {} } });

const jsonParam = () => '(SELECT $1::jsonb AS p) x';

// ---------------------------------------------------------------------------
// The workflow, as canvas sections. Each section: { key, title, note, color,
// nodes, edges }. edges: [from, outputIndex, to, inputIndex?]; an edge may
// point into another section (e.g. every sending path into "Dispatch Queue").
// ---------------------------------------------------------------------------
function sections() {
  const S = [];

  // 1 -------------------------------------------------------------------------
  const plan = "$('Plan Route').first().json";
  S.push({
    key: 'intake', color: 4,
    title: '1 · Event intake & routing',
    note: 'Backend verified the Zernio signature, stored the event, resolved customer identity, saved the message, dropped duplicate events and ran human-request detection (one transaction), then calls this webhook with the event id. Here the event is **claimed once** (a re-delivery stops at "Valid?") and routed on the stored decision plus the conversation\'s **current mode** from PostgreSQL.',
    nodes: [
      webhook('Router Webhook', 'wa-router'),
      pg('Claim Event', `SELECT app.claim_event_route((p->>'id')::uuid) AS c FROM ${jsonParam()} WHERE p->>'id' ~* '^[0-9a-f-]{36}$'`,
        '{ id: $json.body && $json.body.event_id }', { alwaysOutputData: true, sample: { id: UUID } }),
      code('Plan Route', 'a_plan.js'),
      ifNode('Valid?', isTrue('={{ $json.valid }}')),
      noop('Duplicate Or Nothing To Do'),
      ifNode('Has Media?', isTrue('={{ $json.has_media }}')),
      ifNode('From Router?', isTrue("={{ $('Plan Route').isExecuted }}")),
      switchNode('Route Actions', [
        ['ai_reply', isTrue('={{ ' + plan + '.ai }}')],
        ['handoff_ack', isTrue('={{ ' + plan + '.dispatch }}')],
        ['notify_staff', isTrue('={{ ' + plan + '.notify }}')],
      ], true),
      setRaw('AI Input', plan + '.ai_input'),
      pg('Queued Acknowledgement', `SELECT o.id AS outbound_id FROM ${jsonParam()}, app.outbound_messages o
       WHERE o.conversation_id = (p->>'c')::uuid AND o.status = 'queued' ORDER BY o.created_at LIMIT 5`, '{ c: ' + plan + '.conversation_id }', { executeOnce: true, sample: { c: UUID } }),
      setRaw('Notify Input', plan + '.notify_input'),
    ],
    edges: [['Router Webhook', 0, 'Claim Event'], ['Claim Event', 0, 'Plan Route'], ['Plan Route', 0, 'Valid?'],
      ['Valid?', 0, 'Has Media?'], ['Valid?', 1, 'Duplicate Or Nothing To Do'],
      // Media first, strictly in sequence: the AI branch must see the stored image.
      ['Has Media?', 0, 'Media Request'], ['Has Media?', 1, 'Route Actions'], ['Media Done', 0, 'From Router?'], ['From Router?', 0, 'Route Actions'],
      ['Route Actions', 0, 'AI Input'], ['AI Input', 0, 'Reply Request'],
      ['Route Actions', 1, 'Queued Acknowledgement'], ['Queued Acknowledgement', 0, 'Dispatch Queue'],
      ['Route Actions', 2, 'Notify Input'], ['Notify Input', 0, 'Notify Request']],
  });

  // 2 -------------------------------------------------------------------------
  S.push({
    key: 'media', color: 5,
    title: '2 · Customer media download',
    note: 'Downloads customer attachments only from Zernio\'s authenticated media endpoint (host zernio.com, https, /api/v1/) — never from URLs inside messages. Type and size are checked and the bytes are stored in PostgreSQL in one call. Runs **before** routing (strictly in sequence) so the AI branch sees the stored image; also re-run by maintenance for pending media.',
    nodes: [
      setRaw('Media Request', '{ attachment_ids: $json.media || $json.attachment_ids || [] }'),
      pg('Load Pending', `SELECT app.pending_attachments(ARRAY(SELECT jsonb_array_elements_text(coalesce(p->'ids', '[]')))::uuid[]) AS list,
       app.setting('attachments') AS cfg FROM ${jsonParam()}`, '{ ids: $json.attachment_ids || [] }', { executeOnce: true, sample: { ids: [UUID] } }),
      code('Plan Downloads', 'a2_plan.js'),
      http('Download Media', { url: "={{ $json.blocked ? '' : $json.url }}", auth: 'zernio', full: true, file: true, timeout: 30000 }),
      code('Check Download', 'a2_check.js'),
      pg('Save Downloads', `WITH d AS (SELECT e FROM ${jsonParam()}, jsonb_array_elements(coalesce(p->'downloads', '[]')) e),
         s AS (SELECT app.store_attachment_blob((e->>'attachment_id')::uuid, e->>'mime', e->>'data_base64', (e->>'max_bytes')::int,
                 ARRAY(SELECT jsonb_array_elements_text(e->'allowed'))) AS r FROM d WHERE (e->>'ok')::boolean),
         f AS (SELECT app.mark_attachment_fetch_failed((e->>'attachment_id')::uuid, e->>'status', e->>'error') AS r FROM d WHERE NOT (e->>'ok')::boolean)
       SELECT (SELECT count(*) FROM s) AS stored, (SELECT count(*) FROM f) AS failed`, '$json',
        { sample: { downloads: [{ ok: true, attachment_id: UUID, mime: 'image/png', data_base64: 'iVBORw0KGgo=', max_bytes: 100, allowed: ['image/png'] }, { ok: false, attachment_id: UUID, status: 'expired', error: 'http_400' }] } }),
      ifNode('Anything To Download?', isFalse('={{ Boolean($json.skip) }}')),
      { ...noop('Media Done'), executeOnce: true },
    ],
    edges: [['Media Request', 0, 'Load Pending'], ['Load Pending', 0, 'Plan Downloads'], ['Plan Downloads', 0, 'Anything To Download?'],
      ['Anything To Download?', 0, 'Download Media'], ['Anything To Download?', 1, 'Media Done'],
      ['Download Media', 0, 'Check Download'], ['Check Download', 0, 'Save Downloads'], ['Save Downloads', 0, 'Media Done']],
  });

  // 3 -------------------------------------------------------------------------
  const next3 = (n) => routeSwitch(n, ['tools', 'validate', 'fail'], '$json.next');
  S.push({
    key: 'reply', color: 6,
    title: '3 · AI reply (DeepSeek via OpenRouter)',
    note: 'Burst debounce, then **start_ai_job** records mode_version + revision. Scoped, redacted context; allow-listed tools only (up to 3 model rounds + 1 repair). Output is validated server-side and submitted with **submit_ai_result**, which discards it if the mode, a takeover or a newer customer message changed anything. AUTO → outbox, COPILOT → draft, otherwise handoff. Staff-assist and sandbox jobs enter at "AI Job Webhook".',
    nodes: [
      noop('Reply Request'),
      webhook('AI Job Webhook', 'wa-ai-job'),
      pg('Load Debounce', "SELECT least(greatest(coalesce((app.setting('burst_debounce_seconds') #>> '{}')::int, 6), 0), 30) AS wait", null),
      { name: 'Burst Wait', type: 'n8n-nodes-base.wait', version: 1.1, parameters: { resume: 'timeInterval', amount: '={{ $json.wait }}', unit: 'seconds' } },
      pg('Start Job', `SELECT app.start_ai_job((p->>'conversation_id')::uuid, 'reply', (p->>'message_id')::uuid, (p->>'revision')::bigint, NULL) AS r FROM ${jsonParam()}`,
        "$('Reply Request').first().json", { sample: { conversation_id: UUID, message_id: UUID, revision: 1 } }),
      code('Resolve Job', 'b_resolve_job.js'),
      pg('Load Context', `SELECT jsonb_build_object(
         'ctx', app.get_ai_context(q.j, 20),
         'settings', (SELECT jsonb_object_agg(key, value) FROM app.settings WHERE key IN ('shop_name', 'models', 'vision', 'escalation_rules', 'business_hours')),
         'prompt', (SELECT pv.body FROM app.ai_jobs aj JOIN app.prompt_versions pv ON pv.id = aj.prompt_version_id WHERE aj.id = q.j),
         'budget', app.ai_budget_status(),
         'job_status', (SELECT status FROM app.ai_jobs WHERE id = q.j)) AS d
       FROM (SELECT (p->>'job_id')::uuid AS j FROM ${jsonParam()}) q`, '{ job_id: $json.job_id }', { sample: { job_id: UUID } }),
      code('Prepare Turn', 'b_prepare_turn.js'),
      ifNode('Ready?', isTrue('={{ $json.ready }}')),
      pg('Fail Job', `SELECT app.fail_ai_job((p->>'job_id')::uuid, coalesce(p->>'reason', 'failed')) AS ok FROM ${jsonParam()} WHERE p->>'job_id' IS NOT NULL`,
        '{ job_id: $json.job_id || ($json.state && $json.state.job_id), reason: $json.reason || $json.failure }', { sample: { job_id: UUID, reason: 'x' } }),
      model('R1 Call Model', '$json.state.request'),
      code('R1 Parse Response', 'b_parse_response.R1.js'),
      next3('R1 Next'),
      code('R1 Split Tool Calls', 'b_split_tool_calls.R1.js'),
      code('R1 Collect Tool Results', 'b_collect_tool_results.R1.js'),
      model('R2 Call Model', '$json.state.request'),
      code('R2 Parse Response', 'b_parse_response.R2.js'),
      next3('R2 Next'),
      code('R2 Split Tool Calls', 'b_split_tool_calls.R2.js'),
      code('R2 Collect Tool Results', 'b_collect_tool_results.R2.js'),
      model('R3 Call Model', '$json.state.request'),
      code('R3 Parse Response', 'b_parse_response.R3.js'),
      code('Validate & Decide', 'b_validate_decide.js'),
      routeSwitch('Decision', ['repair', 'submit', 'fail'], '$json.next'),
      code('Build Repair Request', 'b_build_repair.js'),
      model('R4 Call Model', '$json.state.request'),
      code('R4 Parse Response', 'b_parse_response.R4.js'),
      pg('Submit Result', `SELECT app.submit_ai_result((s->>'job_id')::uuid, s->>'decision', s->>'reply_text', nullif(s->>'handoff_reason', ''), s->'references', s->'result') AS r,
         (SELECT conversation_id FROM app.ai_jobs WHERE id = (s->>'job_id')::uuid) AS conversation_id, nullif(s->>'handoff_reason', '') AS handoff_reason
       FROM (SELECT $1::jsonb->'submit' AS s) x`, '$json', { sample: { submit: { job_id: UUID, decision: 'no_reply', references: [], result: {} } } }),
      pg('Record Usage', `SELECT count(app.record_ai_usage((p->>'job_id')::uuid, coalesce(u->>'purpose', 'reply'), u)) AS recorded
       FROM ${jsonParam()}, jsonb_array_elements(coalesce(p->'usage', '[]')) u`, '{ job_id: $json.job_id, usage: $json.usage }', { sample: { job_id: UUID, usage: [] } }),
      pg('Fail Invalid Job', `SELECT app.fail_ai_job((p->>'job_id')::uuid, p->>'failure') AS ok FROM ${jsonParam()}`, '{ job_id: $json.job_id, failure: $json.failure }', { sample: { job_id: UUID, failure: 'x' } }),
      code('After Submit', 'b_after_submit.js'),
      routeSwitch('Follow Up', ['dispatch', 'notify'], '$json.kind'),
    ],
    edges: [
      ['Reply Request', 0, 'Load Debounce'], ['Load Debounce', 0, 'Burst Wait'], ['Burst Wait', 0, 'Start Job'], ['Start Job', 0, 'Resolve Job'],
      ['AI Job Webhook', 0, 'Resolve Job'], ['Resolve Job', 0, 'Load Context'], ['Load Context', 0, 'Prepare Turn'], ['Prepare Turn', 0, 'Ready?'],
      ['Ready?', 0, 'R1 Call Model'], ['Ready?', 1, 'Fail Job'],
      ['R1 Call Model', 0, 'R1 Parse Response'], ['R1 Parse Response', 0, 'R1 Next'],
      ['R1 Next', 0, 'R1 Split Tool Calls'], ['R1 Next', 1, 'Validate & Decide'], ['R1 Next', 2, 'Validate & Decide'],
      ['R1 Split Tool Calls', 0, 'R1 Tools Loop'], ['R1 Tools Loop', 0, 'R1 Collect Tool Results'], ['R1 Collect Tool Results', 0, 'R2 Call Model'],
      ['R2 Call Model', 0, 'R2 Parse Response'], ['R2 Parse Response', 0, 'R2 Next'],
      ['R2 Next', 0, 'R2 Split Tool Calls'], ['R2 Next', 1, 'Validate & Decide'], ['R2 Next', 2, 'Validate & Decide'],
      ['R2 Split Tool Calls', 0, 'R2 Tools Loop'], ['R2 Tools Loop', 0, 'R2 Collect Tool Results'], ['R2 Collect Tool Results', 0, 'R3 Call Model'],
      ['R3 Call Model', 0, 'R3 Parse Response'], ['R3 Parse Response', 0, 'Validate & Decide'],
      ['Validate & Decide', 0, 'Decision'],
      ['Decision', 0, 'Build Repair Request'], ['Build Repair Request', 0, 'R4 Call Model'], ['R4 Call Model', 0, 'R4 Parse Response'], ['R4 Parse Response', 0, 'Validate & Decide'],
      ['Decision', 1, 'Submit Result'], ['Decision', 1, 'Record Usage'], ['Decision', 2, 'Fail Invalid Job'], ['Decision', 2, 'Record Usage'],
      ['Submit Result', 0, 'After Submit'], ['After Submit', 0, 'Follow Up'], ['Follow Up', 0, 'Dispatch Queue'], ['Follow Up', 1, 'Notify Request'],
    ],
  });

  // 4 -------------------------------------------------------------------------
  S.push({
    key: 'tools', color: 3,
    title: '4 · AI tool calls (allow-listed)',
    note: 'One tool call per loop iteration. Arguments are validated again ("Check Tool Call"); the model gets no SQL, no arbitrary HTTP and no credentials. Knowledge search reads **approved** knowledge only. "Tool Return" sends each result back to the loop of the round that asked for it.',
    nodes: [
      loop('R1 Tools Loop', ['Tool Return']),
      loop('R2 Tools Loop', ['Tool Return']),
      noop('Tool Call'),
      code('Check Tool Call', 't_check_call.js'),
      routeSwitch('Tool Route', ['knowledge', 'image', 'woo', 'invalid']),
      pg('Search Knowledge', `SELECT k.* FROM ${jsonParam()}, app.search_knowledge(p->>'q', 5) k`, '{ q: $json.args.query }', { alwaysOutputData: true, sample: { q: 'refund' } }),
      code('Format knowledge Result', 't_format_results.knowledge.js'),
      code('Format image Result', 't_format_results.image.js'),
      code('Format woo Result', 't_format_results.woo.js'),
      code('Format invalid Result', 't_format_results.invalid.js'),
      switchNode('Tool Return', [['R1', eq("={{ $('Tool Call').first().json.round }}", 'R1')], ['R2', eq("={{ $('Tool Call').first().json.round }}", 'R2')]]),
    ],
    edges: [['R1 Tools Loop', 1, 'Tool Call'], ['R2 Tools Loop', 1, 'Tool Call'], ['Tool Call', 0, 'Check Tool Call'], ['Check Tool Call', 0, 'Tool Route'],
      ['Tool Route', 0, 'Search Knowledge'], ['Search Knowledge', 0, 'Format knowledge Result'],
      ['Tool Route', 1, 'Image Request'], ['Vision Output', 0, 'Format image Result'],
      ['Tool Route', 2, 'Woo Tool Request'],
      ['Format search', 0, 'Format woo Result'], ['Format details', 0, 'Format woo Result'], ['Format checkout', 0, 'Format woo Result'],
      ['Format Proposal', 0, 'Format woo Result'], ['Return Order Result', 0, 'Format woo Result'],
      ['Tool Route', 3, 'Format invalid Result'],
      ['Format knowledge Result', 0, 'Tool Return'], ['Format image Result', 0, 'Tool Return'], ['Format woo Result', 0, 'Tool Return'], ['Format invalid Result', 0, 'Tool Return'],
      ['Tool Return', 0, 'R1 Tools Loop'], ['Tool Return', 1, 'R2 Tools Loop']],
  });

  // 5 -------------------------------------------------------------------------
  S.push({
    key: 'vision', color: 7,
    title: '5 · Image analysis (Qwen qwen/qwen3.7-flash)',
    note: 'The customer\'s actual attachment is read from PostgreSQL and sent with the customer\'s question as a base64 data URL (no provider URL, filename or credential in the prompt). The result is validated JSON observations only — the vision model never sends messages or changes orders, and a payment screenshot is never proof of payment. Stale jobs are not called; same image + model + prompt is reused. Not run in HUMAN mode unless staff asked for assistance.',
    nodes: [
      noop('Image Request'),
      pg('Load Image', `SELECT app.ai_job_is_current(q.j) AS cur, app.setting('vision') AS vision, app.setting('models') AS models,
         (SELECT body FROM app.prompt_versions WHERE name = 'vision_system' AND status = 'published') AS prompt,
         app.ai_budget_status() AS budget,
         app.find_image_analysis(q.a, app.setting('models') ->> 'vision_model', coalesce(app.setting('vision') ->> 'prompt_version', 'vision-v1')) AS reuse,
         (SELECT to_jsonb(t) FROM app.get_attachment_for_job(q.j, q.a) t) AS att
       FROM (SELECT (p->>'job_id')::uuid AS j, (p->>'attachment_id')::uuid AS a FROM ${jsonParam()}) q`,
        '{ job_id: $json.job_id, attachment_id: $json.args && $json.args.attachment_id }', { sample: { job_id: UUID, attachment_id: UUID } }),
      code('Prepare Vision Request', 'v_prepare.js'),
      routeSwitch('Vision Route', ['call', 'done']),
      model('Call Vision Model', '$json.request', 90000),
      code('Validate Vision Result', 'v_validate.js'),
      pg('Store Analysis', `WITH v AS (SELECT $1::jsonb AS v), u AS (SELECT app.record_ai_usage((v->'meta'->>'job_id')::uuid, 'vision', v->'usage') AS id FROM v)
       SELECT app.store_image_analysis((v->'meta'->>'job_id')::uuid, (v->'meta'->>'attachment_id')::uuid, v->'meta'->>'model', v->'meta'->>'prompt_version',
                v->'meta'->>'question', v->>'status', nullif(v->'result', 'null'::jsonb), v->>'error', (SELECT id FROM u)) AS analysis_id,
              app.ai_job_is_current((v->'meta'->>'job_id')::uuid) AS cur
       FROM v`, '$json', { sample: { status: 'failed', meta: { job_id: UUID, attachment_id: UUID, model: 'm', prompt_version: 'v' }, usage: {} } }),
      code('Vision Output', 'v_output.js'),
    ],
    edges: [['Image Request', 0, 'Load Image'], ['Load Image', 0, 'Prepare Vision Request'], ['Prepare Vision Request', 0, 'Vision Route'],
      ['Vision Route', 0, 'Call Vision Model'], ['Call Vision Model', 0, 'Validate Vision Result'], ['Validate Vision Result', 0, 'Store Analysis'],
      ['Store Analysis', 0, 'Vision Output'], ['Vision Route', 1, 'Vision Output']],
  });

  // 6 -------------------------------------------------------------------------
  const shop = "$('Load Shop').first().json.base";
  const args = "$('Woo Tool Request').first().json.args";
  const store = (p) => '={{ ' + shop + " }}/wp-json/wc/store/v1/products" + p;
  S.push({
    key: 'woo', color: 2,
    title: '6 · WooCommerce tools (source of truth)',
    note: 'Live prices, variations and stock from the Store API; checkout links use WooCommerce\'s own add-to-cart URL for the exact variation (hosted checkout — no order or payment in chat). **Private order data only after ownership is verified** (linked order, or billing phone = the WhatsApp number); an order number alone is never enough. Refunds, cancellations and address changes are only **recorded for staff**: staff approve them and carry them out in WooCommerce — nothing here changes an order.',
    nodes: [
      noop('Woo Tool Request'),
      pg('Load Shop', `SELECT app.setting('shop_base_url') #>> '{}' AS base,
       app.order_access_for_job((p->>'job_id')::uuid, nullif(p->>'order_id', '')::bigint) AS access FROM ${jsonParam()}`,
        '{ job_id: $json.job_id, order_id: ($json.args && $json.args.order_id) || null }', { sample: { job_id: UUID, order_id: 1 } }),
      routeSwitch('Route Tool', ['search_products', 'get_product_details', 'create_checkout_link', 'verify_order_access', 'get_order_status', 'propose_order_change'], "$('Woo Tool Request').first().json.name"),
      http('Search Products', { url: store(''), query: [['search', '={{ ' + args + '.query }}'], ['per_page', '6']], full: true, timeout: 15000 }),
      code('Format search', 'e_format_products.search.js'),
      http('Get Product', { url: store('/{{ ' + args + '.product_id }}'), full: true, timeout: 15000 }),
      http('Get Variations', { url: store(''), query: [['parent', '={{ ' + args + '.product_id }}'], ['type', 'variation'], ['per_page', '50']], full: true, timeout: 15000 }),
      code('Format details', 'e_format_products.details.js'),
      http('Get Checkout Product', { url: store('/{{ ' + args + '.product_id }}'), full: true, timeout: 15000 }),
      http('Get Checkout Variations', { url: store(''), query: [['parent', '={{ ' + args + '.product_id }}'], ['type', 'variation'], ['per_page', '50']], full: true, timeout: 15000 }),
      code('Format checkout', 'e_format_products.checkout.js'),
      { name: 'Get Order', type: 'n8n-nodes-base.wooCommerce', version: 1, parameters: { resource: 'order', operation: 'get', orderId: '={{ ' + args + '.order_id }}' },
        credentials: cred('woo'), onError: 'continueRegularOutput', alwaysOutputData: true },
      pg('Link Order', `SELECT CASE WHEN (p->>'allowed')::boolean THEN jsonb_build_object('linked', true, 'already', true)
              WHEN p->>'phone' IS NULL OR p->>'phone' = '' THEN jsonb_build_object('linked', false)
              ELSE app.link_order_if_phone_matches((p->>'job_id')::uuid, (p->>'order_id')::bigint, p->>'phone') END AS link
       FROM ${jsonParam()}`,
        "{ allowed: Boolean($('Load Shop').first().json.access && $('Load Shop').first().json.access.allowed), job_id: $('Woo Tool Request').first().json.job_id, order_id: " + args + ".order_id, phone: ($json.id === " + args + ".order_id && $json.billing) ? $json.billing.phone : null }",
        { sample: { allowed: false, job_id: UUID, order_id: 1, phone: '01711111111' } }),
      code('Format Order', 'e_order.js'),
      ifNode('Propose?', isTrue('={{ $json.propose }}')),
      pg('Propose Operation', `SELECT app.propose_order_operation((p->>'job_id')::uuid, o->>'operation_id', o->>'type', (o->>'order_id')::bigint, o->'payload', o->'quote') AS result
       FROM ${jsonParam()}, LATERAL (SELECT p->'operation' AS o) y`, "{ job_id: $('Woo Tool Request').first().json.job_id, operation: $json.operation }",
        { sample: { job_id: UUID, operation: { operation_id: 'x', type: 'refund', order_id: 1, payload: {}, quote: {} } } }),
      code('Format Proposal', 'e_proposal.js'),
      noop('Return Order Result'),
    ],
    edges: [
      ['Woo Tool Request', 0, 'Load Shop'], ['Load Shop', 0, 'Route Tool'],
      ['Route Tool', 0, 'Search Products'], ['Search Products', 0, 'Format search'],
      ['Route Tool', 1, 'Get Product'], ['Get Product', 0, 'Get Variations'], ['Get Variations', 0, 'Format details'],
      ['Route Tool', 2, 'Get Checkout Product'], ['Get Checkout Product', 0, 'Get Checkout Variations'], ['Get Checkout Variations', 0, 'Format checkout'],
      ['Route Tool', 3, 'Get Order'], ['Route Tool', 4, 'Get Order'], ['Route Tool', 5, 'Get Order'],
      ['Get Order', 0, 'Link Order'], ['Link Order', 0, 'Format Order'], ['Format Order', 0, 'Propose?'],
      ['Propose?', 0, 'Propose Operation'], ['Propose Operation', 0, 'Format Proposal'], ['Propose?', 1, 'Return Order Result'],
    ],
  });

  // 7 -------------------------------------------------------------------------
  S.push({
    key: 'dispatch', color: 4,
    title: '7 · Outgoing dispatch (the ONLY sending path)',
    note: 'AI replies, staff replies, approved drafts, handoff acknowledgements, scheduled/system messages and retries all enter at **Dispatch Queue**. For each message, **claim_outbound** re-checks conversation mode, mode version, message freshness (revision), the 24-hour window, rate limits, the global AI switch and the **emergency stop** immediately before sending; a refused claim sends nothing. Sends carry an Idempotency-Key. Timeouts/5xx become **unknown** (reconciled by maintenance, never blindly retried). A message already accepted by the provider can still arrive after a takeover or stop — it cannot be recalled.',
    nodes: [
      webhook('Dispatch Webhook', 'wa-dispatch'),
      schedule('Every 15 Seconds', { field: 'seconds', secondsInterval: 15 }),
      pg('Due Outbound', 'SELECT outbound_id FROM app.due_outbound(20)', null),
      code('Dispatch Queue', 'dispatch_queue.js'),
      loop('Dispatch Loop', ['Record Result', 'Not Claimed']),
      pg('Claim Outbound', `SELECT app.claim_outbound((p->>'outbound_id')::uuid, 'n8n:' || coalesce(p->>'exec', '')) AS claim FROM ${jsonParam()}
       WHERE p->>'outbound_id' ~* '^[0-9a-f-]{36}$'`,
        '{ outbound_id: $json.outbound_id, exec: $execution.id }', { alwaysOutputData: true, sample: { outbound_id: UUID, exec: '1' } }),
      code('Build Send', 'c_build.js'),
      routeSwitch('Route Send', ['send', 'upload', 'record', 'skip']),
      noop('Not Claimed'),
      pg('Load Upload', `SELECT u.* FROM ${jsonParam()}, app.get_outbound_upload((p->>'outbound_id')::uuid) u`, '{ outbound_id: $json.outbound_id }', { alwaysOutputData: true, sample: { outbound_id: UUID } }),
      http('Presign Upload', { method: 'POST', url: ZERNIO + '/v1/media/presign', auth: 'zernio',
        json: "={{ JSON.stringify({ filename: $json.file_name, contentType: $json.mime_type, size: $json.size_bytes }) }}", timeout: 20000 }),
      code('Prepare Upload', 'c_upload_file.js'),
      routeSwitch('Upload Route', ['put', 'record']),
      http('Upload File', { method: 'PUT', url: '={{ $json.upload_url }}', binary: true, full: true, timeout: 60000 }),
      code('After Upload', 'c_after_upload.js'),
      routeSwitch('After Upload Route', ['send', 'record']),
      pg('Save Media URL', `SELECT app.set_outbound_media_url((p->>'outbound_id')::uuid, p->>'url') AS ok FROM ${jsonParam()}`,
        '{ outbound_id: $json.outbound_id, url: $json.public_url }', { sample: { outbound_id: UUID, url: 'https://x' } }),
      code('Send Ready', 'c_send_ready.js'),
      http('Send Message', { method: 'POST', url: "={{ '" + ZERNIO + "' + $json.path }}", auth: 'zernio',
        headers: [['Idempotency-Key', '={{ $json.idempotency_key }}']], json: '={{ JSON.stringify($json.send_body) }}', full: true, timeout: 30000 }),
      code('Classify Result', 'c_classify.js'),
      pg('Record Result', `SELECT app.record_send_result((p->>'outbound_id')::uuid, (p->>'attempt_no')::int, r->>'outcome', (r->>'http_status')::int,
         r->>'provider_message_id', nullif(r->'response', 'null'::jsonb), nullif(r->'error', 'null'::jsonb), (r->>'retry_after_seconds')::int) AS r
       FROM ${jsonParam()}, LATERAL (SELECT p->'record' AS r) y`, '$json',
        { sample: { outbound_id: UUID, attempt_no: 1, record: { outcome: 'accepted' } } }),
    ],
    edges: [
      ['Dispatch Webhook', 0, 'Dispatch Queue'], ['Every 15 Seconds', 0, 'Due Outbound'], ['Due Outbound', 0, 'Dispatch Queue'],
      ['Dispatch Queue', 0, 'Dispatch Loop'], ['Dispatch Loop', 1, 'Claim Outbound'],
      ['Claim Outbound', 0, 'Build Send'], ['Build Send', 0, 'Route Send'],
      ['Route Send', 0, 'Send Ready'], ['Route Send', 1, 'Load Upload'], ['Route Send', 2, 'Record Result'], ['Route Send', 3, 'Not Claimed'],
      ['Load Upload', 0, 'Presign Upload'], ['Presign Upload', 0, 'Prepare Upload'], ['Prepare Upload', 0, 'Upload Route'],
      ['Upload Route', 0, 'Upload File'], ['Upload Route', 1, 'Record Result'],
      ['Upload File', 0, 'After Upload'], ['After Upload', 0, 'After Upload Route'],
      ['After Upload Route', 0, 'Save Media URL'], ['After Upload Route', 1, 'Record Result'],
      ['Save Media URL', 0, 'Send Ready'], ['Send Ready', 0, 'Send Message'], ['Send Message', 0, 'Classify Result'], ['Classify Result', 0, 'Record Result'],
      ['Record Result', 0, 'Dispatch Loop'], ['Not Claimed', 0, 'Dispatch Loop'],
    ],
  });

  // 8 -------------------------------------------------------------------------
  S.push({
    key: 'notify', color: 3,
    title: '8 · Staff alerts (Telegram)',
    note: 'Handoffs, customer requests for a person, failed/unknown sends, holds, overdue replies and workflow errors. Facts and a dashboard link only — never message content, attachments or contact details. Off until notifications.telegram_enabled is set.',
    nodes: [
      noop('Notify Request'),
      pg('Load Facts', `SELECT (SELECT app.notification_facts((p->>'conversation_id')::uuid) WHERE p->>'conversation_id' ~* '^[0-9a-f-]{36}$') AS f,
       app.setting('notifications') AS notify, app.setting('dashboard_url') #>> '{}' AS dash FROM ${jsonParam()}`,
        "{ conversation_id: $json.conversation_id || ($json.alert && $json.alert.details && $json.alert.details.conversation_id) || null }", { sample: { conversation_id: UUID } }),
      code('Format Notification', 'd_format.js'),
      { name: 'Send Telegram', type: 'n8n-nodes-base.telegram', version: 1.2,
        parameters: { resource: 'message', operation: 'sendMessage', chatId: '={{ $json.chat_id }}', text: '={{ $json.text }}', additionalFields: { appendAttribution: false, disable_web_page_preview: true, parse_mode: 'HTML' } },
        credentials: cred('telegram'), onError: 'continueRegularOutput' },
    ],
    edges: [['Notify Request', 0, 'Load Facts'], ['Load Facts', 0, 'Format Notification'], ['Format Notification', 0, 'Send Telegram']],
  });

  // 9 -------------------------------------------------------------------------
  S.push({
    key: 'sync', color: 2,
    title: '9 · WooCommerce synchronization',
    note: 'Signed WooCommerce webhooks (verified and stored by the backend) and a 6-hourly Store API refresh keep the local product and order references current. Optional order-status messages go through the dispatch branch like every other message (off by default).',
    nodes: [
      webhook('Woo Event Webhook', 'wa-woo-event'),
      pg('Load Event', `SELECT app.get_webhook_event((p->>'id')::uuid) AS ev FROM ${jsonParam()} WHERE p->>'id' ~* '^[0-9a-f-]{36}$'`, '{ id: $json.body && $json.body.event_id }', { sample: { id: UUID } }),
      code('Map webhook', 'f_map.webhook.js'),
      routeSwitch('Sync Route', ['products', 'order']),
      pg('Upsert Products', `SELECT app.upsert_woo_products(coalesce(p->'items', '[]')) AS n FROM ${jsonParam()}`, '{ items: $json.items }', { sample: { items: [] } }),
      pg('Upsert Order', `SELECT app.upsert_woo_order_ref(p) AS r, app.setting('followups') AS followups FROM ${jsonParam()}`, '$json.order',
        { sample: { id: 1, status: 'processing', total: '1', billing: {} } }),
      code('Order Update Messages', 'f_order_notify.js'),
      pg('Queue Order Update', `SELECT app.enqueue_system_message((p->>'conversation_id')::uuid, 'notification', 'utility', p->>'body', '{}'::jsonb, p->>'dedupe', NULL) AS outbound_id FROM ${jsonParam()}`,
        '$json', { sample: { conversation_id: UUID, body: 'b', dedupe: 'd' } }),
      schedule('Every 6 Hours', { field: 'hours', hoursInterval: 6 }),
      pg('Load Shop URL', "SELECT app.setting('shop_base_url') #>> '{}' AS base", null),
      http('Fetch Catalogue', { url: '={{ $json.base }}/wp-json/wc/store/v1/products', query: [['per_page', '100']], timeout: 30000,
        pagination: { paginationMode: 'updateAParameterInEachRequest', parameters: { parameters: [{ type: 'qs', name: 'page', value: '={{ $pageCount + 1 }}' }] },
          paginationCompleteWhen: 'responseIsEmpty', limitPagesFetched: true, maxRequests: 30, requestInterval: 500 } }),
      code('Map catalogue', 'f_map.catalogue.js'),
      pg('Upsert Catalogue', `SELECT app.upsert_woo_products(coalesce(p->'items', '[]')) AS n FROM ${jsonParam()}`, '{ items: $json.items || [] }', { sample: { items: [] } }),
    ],
    edges: [['Woo Event Webhook', 0, 'Load Event'], ['Load Event', 0, 'Map webhook'], ['Map webhook', 0, 'Sync Route'],
      ['Sync Route', 0, 'Upsert Products'], ['Sync Route', 1, 'Upsert Order'], ['Upsert Order', 0, 'Order Update Messages'], ['Order Update Messages', 0, 'Queue Order Update'],
      ['Queue Order Update', 0, 'Dispatch Queue'],
      ['Every 6 Hours', 0, 'Load Shop URL'], ['Load Shop URL', 0, 'Fetch Catalogue'], ['Fetch Catalogue', 0, 'Map catalogue'], ['Map catalogue', 0, 'Upsert Catalogue']],
  });

  // 10 ------------------------------------------------------------------------
  S.push({
    key: 'memory', color: 5,
    title: '10 · Customer memory & conversation summaries',
    note: 'Every 10 minutes: working summaries per conversation and customer-stated preferences, stored against **that customer only** (never shared knowledge). Text is redacted (keys, passwords, OTPs, card data, login links) before it reaches the model. Skipped when the AI budget is used up.',
    nodes: [
      schedule('Every 10 Minutes', { field: 'minutes', minutesInterval: 10 }),
      pg('Conversations To Summarize', 'SELECT conversation_id FROM app.conversations_needing_summary(20)', null),
      loop('Summary Loop', ['Save Summary', 'Record Summary Usage', 'Summary Skipped']),
      pg('Load Summary Input', `SELECT app.summary_input((p->>'c')::uuid) AS inp, app.setting('models') AS models, app.ai_budget_status() AS budget,
         (SELECT body FROM app.prompt_versions WHERE name = 'summary_system' AND status = 'published') AS prompt FROM ${jsonParam()}`,
        '{ c: $json.conversation_id }', { sample: { c: UUID } }),
      code('Prepare Summary Request', 'g_prepare.js'),
      ifNode('Summarize?', isFalse('={{ $json.skip }}')),
      noop('Summary Skipped'),
      model('Call Summary Model', '$json.request', 60000),
      code('Validate Summary', 'g_validate.js'),
      ifNode('Summary Valid?', isTrue('={{ $json.ok }}')),
      pg('Save Summary', `WITH x AS (SELECT $1::jsonb AS p),
         s AS (SELECT app.upsert_conversation_summary((p->>'conversation_id')::uuid, p->>'summary', p->'actions', p->'open', (p->>'covers_until')::timestamptz) AS v FROM x),
         m AS (SELECT app.upsert_customer_memory_for_conversation((p->>'conversation_id')::uuid, e->>'key', e->>'value', (e->>'source_message_id')::uuid) AS r
               FROM x, jsonb_array_elements(coalesce(p->'memories', '[]')) e),
         u AS (SELECT app.record_ai_usage(NULL, 'summary', p->'usage') AS id FROM x)
       SELECT (SELECT count(*) FROM s) AS summaries, (SELECT coalesce(jsonb_agg(r), '[]') FROM m) AS memories, (SELECT count(*) FROM u) AS usage_rows`,
        '$json.save', { sample: { conversation_id: UUID, summary: 's', actions: [], open: [], covers_until: '2026-01-01T00:00:00Z', memories: [], usage: {} } }),
      pg('Record Summary Usage', `SELECT app.record_ai_usage(NULL, 'summary', p->'usage') AS id FROM ${jsonParam()}`, '$json.save', { sample: { usage: {} } }),
    ],
    edges: [['Every 10 Minutes', 0, 'Conversations To Summarize'], ['Conversations To Summarize', 0, 'Summary Loop'], ['Summary Loop', 1, 'Load Summary Input'],
      ['Load Summary Input', 0, 'Prepare Summary Request'], ['Prepare Summary Request', 0, 'Summarize?'],
      ['Summarize?', 0, 'Call Summary Model'], ['Summarize?', 1, 'Summary Skipped'], ['Call Summary Model', 0, 'Validate Summary'], ['Validate Summary', 0, 'Summary Valid?'],
      ['Summary Valid?', 0, 'Save Summary'], ['Summary Valid?', 1, 'Record Summary Usage'],
      ['Save Summary', 0, 'Summary Loop'], ['Record Summary Usage', 0, 'Summary Loop'], ['Summary Skipped', 0, 'Summary Loop']],
  });

  // 11 ------------------------------------------------------------------------
  S.push({
    key: 'learning', color: 6,
    title: '11 · Daily knowledge-improvement proposals',
    note: '03:15 Asia/Dhaka. Redacted review of recently resolved chats produces **proposals only** (status pending). Nothing reaches the AI until an admin approves and publishes it in the dashboard. Raw private chats are never added to shared knowledge.',
    nodes: [
      schedule('Daily 03:15', { field: 'days', daysInterval: 1, triggerAtHour: 3, triggerAtMinute: 15 }),
      pg('Load Learning Input', `SELECT app.learning_candidates(now() - interval '1 day', 30) AS cands, app.published_knowledge_index() AS kb,
         app.setting('models') AS models, app.ai_budget_status() AS budget,
         (SELECT body FROM app.prompt_versions WHERE name = 'learning_system' AND status = 'published') AS prompt`, null),
      code('Prepare Learning Request', 'h_prepare.js'),
      ifNode('Learn?', isFalse('={{ $json.skip }}')),
      model('Call Learning Model', '$json.request', 180000),
      code('Validate Proposals', 'h_validate.js'),
      pg('Submit Proposal', `SELECT app.submit_knowledge_proposal(p->>'kind', app.document_id_for_slug(p->>'slug'), p->>'category', p->>'title', p->>'body',
         p->>'rationale', p->'evidence', p->'redaction', p->>'run') AS id FROM (SELECT $1::jsonb->'proposal' AS p) x WHERE jsonb_typeof(p) = 'object'`, '$json',
        { sample: { proposal: { kind: 'new', slug: null, category: 'faq', title: 't', body: 'b', rationale: 'r', evidence: {}, redaction: {}, run: 'r' } } }),
      pg('Record Learning Usage', `SELECT app.record_ai_usage(NULL, 'learning', p->'usage') AS id FROM ${jsonParam()}`, '{ usage: $json.usage }', { executeOnce: true, sample: { usage: {} } }),
    ],
    edges: [['Daily 03:15', 0, 'Load Learning Input'], ['Load Learning Input', 0, 'Prepare Learning Request'], ['Prepare Learning Request', 0, 'Learn?'],
      ['Learn?', 0, 'Call Learning Model'], ['Call Learning Model', 0, 'Validate Proposals'], ['Validate Proposals', 0, 'Submit Proposal'], ['Validate Proposals', 0, 'Record Learning Usage']],
  });

  // 12 ------------------------------------------------------------------------
  S.push({
    key: 'maintenance', color: 7,
    title: '12 · Scheduled recovery, reconciliation, reminders & cleanup',
    note: 'Every minute: health heartbeat, expired send leases, **backend event sweep** (retries stored-but-unfinished webhook events, max 10 attempts, then dead-letter + alert), alert forwarding. Every 5 minutes: **interrupted AI jobs** handed to staff, overdue-reply reminders, pending media, **unknown sends reconciled** against Zernio\'s message list (marked sent only on one exact match; otherwise evidence for a person — never re-sent automatically). Daily: retention.',
    nodes: [
      schedule('Every Minute', { field: 'minutes', minutesInterval: 1 }),
      pg('Expire Leases', "SELECT app.expire_send_leases() AS expired, app.record_health('n8n_maintenance', 'ok', jsonb_build_object('at', now())) IS NULL AS health", null),
      pg('Claim Alerts', `UPDATE app.alerts SET notified_at = now() WHERE id IN (
         SELECT id FROM app.alerts WHERE resolved_at IS NULL AND notified_at IS NULL ORDER BY created_at LIMIT 10 FOR UPDATE SKIP LOCKED)
       RETURNING id, kind, severity, message, details`, null, { executeOnce: true }),
      setRaw('Alert Input', '{ alert: $json, reason: $json.kind }'),
      pg('Sweep URL', "SELECT app.setting('dashboard_url') #>> '{}' AS url", null),
      http('Sweep Events', { method: 'POST', url: '={{ $json.url }}/api/internal/events/sweep', auth: 'backend', json: '={}', timeout: 20000 }),
      schedule('Every 5 Minutes', { field: 'minutes', minutesInterval: 5 }),
      pg('Recover Interrupted Jobs', "SELECT app.recover_stale_ai_jobs(interval '10 minutes') AS r", null),
      setRaw('Recovery Acknowledgements', '{ ack_outbound_ids: ($json.r && $json.r.ack_outbound_ids) || [] }'),
      pg('Overdue Reminders', `SELECT count(app.raise_alert('response_overdue', 'info', 'A customer is waiting past the response target.',
         jsonb_build_object('conversation_id', x->>'conversation_id'), 'overdue:' || (x->>'conversation_id') || ':' || (x->>'due_at'))) AS raised
       FROM jsonb_array_elements(app.overdue_conversations()) x`, null),
      pg('Pending Media', `SELECT jsonb_agg(x->'attachment_id') AS attachment_ids FROM jsonb_array_elements(app.pending_attachments(NULL)) x HAVING count(*) > 0`, null, { executeOnce: true }),
      pg('Unknown Sends', `SELECT x->>'outbound_id' AS outbound_id, x->>'body' AS body, x->>'created_at' AS created_at,
         x->>'provider_conversation_id' AS provider_conversation_id, x->>'provider_account_id' AS provider_account_id
       FROM jsonb_array_elements(app.unknown_sends_for_reconcile()) x`, null),
      loop('Reconcile Loop', ['Resolve Send', 'Attach Evidence']),
      noop('Unknown Send'),
      http('List Provider Messages', { url: "={{ '" + ZERNIO + "/v1/inbox/conversations/' + encodeURIComponent($json.provider_conversation_id) + '/messages' }}", auth: 'zernio',
        query: [['accountId', '={{ $json.provider_account_id }}'], ['limit', '50'], ['sortOrder', 'desc']], full: true, timeout: 20000 }),
      code('Match Unknown Send', 'i_reconcile.js'),
      routeSwitch('Reconcile Route', ['resolve', 'evidence'], '$json.action'),
      pg('Resolve Send', `SELECT app.resolve_unknown_send((p->>'outbound_id')::uuid, 'mark_sent', NULL, p->>'provider_message_id', p->'evidence') AS r FROM ${jsonParam()}`, '$json',
        { sample: { outbound_id: UUID, provider_message_id: 'wamid', evidence: {} } }),
      pg('Attach Evidence', `SELECT app.attach_reconcile_evidence((p->>'outbound_id')::uuid, p->'evidence') AS ok FROM ${jsonParam()}`, '$json',
        { sample: { outbound_id: UUID, evidence: {} } }),
      schedule('Daily 04:10', { field: 'days', daysInterval: 1, triggerAtHour: 4, triggerAtMinute: 10 }),
      pg('Apply Retention', 'SELECT app.apply_retention() AS r', null),
    ],
    edges: [['Every Minute', 0, 'Expire Leases'], ['Expire Leases', 0, 'Claim Alerts'], ['Claim Alerts', 0, 'Alert Input'], ['Alert Input', 0, 'Notify Request'],
      ['Every Minute', 0, 'Sweep URL'], ['Sweep URL', 0, 'Sweep Events'],
      ['Every 5 Minutes', 0, 'Recover Interrupted Jobs'], ['Recover Interrupted Jobs', 0, 'Recovery Acknowledgements'], ['Recovery Acknowledgements', 0, 'Dispatch Queue'],
      ['Every 5 Minutes', 0, 'Overdue Reminders'], ['Every 5 Minutes', 0, 'Pending Media'], ['Pending Media', 0, 'Media Request'],
      ['Every 5 Minutes', 0, 'Unknown Sends'], ['Unknown Sends', 0, 'Reconcile Loop'], ['Reconcile Loop', 1, 'Unknown Send'],
      ['Unknown Send', 0, 'List Provider Messages'], ['List Provider Messages', 0, 'Match Unknown Send'], ['Match Unknown Send', 0, 'Reconcile Route'],
      ['Reconcile Route', 0, 'Resolve Send'], ['Reconcile Route', 1, 'Attach Evidence'], ['Resolve Send', 0, 'Reconcile Loop'], ['Attach Evidence', 0, 'Reconcile Loop'],
      ['Daily 04:10', 0, 'Apply Retention']],
  });

  // 13 ------------------------------------------------------------------------
  S.push({
    key: 'history', color: 5,
    title: '13 · History import (manual)',
    note: 'Run by an admin. Imports earlier Zernio conversation history for every known WhatsApp conversation (up to 50 pages × 100 messages each) through the backend as **historical** messages — never answered, never counted in metrics; re-running it does not duplicate messages.',
    nodes: [
      manual('Run History Import'),
      pg('History Targets', 'SELECT x AS t FROM jsonb_array_elements(app.history_import_targets(200)) x', null),
      loop('Import Loop', ['Store History Page', 'No New History']),
      setRaw('History Target', '$json.t || $json'),
      pg('Dashboard URL', "SELECT app.setting('dashboard_url') #>> '{}' AS url", null, { executeOnce: true }),
      http('Fetch History Page', { url: "={{ '" + ZERNIO + "/v1/inbox/conversations/' + encodeURIComponent($('History Target').first().json.provider_conversation_id) + '/messages' }}", auth: 'zernio',
        query: [['accountId', "={{ $('History Target').first().json.provider_account_id }}"], ['limit', '100']], timeout: 30000,
        pagination: { paginationMode: 'updateAParameterInEachRequest', parameters: { parameters: [{ type: 'qs', name: 'cursor', value: '={{ $response.body.pagination && $response.body.pagination.nextCursor }}' }] },
          paginationCompleteWhen: 'other', completeExpression: '={{ !($response.body.pagination && $response.body.pagination.hasMore) }}', limitPagesFetched: true, maxRequests: 50, requestInterval: 300 } }),
      code('Map History Page', 'j_map.js'),
      ifNode('Has History?', isFalse('={{ Boolean($json.skip) }}')),
      noop('No New History'),
      http('Store History Page', { method: 'POST', url: "={{ $('Dashboard URL').first().json.url }}/api/internal/history-import", auth: 'backend',
        json: '={{ JSON.stringify($json.body) }}', timeout: 60000 }),
    ],
    edges: [['Run History Import', 0, 'History Targets'], ['History Targets', 0, 'Import Loop'], ['Import Loop', 1, 'History Target'],
      ['History Target', 0, 'Dashboard URL'], ['Dashboard URL', 0, 'Fetch History Page'],
      ['Fetch History Page', 0, 'Map History Page'], ['Map History Page', 0, 'Has History?'], ['Has History?', 0, 'Store History Page'], ['Has History?', 1, 'No New History'],
      ['Store History Page', 0, 'Import Loop'], ['No New History', 0, 'Import Loop']],
  });

  // 14 ------------------------------------------------------------------------
  S.push({
    key: 'errors', color: 3,
    title: '14 · Error recording',
    note: 'If any node of this workflow fails, n8n runs this Error Trigger (this workflow is its own error workflow). The failure is stored as a dashboard alert (one per node per hour) and forwarded to staff by the maintenance branch. Failed jobs and uncertain sends stay in PostgreSQL for the recovery branch. If n8n itself is down, the backend health check (n8n heartbeat older than 3 minutes) raises the alarm instead.',
    nodes: [
      { name: 'On Workflow Error', type: 'n8n-nodes-base.errorTrigger', version: 1, parameters: {}, trigger: true },
      code('Format Error', 'z_error.js'),
      pg('Raise Alert', `SELECT app.raise_alert('workflow_error', 'warning', p->>'message', p->'details', p->>'dedupe') AS ok FROM ${jsonParam()}`, '$json', { sample: { message: 'm', details: {}, dedupe: 'd' } }),
    ],
    edges: [['On Workflow Error', 0, 'Format Error'], ['Format Error', 0, 'Raise Alert']],
  });

  // 15 ------------------------------------------------------------------------
  S.push({
    key: 'check', color: 1,
    title: '15 · Connection check (manual, read-only)',
    note: 'Run it after changing any credential. Calls DeepSeek with the product-search tool, sends a **real shop product image** to Qwen, reads the Store API, lists Zernio accounts, checks the restricted PostgreSQL role, the backend health endpoint and token, and the WooCommerce REST key. Sends nothing to WhatsApp and changes nothing. The last node summarizes the results (no keys, no image bytes).',
    nodes: [
      manual('Run Connection Check'),
      code('Connection Check Plan', 'cc_start.js'),
      http('Check Store API', { url: SHOP + '/wp-json/wc/store/v1/products', query: [['search', 'netflix'], ['per_page', '3']], full: true, timeout: 20000 }),
      http('Check Chat Model', { method: 'POST', url: OPENROUTER, auth: 'openrouter', headers: [['X-Title', 'IDS WhatsApp Support']],
        json: "={{ JSON.stringify($('Connection Check Plan').first().json.chat_request) }}", full: true, timeout: 90000 }),
      http('Load Test Image', { url: "={{ ((($('Check Store API').first().json.body || [])[0] || {}).images || [{}])[0].src || '" + SHOP + "/favicon.ico' }}", full: true, file: true, timeout: 30000 }),
      code('Prepare Vision Check', 'cc_vision_request.js'),
      http('Check Vision Model', { method: 'POST', url: OPENROUTER, auth: 'openrouter', headers: [['X-Title', 'IDS WhatsApp Support']],
        json: '={{ JSON.stringify($json.skip ? {} : $json.request) }}', full: true, timeout: 90000 }),
      http('Check Zernio', { url: ZERNIO + '/v1/accounts', auth: 'zernio', full: true, timeout: 20000 }),
      pg('Check Postgres', "SELECT current_user AS db_user, app.setting_bool('ai_enabled', false) AS ai_enabled, app.setting_bool('sending_enabled', true) AS sending_enabled, app.setting('dashboard_url') #>> '{}' AS dashboard_url", null,
        { onError: 'continueRegularOutput', alwaysOutputData: true }),
      http('Check Backend Health', { url: "={{ ($('Check Postgres').first().json.dashboard_url || 'https://invalid.localhost') + '/api/health' }}", full: true, timeout: 15000 }),
      http('Check Backend Token', { url: "={{ ($('Check Postgres').first().json.dashboard_url || 'https://invalid.localhost') + '/api/internal/ping' }}", auth: 'backend', full: true, timeout: 15000 }),
      { name: 'Check WooCommerce REST', type: 'n8n-nodes-base.wooCommerce', version: 1, parameters: { resource: 'product', operation: 'getAll', returnAll: false, limit: 1, options: {} },
        credentials: cred('woo'), onError: 'continueRegularOutput', alwaysOutputData: true, executeOnce: true },
      code('Connection Check Result', 'cc_summary.js'),
    ],
    edges: [['Run Connection Check', 0, 'Connection Check Plan'], ['Connection Check Plan', 0, 'Check Store API'], ['Check Store API', 0, 'Check Chat Model'],
      ['Check Chat Model', 0, 'Load Test Image'], ['Load Test Image', 0, 'Prepare Vision Check'], ['Prepare Vision Check', 0, 'Check Vision Model'],
      ['Check Vision Model', 0, 'Check Zernio'], ['Check Zernio', 0, 'Check Postgres'], ['Check Postgres', 0, 'Check Backend Health'],
      ['Check Backend Health', 0, 'Check Backend Token'], ['Check Backend Token', 0, 'Check WooCommerce REST'], ['Check WooCommerce REST', 0, 'Connection Check Result']],
  });

  return S;
}

// ---------------------------------------------------------------------------
// Assembly, layout, output
// ---------------------------------------------------------------------------
export function assemble() {
  const S = sections();
  const nodes = [];
  const edges = [];
  const seen = new Set();
  for (const s of S) {
    for (const n of s.nodes) {
      if (seen.has(n.name)) throw new Error('duplicate node name ' + n.name);
      seen.add(n.name);
      nodes.push({ ...n, section: s.key });
    }
    edges.push(...s.edges);
  }
  for (const [f, , t] of edges) {
    if (!seen.has(f)) throw new Error('edge from unknown node ' + f);
    if (!seen.has(t)) throw new Error('edge to unknown node ' + t);
  }
  return { name: WORKFLOW_NAME, sections: S, nodes, edges };
}

const X = 250;
const Y = 170;
function layout(def) {
  const pos = {};
  const notes = [];
  let top = 0;
  const bySection = {};
  for (const n of def.nodes) (bySection[n.section] = bySection[n.section] || []).push(n);
  for (const s of def.sections) {
    const names = new Set(bySection[s.key].map((n) => n.name));
    const local = def.edges.filter(([f, , t]) => names.has(f) && names.has(t));
    const incoming = new Set(local.map(([, , t]) => t));
    const depth = {};
    const q = [...names].filter((n) => !incoming.has(n)).map((n) => [n, 0]);
    while (q.length) {
      const [n, d] = q.shift();
      if (depth[n] !== undefined && depth[n] >= d) continue;
      if (d > names.size) continue;
      depth[n] = d;
      for (const [f, , t] of local) if (f === n) q.push([t, d + 1]);
    }
    const rows = {};
    let maxD = 0;
    let maxR = 0;
    for (const n of bySection[s.key]) {
      const d = depth[n.name] ?? 0;
      rows[d] = (rows[d] || 0) + 1;
      pos[n.name] = [d * X, top + 140 + (rows[d] - 1) * Y];
      maxD = Math.max(maxD, d);
      maxR = Math.max(maxR, rows[d]);
    }
    const height = 140 + maxR * Y + 20;
    notes.push({ key: s.key, title: s.title, note: s.note, color: s.color, position: [-60, top], width: Math.max(900, (maxD + 1) * X + 60), height });
    top += height + 80;
  }
  return { pos, notes };
}

function toN8nJson(def) {
  const { pos, notes } = layout(def);
  const nodes = def.nodes.map((n) => {
    const o = { id: stableId('ids-wa-node:' + n.name), name: n.name, type: n.type, typeVersion: n.version, position: pos[n.name], parameters: n.parameters };
    if (n.credentials) o.credentials = n.credentials;
    if (n.webhookId) o.webhookId = n.webhookId;
    for (const k of ['onError', 'executeOnce', 'alwaysOutputData', 'retryOnFail']) if (n[k] !== undefined) o[k] = n[k];
    return o;
  });
  for (const s of notes) {
    nodes.push({ id: stableId('ids-wa-note:' + s.key), name: 'Note · ' + s.key, type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: s.position,
      parameters: { content: '## ' + s.title + '\n' + s.note, width: s.width, height: s.height, color: s.color } });
  }
  const connections = {};
  for (const [f, oi, t, ti] of def.edges) {
    const c = (connections[f] = connections[f] || { main: [] });
    while (c.main.length <= oi) c.main.push([]);
    c.main[oi].push({ node: t, type: 'main', index: ti || 0 });
  }
  return {
    name: def.name, nodes, connections,
    settings: {
      executionOrder: 'v1',
      // Execution data would contain customer image bytes and message text:
      // neither successful nor failed production runs are stored by n8n. Failures
      // are recorded as alerts by the Error Trigger branch; manual test runs
      // are kept so staff can inspect the connection check.
      saveDataSuccessExecution: 'none',
      saveDataErrorExecution: 'none',
      saveManualExecutions: true,
      timezone: 'Asia/Dhaka',
      callerPolicy: 'none',
    },
    pinData: {}, meta: { templateCredsSetupCompleted: false },
  };
}

// SDK code for create_workflow_from_code. placeholders: Code nodes get a
// one-line stub; their code is then set with update_workflow
// setNodeParameter('/jsCode') in batches (keeps each MCP call small).
function toSdk(def, json, placeholders = false) {
  const vars = new Map(json.nodes.map((n, i) => [n.name, 'n' + i]));
  const esc = (s) => s.replace(/[\u007f-￿]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
  const lines = ["import { workflow, node, trigger, sticky, newCredential } from '@n8n/workflow-sdk';", ''];
  const byName = new Map(def.nodes.map((n) => [n.name, n]));
  for (const j of json.nodes) {
    const n = byName.get(j.name);
    if (!n) {
      lines.push(`const ${vars.get(j.name)} = sticky(${esc(JSON.stringify(j.parameters.content))}, [], { name: ${JSON.stringify(j.name)}, color: ${j.parameters.color}, position: ${JSON.stringify(j.position)}, width: ${j.parameters.width}, height: ${j.parameters.height} });`);
      continue;
    }
    const parameters = placeholders && n.codeFile ? { jsCode: '// code from n8n/code/dist/' + n.codeFile + ' is set in a follow-up update\nreturn [];' } : n.parameters;
    const config = { name: n.name, parameters, position: j.position };
    for (const k of ['onError', 'executeOnce', 'alwaysOutputData']) if (n[k] !== undefined) config[k] = n[k];
    if (n.webhookId) config.webhookId = n.webhookId;
    let cfg = JSON.stringify(config);
    if (n.credentials) {
      const [type, c] = Object.entries(n.credentials)[0];
      const credCode = c.id ? JSON.stringify({ id: c.id, name: c.name }) : 'newCredential(' + JSON.stringify(c.name) + ')';
      cfg = cfg.slice(0, -1) + ',"credentials":{' + JSON.stringify(type) + ':' + credCode + '}}';
    }
    lines.push(`const ${vars.get(n.name)} = ${n.trigger ? 'trigger' : 'node'}({ type: ${JSON.stringify(n.type)}, version: ${n.version}, config: ${esc(cfg)} });`);
  }
  lines.push('', `export default workflow('ids-whatsapp-ai-support', ${esc(JSON.stringify(def.name))})`);
  for (const j of json.nodes) lines.push(`  .add(${vars.get(j.name)})`);
  for (const [f, oi, t, ti] of def.edges) lines.push(`  .add(${vars.get(f)}.output(${oi}).to(${vars.get(t)}.input(${ti || 0})))`);
  return lines.join('\n') + ';\n';
}

export async function loadCredentials() {
  return JSON.parse(await readFile(path.join(root, 'n8n', 'credentials.json'), 'utf8'));
}

export async function generate() {
  dist = await buildAll();
  CRED = await loadCredentials();
  const def = assemble();
  const json = toN8nJson(def);
  return { def, json, sdk: toSdk(def, json), sdkStub: toSdk(def, json, true) };
}

if (process.argv[1] && process.argv[1].endsWith('workflow.mjs')) {
  const g = await generate();
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, WORKFLOW_FILE), JSON.stringify(g.json, null, 2) + '\n');
  const manifest = Object.fromEntries(g.def.nodes.filter((n) => n.codeFile).map((n) => [n.name, n.codeFile]));
  await writeFile(path.join(outDir, 'code-nodes.json'), JSON.stringify(manifest, null, 2) + '\n');
  const sdkIdx = process.argv.indexOf('--sdk');
  if (sdkIdx > 0) {
    const dir = process.argv[sdkIdx + 1];
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'workflow.sdk.js'), g.sdk);
    await writeFile(path.join(dir, 'workflow.stub.sdk.js'), g.sdkStub);
    const ops = g.def.nodes.filter((n) => n.codeFile).map((n) => ({ type: 'setNodeParameter', nodeName: n.name, path: '/jsCode', value: n.parameters.jsCode }));
    await writeFile(path.join(dir, 'workflow.code-ops.json'), JSON.stringify(ops, null, 1));
  }
  const types = {};
  for (const n of g.json.nodes) types[n.type] = (types[n.type] || 0) + 1;
  console.log(`wrote ${WORKFLOW_FILE}: ${g.json.nodes.length} nodes (${Object.entries(types).map(([t, c]) => t.replace('n8n-nodes-base.', '') + ' ' + c).join(', ')})`);
}
