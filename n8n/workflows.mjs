// Single source of truth for the n8n workflows.
//
//   node n8n/workflows.mjs            writes n8n/workflows/*.json (n8n import
//                                     format) and n8n/workflows/code-nodes.json
//   node n8n/workflows.mjs --sdk DIR  also writes Workflow-SDK code per
//                                     workflow (used to create/update them on
//                                     the instance through the n8n MCP server)
//
// Code nodes get their JavaScript from n8n/code/dist (see n8n/build.mjs).
// Workflow ids of the live instance are kept in n8n/workflows/ids.json so
// Execute-Workflow nodes point at the right sub-workflows.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { buildAll } from './build.mjs';

const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const outDir = path.join(root, 'n8n', 'workflows');

// Existing credentials on the instance are referenced by id; new ones are
// created by the owner in n8n (see docs/SETUP.md).
export const CRED = {
  pg: { type: 'postgres', name: 'WA Postgres (wa_n8n)' },
  zernio: { type: 'httpCustomAuth', id: 'NAWZ1V27MYMGkozE', name: 'Custom Auth account' },
  openrouter: { type: 'httpTemplatedCustomAuth', id: '3eVm7qPU029dwM3k', name: 'Simplified Custom Auth account' },
  telegram: { type: 'telegramApi', id: 'hC69Jo0AvNHRZ5PX', name: 'Telegram account' },
  woo: { type: 'wooCommerceApi', name: 'WA WooCommerce' },
  hook: { type: 'httpHeaderAuth', name: 'WA Internal Token' },
  backend: { type: 'httpHeaderAuth', name: 'WA Backend Internal Token' },
};

const ZERNIO = 'https://zernio.com/api';
const OPENROUTER = 'https://openrouter.ai/api/v1/chat/completions';
const UUID = '0b7c5a4e-1111-4222-8333-944444444444';

let dist = {};
let ids = {};

// ---------------------------------------------------------------------------
// Node helpers
// ---------------------------------------------------------------------------
const cred = (c) => ({ [c.type]: c.id ? { id: c.id, name: c.name } : { id: null, name: c.name } });

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
    credentials: cred(CRED.pg), sample: extra.sample, ...pick(extra),
  };
}
function pick(extra) {
  const o = {};
  for (const k of ['onError', 'executeOnce', 'alwaysOutputData', 'retryOnFail', 'maxTries', 'waitBetweenTries']) if (k in extra) o[k] = extra[k];
  return o;
}
function http(name, p, extra = {}) {
  const parameters = { method: p.method || 'GET', url: p.url };
  if (p.auth) { parameters.authentication = 'genericCredentialType'; parameters.genericAuthType = p.auth.type; }
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
  return http(name, { method: 'POST', url: OPENROUTER, auth: CRED.openrouter, headers: [['X-Title', 'WA Support']], json: '={{ JSON.stringify(' + requestExpr + ') }}', timeout: timeout || 120000 });
}
const cond = (left, op, right) => {
  const c = { leftValue: left, operator: op };
  if (right !== undefined) c.rightValue = right;
  return { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, conditions: [c], combinator: 'and' };
};
const isTrue = (left) => cond(left, { type: 'boolean', operation: 'true', singleValue: true });
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
function execWf(name, target, mode, wait, extra = {}) {
  if (!ids[target] && target !== 'self') throw new Error('unknown workflow id for ' + target + ' (create it first)');
  return {
    name, type: 'n8n-nodes-base.executeWorkflow', version: 1.2,
    parameters: { source: 'database', workflowId: { __rl: true, mode: 'id', value: target === 'self' ? '={{ $workflow.id }}' : ids[target] }, mode, options: { waitForSubWorkflow: wait } },
    ...pick(extra),
  };
}
const execTrigger = (name) => ({ name, type: 'n8n-nodes-base.executeWorkflowTrigger', version: 1.1, parameters: { inputSource: 'passthrough' }, trigger: true });
const webhook = (name, pathName) => ({
  name, type: 'n8n-nodes-base.webhook', version: 2,
  parameters: { httpMethod: 'POST', path: pathName, authentication: 'headerAuth', responseMode: 'onReceived', options: { noResponseBody: false } },
  credentials: cred(CRED.hook), trigger: true, webhookId: pathName,
});
const schedule = (name, interval) => ({ name, type: 'n8n-nodes-base.scheduleTrigger', version: 1.2, parameters: { rule: { interval: [interval] } }, trigger: true });
const noop = (name) => ({ name, type: 'n8n-nodes-base.noOp', version: 1, parameters: {} });
const setRaw = (name, jsonExpr) => ({ name, type: 'n8n-nodes-base.set', version: 3.4, parameters: { mode: 'raw', jsonOutput: '={{ JSON.stringify(' + jsonExpr + ') }}', options: {} } });

const jsonParam = () => '(SELECT $1::jsonb AS p) x';

// ---------------------------------------------------------------------------
// Workflow definitions. edges: [from, outputIndex, to, inputIndex?]
// ---------------------------------------------------------------------------
function definitions() {
  const W = {};

  W.z_error = {
    name: 'WA · Z Error Handler', file: 'z_error_handler.json',
    nodes: [
      { name: 'On Workflow Error', type: 'n8n-nodes-base.errorTrigger', version: 1, parameters: {}, trigger: true },
      code('Format Error', 'z_error.js'),
      pg('Raise Alert', `SELECT app.raise_alert('workflow_error', 'warning', p->>'message', p->'details', p->>'dedupe') AS ok FROM ${jsonParam()}`, '$json', { sample: { message: 'm', details: {}, dedupe: 'd' } }),
    ],
    edges: [['On Workflow Error', 0, 'Format Error'], ['Format Error', 0, 'Raise Alert']],
  };

  W.d_notify = {
    name: 'WA · D Notifications', file: 'd_notifications.json',
    nodes: [
      execTrigger('Notify Request'),
      pg('Load Facts', `SELECT (SELECT app.notification_facts((p->>'conversation_id')::uuid) WHERE p->>'conversation_id' ~* '^[0-9a-f-]{36}$') AS f,
       app.setting('notifications') AS notify, app.setting('dashboard_url') #>> '{}' AS dash FROM ${jsonParam()}`,
        "{ conversation_id: $json.conversation_id || ($json.alert && $json.alert.details && $json.alert.details.conversation_id) || null }", { sample: { conversation_id: UUID } }),
      code('Format Notification', 'd_format.js'),
      { name: 'Send Telegram', type: 'n8n-nodes-base.telegram', version: 1.2,
        parameters: { resource: 'message', operation: 'sendMessage', chatId: '={{ $json.chat_id }}', text: '={{ $json.text }}', additionalFields: { appendAttribution: false, disable_web_page_preview: true, parse_mode: 'HTML' } },
        credentials: cred(CRED.telegram), onError: 'continueRegularOutput' },
    ],
    edges: [['Notify Request', 0, 'Load Facts'], ['Load Facts', 0, 'Format Notification'], ['Format Notification', 0, 'Send Telegram']],
  };

  W.c_dispatch = {
    name: 'WA · C Dispatcher', file: 'c_dispatcher.json',
    settings: { saveDataSuccessExecution: 'none' },
    nodes: [
      webhook('Dispatch Webhook', 'wa-dispatch'),
      execTrigger('Dispatch Request'),
      schedule('Every 15 Seconds', { field: 'seconds', secondsInterval: 15 }),
      pg('Due Outbound', 'SELECT outbound_id FROM app.due_outbound(20)', null),
      execWf('Dispatch Each', 'self', 'each', false),
      pg('Claim Outbound', `SELECT app.claim_outbound((p->>'outbound_id')::uuid, 'n8n:' || coalesce(p->>'exec', '')) AS claim FROM ${jsonParam()}
       WHERE p->>'outbound_id' ~* '^[0-9a-f-]{36}$'`,
        "{ outbound_id: $json.body ? $json.body.outbound_id : $json.outbound_id, exec: $execution.id }", { sample: { outbound_id: UUID, exec: '1' } }),
      code('Build Send', 'c_build.js'),
      routeSwitch('Route Send', ['send', 'upload', 'record']),
      pg('Load Upload', `SELECT u.* FROM ${jsonParam()}, app.get_outbound_upload((p->>'outbound_id')::uuid) u`, '{ outbound_id: $json.outbound_id }', { sample: { outbound_id: UUID } }),
      http('Presign Upload', { method: 'POST', url: ZERNIO + '/v1/media/presign', auth: CRED.zernio,
        json: "={{ JSON.stringify({ filename: $json.file_name, contentType: $json.mime_type, size: $json.size_bytes }) }}", timeout: 20000 }),
      code('Prepare Upload', 'c_upload_file.js'),
      routeSwitch('Upload Route', ['put', 'record']),
      http('Upload File', { method: 'PUT', url: '={{ $json.upload_url }}', binary: true, full: true, timeout: 60000 }),
      code('After Upload', 'c_after_upload.js'),
      routeSwitch('After Upload Route', ['send', 'record']),
      pg('Save Media URL', `SELECT app.set_outbound_media_url((p->>'outbound_id')::uuid, p->>'url') AS ok FROM ${jsonParam()}`,
        '{ outbound_id: $json.outbound_id, url: $json.public_url }', { sample: { outbound_id: UUID, url: 'https://x' } }),
      code('Send Ready', 'c_send_ready.js'),
      http('Send Message', { method: 'POST', url: "={{ '" + ZERNIO + "' + $json.path }}", auth: CRED.zernio,
        headers: [['Idempotency-Key', '={{ $json.idempotency_key }}']], json: '={{ JSON.stringify($json.send_body) }}', full: true, timeout: 30000 }),
      code('Classify Result', 'c_classify.js'),
      pg('Record Result', `SELECT app.record_send_result((p->>'outbound_id')::uuid, (p->>'attempt_no')::int, r->>'outcome', (r->>'http_status')::int,
         r->>'provider_message_id', nullif(r->'response', 'null'::jsonb), nullif(r->'error', 'null'::jsonb), (r->>'retry_after_seconds')::int) AS r
       FROM ${jsonParam()}, LATERAL (SELECT p->'record' AS r) y`, '$json',
        { sample: { outbound_id: UUID, attempt_no: 1, record: { outcome: 'accepted' } } }),
    ],
    edges: [
      ['Dispatch Webhook', 0, 'Claim Outbound'], ['Dispatch Request', 0, 'Claim Outbound'],
      ['Every 15 Seconds', 0, 'Due Outbound'], ['Due Outbound', 0, 'Dispatch Each'],
      ['Claim Outbound', 0, 'Build Send'], ['Build Send', 0, 'Route Send'],
      ['Route Send', 0, 'Send Ready'], ['Route Send', 1, 'Load Upload'], ['Route Send', 2, 'Record Result'],
      ['Load Upload', 0, 'Presign Upload'], ['Presign Upload', 0, 'Prepare Upload'], ['Prepare Upload', 0, 'Upload Route'],
      ['Upload Route', 0, 'Upload File'], ['Upload Route', 1, 'Record Result'],
      ['Upload File', 0, 'After Upload'], ['After Upload', 0, 'After Upload Route'],
      ['After Upload Route', 0, 'Save Media URL'], ['After Upload Route', 1, 'Record Result'],
      ['Save Media URL', 0, 'Send Ready'], ['Send Ready', 0, 'Send Message'], ['Send Message', 0, 'Classify Result'], ['Classify Result', 0, 'Record Result'],
    ],
  };

  W.a2_media = {
    name: 'WA · A2 Media Download', file: 'a2_media_download.json',
    settings: { saveDataSuccessExecution: 'none' },
    nodes: [
      execTrigger('Media Request'),
      pg('Load Pending', `SELECT app.pending_attachments(ARRAY(SELECT jsonb_array_elements_text(coalesce(p->'ids', '[]')))::uuid[]) AS list,
       app.setting('attachments') AS cfg FROM ${jsonParam()}`, '{ ids: $json.attachment_ids || $json.media || [] }', { sample: { ids: [UUID] } }),
      code('Plan Downloads', 'a2_plan.js'),
      http('Download Media', { url: "={{ $json.blocked ? '' : $json.url }}", auth: CRED.zernio, full: true, file: true, timeout: 30000 }),
      code('Check Download', 'a2_check.js'),
      ifNode('Downloaded?', isTrue('={{ $json.ok }}')),
      pg('Store Blob', `SELECT app.store_attachment_blob((p->>'attachment_id')::uuid, p->>'mime', p->>'data_base64', (p->>'max_bytes')::int,
         ARRAY(SELECT jsonb_array_elements_text(p->'allowed'))) AS r FROM ${jsonParam()}`, '$json',
        { sample: { attachment_id: UUID, mime: 'image/png', data_base64: 'iVBORw0KGgo=', max_bytes: 100, allowed: ['image/png'] } }),
      pg('Mark Failed', `SELECT app.mark_attachment_fetch_failed((p->>'attachment_id')::uuid, p->>'status', p->>'error') AS ok FROM ${jsonParam()}`, '$json',
        { sample: { attachment_id: UUID, status: 'expired', error: 'http_400' } }),
    ],
    edges: [['Media Request', 0, 'Load Pending'], ['Load Pending', 0, 'Plan Downloads'], ['Plan Downloads', 0, 'Download Media'],
      ['Download Media', 0, 'Check Download'], ['Check Download', 0, 'Downloaded?'], ['Downloaded?', 0, 'Store Blob'], ['Downloaded?', 1, 'Mark Failed']],
  };

  const shop = "$('Load Shop').first().json.base";
  const args = "$('Woo Tool Request').first().json.args";
  const store = (p) => '={{ ' + shop + " }}/wp-json/wc/store/v1/products" + p;
  W.e_woo = {
    name: 'WA · E WooCommerce Tools', file: 'e_woocommerce_tools.json',
    nodes: [
      execTrigger('Woo Tool Request'),
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
        credentials: cred(CRED.woo), onError: 'continueRegularOutput', alwaysOutputData: true },
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
  };

  W.b2_vision = {
    name: 'WA · B2 Image Analysis', file: 'b2_image_analysis.json',
    // Execution data would contain the image bytes: successful runs are not stored.
    settings: { saveDataSuccessExecution: 'none' },
    nodes: [
      execTrigger('Image Request'),
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
  };

  W.b1_tools = {
    name: 'WA · B1 Tool Runner', file: 'b1_tool_runner.json',
    nodes: [
      execTrigger('Tool Call'),
      code('Check Tool Call', 't_check_call.js'),
      routeSwitch('Tool Route', ['knowledge', 'image', 'woo', 'invalid']),
      pg('Search Knowledge', `SELECT k.* FROM ${jsonParam()}, app.search_knowledge(p->>'q', 5) k`, '{ q: $json.args.query }', { alwaysOutputData: true, sample: { q: 'refund' } }),
      code('Format knowledge Result', 't_format_results.knowledge.js'),
      execWf('Analyze Image', 'b2_vision', 'each', true),
      code('Format image Result', 't_format_results.image.js'),
      execWf('Run Woo Tool', 'e_woo', 'each', true),
      code('Format woo Result', 't_format_results.woo.js'),
      code('Format invalid Result', 't_format_results.invalid.js'),
    ],
    edges: [['Tool Call', 0, 'Check Tool Call'], ['Check Tool Call', 0, 'Tool Route'],
      ['Tool Route', 0, 'Search Knowledge'], ['Search Knowledge', 0, 'Format knowledge Result'],
      ['Tool Route', 1, 'Analyze Image'], ['Analyze Image', 0, 'Format image Result'],
      ['Tool Route', 2, 'Run Woo Tool'], ['Run Woo Tool', 0, 'Format woo Result'],
      ['Tool Route', 3, 'Format invalid Result']],
  };

  const next3 = (n) => routeSwitch(n, ['tools', 'validate', 'fail'], '$json.next');
  W.b_reply = {
    name: 'WA · B AI Reply', file: 'b_ai_reply.json',
    nodes: [
      execTrigger('Reply Request'),
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
      execWf('R1 Run Tools', 'b1_tools', 'each', true),
      code('R1 Collect Tool Results', 'b_collect_tool_results.R1.js'),
      model('R2 Call Model', '$json.state.request'),
      code('R2 Parse Response', 'b_parse_response.R2.js'),
      next3('R2 Next'),
      code('R2 Split Tool Calls', 'b_split_tool_calls.R2.js'),
      execWf('R2 Run Tools', 'b1_tools', 'each', true),
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
      execWf('Dispatch Reply', 'c_dispatch', 'each', false),
      execWf('Notify Staff', 'd_notify', 'each', false),
    ],
    edges: [
      ['Reply Request', 0, 'Load Debounce'], ['Load Debounce', 0, 'Burst Wait'], ['Burst Wait', 0, 'Start Job'], ['Start Job', 0, 'Resolve Job'],
      ['AI Job Webhook', 0, 'Resolve Job'], ['Resolve Job', 0, 'Load Context'], ['Load Context', 0, 'Prepare Turn'], ['Prepare Turn', 0, 'Ready?'],
      ['Ready?', 0, 'R1 Call Model'], ['Ready?', 1, 'Fail Job'],
      ['R1 Call Model', 0, 'R1 Parse Response'], ['R1 Parse Response', 0, 'R1 Next'],
      ['R1 Next', 0, 'R1 Split Tool Calls'], ['R1 Next', 1, 'Validate & Decide'], ['R1 Next', 2, 'Validate & Decide'],
      ['R1 Split Tool Calls', 0, 'R1 Run Tools'], ['R1 Run Tools', 0, 'R1 Collect Tool Results'], ['R1 Collect Tool Results', 0, 'R2 Call Model'],
      ['R2 Call Model', 0, 'R2 Parse Response'], ['R2 Parse Response', 0, 'R2 Next'],
      ['R2 Next', 0, 'R2 Split Tool Calls'], ['R2 Next', 1, 'Validate & Decide'], ['R2 Next', 2, 'Validate & Decide'],
      ['R2 Split Tool Calls', 0, 'R2 Run Tools'], ['R2 Run Tools', 0, 'R2 Collect Tool Results'], ['R2 Collect Tool Results', 0, 'R3 Call Model'],
      ['R3 Call Model', 0, 'R3 Parse Response'], ['R3 Parse Response', 0, 'Validate & Decide'],
      ['Validate & Decide', 0, 'Decision'],
      ['Decision', 0, 'Build Repair Request'], ['Build Repair Request', 0, 'R4 Call Model'], ['R4 Call Model', 0, 'R4 Parse Response'], ['R4 Parse Response', 0, 'Validate & Decide'],
      ['Decision', 1, 'Submit Result'], ['Decision', 1, 'Record Usage'], ['Decision', 2, 'Fail Invalid Job'], ['Decision', 2, 'Record Usage'],
      ['Submit Result', 0, 'After Submit'], ['After Submit', 0, 'Follow Up'], ['Follow Up', 0, 'Dispatch Reply'], ['Follow Up', 1, 'Notify Staff'],
    ],
  };

  const plan = "$('Plan Route').first().json";
  W.a_router = {
    name: 'WA · A Router', file: 'a_router.json',
    nodes: [
      webhook('Router Webhook', 'wa-router'),
      code('Plan Route', 'a_plan.js'),
      ifNode('Valid?', isTrue('={{ $json.valid }}')),
      ifNode('Has Media?', isTrue('={{ $json.has_media }}')),
      execWf('Fetch Media', 'a2_media', 'once', true, { alwaysOutputData: true }),
      noop('After Media'),
      switchNode('Route Actions', [
        ['ai', isTrue('={{ ' + plan + '.ai }}')],
        ['dispatch', isTrue('={{ ' + plan + '.dispatch }}')],
        ['notify', isTrue('={{ ' + plan + '.notify }}')],
      ], true),
      setRaw('AI Input', plan + '.ai_input'),
      execWf('Start AI Reply', 'b_reply', 'once', false),
      pg('Queued Outbound', `SELECT o.id AS outbound_id FROM ${jsonParam()}, app.outbound_messages o
       WHERE o.conversation_id = (p->>'c')::uuid AND o.status = 'queued' ORDER BY o.created_at LIMIT 5`, '{ c: ' + plan + '.conversation_id }', { executeOnce: true, sample: { c: UUID } }),
      execWf('Dispatch Queued', 'c_dispatch', 'each', false),
      setRaw('Notify Input', plan + '.notify_input'),
      execWf('Notify Staff', 'd_notify', 'once', false),
    ],
    edges: [['Router Webhook', 0, 'Plan Route'], ['Plan Route', 0, 'Valid?'], ['Valid?', 0, 'Has Media?'],
      ['Has Media?', 0, 'Fetch Media'], ['Has Media?', 1, 'After Media'], ['Fetch Media', 0, 'After Media'], ['After Media', 0, 'Route Actions'],
      ['Route Actions', 0, 'AI Input'], ['AI Input', 0, 'Start AI Reply'],
      ['Route Actions', 1, 'Queued Outbound'], ['Queued Outbound', 0, 'Dispatch Queued'],
      ['Route Actions', 2, 'Notify Input'], ['Notify Input', 0, 'Notify Staff']],
  };

  W.f_sync = {
    name: 'WA · F Woo Sync', file: 'f_woo_sync.json',
    nodes: [
      webhook('Woo Event Webhook', 'wa-woo-event'),
      pg('Load Event', `SELECT app.get_webhook_event((p->>'id')::uuid) AS ev FROM ${jsonParam()} WHERE p->>'id' ~* '^[0-9a-f-]{36}$'`, '{ id: $json.body && $json.body.event_id }', { sample: { id: UUID } }),
      code('Map webhook', 'f_map.webhook.js'),
      routeSwitch('Sync Route', ['products', 'order']),
      pg('Upsert Products', `SELECT app.upsert_woo_products(coalesce(p->'items', '[]')) AS n FROM ${jsonParam()}`, '{ items: $json.items }', { sample: { items: [] } }),
      pg('Upsert Order', `SELECT app.upsert_woo_order_ref(p) AS r, app.setting('followups') AS followups FROM ${jsonParam()}`, '$json.order',
        { sample: { id: 1, status: 'processing', total: '1', billing: {} } }),
      code('Order Update Messages', 'f_order_notify.js'),
      pg('Queue Order Update', `SELECT app.enqueue_system_message((p->>'conversation_id')::uuid, 'notification', 'utility', p->>'body', '{}'::jsonb, p->>'dedupe') AS r FROM ${jsonParam()}`,
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
      ['Every 6 Hours', 0, 'Load Shop URL'], ['Load Shop URL', 0, 'Fetch Catalogue'], ['Fetch Catalogue', 0, 'Map catalogue'], ['Map catalogue', 0, 'Upsert Catalogue']],
  };

  W.g_memory = {
    name: 'WA · G Memory', file: 'g_memory.json',
    nodes: [
      schedule('Every 10 Minutes', { field: 'minutes', minutesInterval: 10 }),
      pg('Conversations To Summarize', 'SELECT conversation_id FROM app.conversations_needing_summary(20)', null),
      execWf('Summarize Each', 'self', 'each', true),
      execTrigger('Summary Request'),
      pg('Load Summary Input', `SELECT app.summary_input((p->>'c')::uuid) AS inp, app.setting('models') AS models, app.ai_budget_status() AS budget,
         (SELECT body FROM app.prompt_versions WHERE name = 'summary_system' AND status = 'published') AS prompt FROM ${jsonParam()}`,
        '{ c: $json.conversation_id }', { sample: { c: UUID } }),
      code('Prepare Summary Request', 'g_prepare.js'),
      ifNode('Summarize?', cond('={{ $json.skip }}', { type: 'boolean', operation: 'false', singleValue: true })),
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
    edges: [['Every 10 Minutes', 0, 'Conversations To Summarize'], ['Conversations To Summarize', 0, 'Summarize Each'],
      ['Summary Request', 0, 'Load Summary Input'], ['Load Summary Input', 0, 'Prepare Summary Request'], ['Prepare Summary Request', 0, 'Summarize?'],
      ['Summarize?', 0, 'Call Summary Model'], ['Call Summary Model', 0, 'Validate Summary'], ['Validate Summary', 0, 'Summary Valid?'],
      ['Summary Valid?', 0, 'Save Summary'], ['Summary Valid?', 1, 'Record Summary Usage']],
  };

  W.h_learning = {
    name: 'WA · H Daily Learning', file: 'h_daily_learning.json',
    settings: { timezone: 'Asia/Dhaka' },
    nodes: [
      schedule('Daily 03:15', { field: 'days', daysInterval: 1, triggerAtHour: 3, triggerAtMinute: 15 }),
      pg('Load Learning Input', `SELECT app.learning_candidates(now() - interval '1 day', 30) AS cands, app.published_knowledge_index() AS kb,
         app.setting('models') AS models, app.ai_budget_status() AS budget,
         (SELECT body FROM app.prompt_versions WHERE name = 'learning_system' AND status = 'published') AS prompt`, null),
      code('Prepare Learning Request', 'h_prepare.js'),
      ifNode('Learn?', cond('={{ $json.skip }}', { type: 'boolean', operation: 'false', singleValue: true })),
      model('Call Learning Model', '$json.request', 180000),
      code('Validate Proposals', 'h_validate.js'),
      pg('Submit Proposal', `SELECT app.submit_knowledge_proposal(p->>'kind', app.document_id_for_slug(p->>'slug'), p->>'category', p->>'title', p->>'body',
         p->>'rationale', p->'evidence', p->'redaction', p->>'run') AS id FROM (SELECT $1::jsonb->'proposal' AS p) x WHERE jsonb_typeof(p) = 'object'`, '$json',
        { sample: { proposal: { kind: 'new', slug: null, category: 'faq', title: 't', body: 'b', rationale: 'r', evidence: {}, redaction: {}, run: 'r' } } }),
      pg('Record Learning Usage', `SELECT app.record_ai_usage(NULL, 'learning', p->'usage') AS id FROM ${jsonParam()}`, '{ usage: $json.usage }', { executeOnce: true, sample: { usage: {} } }),
    ],
    edges: [['Daily 03:15', 0, 'Load Learning Input'], ['Load Learning Input', 0, 'Prepare Learning Request'], ['Prepare Learning Request', 0, 'Learn?'],
      ['Learn?', 0, 'Call Learning Model'], ['Call Learning Model', 0, 'Validate Proposals'], ['Validate Proposals', 0, 'Submit Proposal'], ['Validate Proposals', 0, 'Record Learning Usage']],
  };

  W.i_maintenance = {
    name: 'WA · I Maintenance', file: 'i_maintenance.json',
    settings: { saveDataSuccessExecution: 'none', timezone: 'Asia/Dhaka' },
    nodes: [
      schedule('Every Minute', { field: 'minutes', minutesInterval: 1 }),
      pg('Expire Leases', "SELECT app.expire_send_leases() AS expired, app.record_health('n8n_maintenance', 'ok', jsonb_build_object('at', now())) IS NULL AS health", null),
      pg('Sweep URL', "SELECT app.setting('dashboard_url') #>> '{}' AS url", null),
      // Backend retry of webhook events that were stored but not finished
      // (crash, deploy, deferred echoes) and of routing calls n8n missed.
      http('Sweep Events', { method: 'POST', url: "={{ $json.url }}/api/internal/events/sweep", auth: CRED.backend, json: '={}', timeout: 20000 }),
      pg('Claim Alerts', `UPDATE app.alerts SET notified_at = now() WHERE id IN (
         SELECT id FROM app.alerts WHERE resolved_at IS NULL AND notified_at IS NULL ORDER BY created_at LIMIT 10 FOR UPDATE SKIP LOCKED)
       RETURNING id, kind, severity, message, details`, null, { executeOnce: true }),
      setRaw('Alert Input', '{ alert: $json, reason: $json.kind }'),
      execWf('Notify Alert', 'd_notify', 'each', false),
      schedule('Every 5 Minutes', { field: 'minutes', minutesInterval: 5 }),
      pg('Overdue Reminders', `SELECT count(app.raise_alert('response_overdue', 'info', 'A customer is waiting past the response target.',
         jsonb_build_object('conversation_id', x->>'conversation_id'), 'overdue:' || (x->>'conversation_id') || ':' || (x->>'due_at'))) AS raised
       FROM jsonb_array_elements(app.overdue_conversations()) x`, null),
      pg('Pending Media', `SELECT jsonb_agg(x->'attachment_id') AS attachment_ids FROM jsonb_array_elements(app.pending_attachments(NULL)) x HAVING count(*) > 0`, null, { executeOnce: true }),
      execWf('Retry Media', 'a2_media', 'once', false),
      pg('Unknown Sends', `SELECT x->>'outbound_id' AS outbound_id, x->>'body' AS body, x->>'created_at' AS created_at,
         x->>'provider_conversation_id' AS provider_conversation_id, x->>'provider_account_id' AS provider_account_id
       FROM jsonb_array_elements(app.unknown_sends_for_reconcile()) x`, null, { executeOnce: true }),
      execWf('Reconcile Each', 'self', 'each', false),
      execTrigger('Unknown Send'),
      http('List Provider Messages', { url: "={{ '" + ZERNIO + "/v1/inbox/conversations/' + encodeURIComponent($json.provider_conversation_id) + '/messages' }}", auth: CRED.zernio,
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
    edges: [['Every Minute', 0, 'Expire Leases'], ['Expire Leases', 0, 'Claim Alerts'], ['Every Minute', 0, 'Sweep URL'], ['Sweep URL', 0, 'Sweep Events'], ['Claim Alerts', 0, 'Alert Input'], ['Alert Input', 0, 'Notify Alert'],
      ['Every 5 Minutes', 0, 'Overdue Reminders'], ['Every 5 Minutes', 0, 'Pending Media'], ['Pending Media', 0, 'Retry Media'],
      ['Every 5 Minutes', 0, 'Unknown Sends'], ['Unknown Sends', 0, 'Reconcile Each'],
      ['Unknown Send', 0, 'List Provider Messages'], ['List Provider Messages', 0, 'Match Unknown Send'], ['Match Unknown Send', 0, 'Reconcile Route'],
      ['Reconcile Route', 0, 'Resolve Send'], ['Reconcile Route', 1, 'Attach Evidence'],
      ['Daily 04:10', 0, 'Apply Retention']],
  };

  W.j_history = {
    name: 'WA · J History Import', file: 'j_history_import.json',
    settings: { saveDataSuccessExecution: 'none' },
    nodes: [
      { name: 'Run Import', type: 'n8n-nodes-base.manualTrigger', version: 1, parameters: {}, trigger: true },
      pg('History Targets', "SELECT x AS t FROM jsonb_array_elements(app.history_import_targets(200)) x", null),
      execWf('Import Each', 'self', 'each', true),
      execTrigger('History Target Input'),
      setRaw('History Target', '$json.t || $json'),
      http('Fetch History Page', { url: "={{ '" + ZERNIO + "/v1/inbox/conversations/' + encodeURIComponent($('History Target').first().json.provider_conversation_id) + '/messages' }}", auth: CRED.zernio,
        query: [['accountId', "={{ $('History Target').first().json.provider_account_id }}"], ['limit', '100']], timeout: 30000,
        pagination: { paginationMode: 'updateAParameterInEachRequest', parameters: { parameters: [{ type: 'qs', name: 'cursor', value: '={{ $response.body.pagination && $response.body.pagination.nextCursor }}' }] },
          paginationCompleteWhen: 'other', completeExpression: '={{ !($response.body.pagination && $response.body.pagination.hasMore) }}', limitPagesFetched: true, maxRequests: 50, requestInterval: 300 } }),
      code('Map History Page', 'j_map.js'),
      http('Store History Page', { method: 'POST', url: "={{ $('Dashboard URL').first().json.url }}/api/internal/history-import", auth: CRED.backend,
        json: '={{ JSON.stringify($json.body) }}', timeout: 60000 }),
      pg('Dashboard URL', "SELECT app.setting('dashboard_url') #>> '{}' AS url", null, { executeOnce: true }),
    ],
    edges: [['Run Import', 0, 'History Targets'], ['History Targets', 0, 'Import Each'],
      ['History Target Input', 0, 'History Target'], ['History Target', 0, 'Dashboard URL'], ['Dashboard URL', 0, 'Fetch History Page'],
      ['Fetch History Page', 0, 'Map History Page'], ['Map History Page', 0, 'Store History Page']],
  };
  return W;
}

// Creation order: sub-workflows before the workflows that call them.
export const ORDER = ['z_error', 'd_notify', 'c_dispatch', 'a2_media', 'e_woo', 'b2_vision', 'b1_tools', 'b_reply', 'a_router', 'f_sync', 'g_memory', 'h_learning', 'i_maintenance', 'j_history'];

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
function layout(def) {
  const depth = {};
  const byFrom = {};
  for (const [f, , t] of def.edges) (byFrom[f] = byFrom[f] || []).push(t);
  const triggers = def.nodes.filter((n) => n.trigger).map((n) => n.name);
  const q = triggers.map((t) => [t, 0]);
  while (q.length) {
    const [n, d] = q.shift();
    if (depth[n] !== undefined && depth[n] >= d) continue;
    if (d > def.nodes.length) continue;
    depth[n] = d;
    for (const t of byFrom[n] || []) q.push([t, d + 1]);
  }
  const rows = {};
  const pos = {};
  for (const n of def.nodes) {
    const d = depth[n.name] ?? 0;
    rows[d] = (rows[d] || 0) + 1;
    pos[n.name] = [d * 260, (rows[d] - 1) * 180];
  }
  return pos;
}

function toN8nJson(key, def) {
  const pos = layout(def);
  const nodes = def.nodes.map((n, i) => {
    const o = { id: key + '-' + String(i + 1).padStart(2, '0'), name: n.name, type: n.type, typeVersion: n.version, position: pos[n.name], parameters: n.parameters };
    if (n.credentials) o.credentials = n.credentials;
    if (n.webhookId) o.webhookId = n.webhookId;
    for (const k of ['onError', 'executeOnce', 'alwaysOutputData', 'retryOnFail']) if (n[k] !== undefined) o[k] = n[k];
    return o;
  });
  const connections = {};
  for (const [f, oi, t, ti] of def.edges) {
    const c = (connections[f] = connections[f] || { main: [] });
    while (c.main.length <= oi) c.main.push([]);
    c.main[oi].push({ node: t, type: 'main', index: ti || 0 });
  }
  return { name: def.name, nodes, connections, settings: { executionOrder: 'v1', ...(def.settings || {}) }, pinData: {}, meta: { templateCredsSetupCompleted: false } };
}

// placeholders: Code nodes get a one-line stub; their code is then set with
// update_workflow setNodeParameter('/jsCode') (keeps each MCP call small).
function toSdk(key, def, placeholders = false) {
  const vars = new Map(def.nodes.map((n, i) => [n.name, 'n' + i]));
  const lines = ["import { workflow, node, trigger, newCredential } from '@n8n/workflow-sdk';", ''];
  for (const n of def.nodes) {
    const parameters = placeholders && n.codeFile ? { jsCode: '// code from n8n/code/dist/' + n.codeFile + ' is set in a follow-up update\nreturn [];' } : n.parameters;
    const config = { name: n.name, parameters };
    for (const k of ['onError', 'executeOnce', 'alwaysOutputData']) if (n[k] !== undefined) config[k] = n[k];
    let cfg = JSON.stringify(config);
    if (n.credentials) {
      const [type, c] = Object.entries(n.credentials)[0];
      const credCode = c.id ? JSON.stringify({ id: c.id, name: c.name }) : 'newCredential(' + JSON.stringify(c.name) + ')';
      cfg = cfg.slice(0, -1) + ',"credentials":{' + JSON.stringify(type) + ':' + credCode + '}}';
    }
    // ASCII-only output (\uXXXX escapes): the code is copied through tool calls,
    // and escapes keep Bangla code points exact.
    cfg = cfg.replace(/[\u007f-\uffff]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
    lines.push(`const ${vars.get(n.name)} = ${n.trigger ? 'trigger' : 'node'}({ type: ${JSON.stringify(n.type)}, version: ${n.version}, config: ${cfg} });`);
  }
  lines.push('', `export default workflow(${JSON.stringify(key)}, ${JSON.stringify(def.name).replace(/[\u007f-\uffff]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'))})`);
  for (const n of def.nodes) lines.push(`  .add(${vars.get(n.name)})`);
  for (const [f, oi, t, ti] of def.edges) lines.push(`  .add(${vars.get(f)}.output(${oi}).to(${vars.get(t)}.input(${ti || 0})))`);
  return lines.join('\n') + ';\n';
}

export async function loadIds() {
  const p = path.join(outDir, 'ids.json');
  return existsSync(p) ? JSON.parse(await readFile(p, 'utf8')) : {};
}

// Returns { key: { def, json, sdk } } for workflows whose dependencies have ids.
export async function generate() {
  dist = await buildAll();
  ids = await loadIds();
  const out = {};
  // Placeholder ids let every workflow render; creation order fills the real ones.
  const realIds = { ...ids };
  for (const k of ORDER) if (!ids[k]) ids[k] = 'PENDING_' + k;
  const defs = definitions();
  for (const k of ORDER) out[k] = { def: defs[k], json: toN8nJson(k, defs[k]), sdk: toSdk(k, defs[k]), sdkStub: toSdk(k, defs[k], true), pendingDeps: [] };
  for (const k of ORDER) {
    out[k].pendingDeps = defs[k].nodes.filter((n) => n.type === 'n8n-nodes-base.executeWorkflow' && String(n.parameters.workflowId.value).startsWith('PENDING_'))
      .map((n) => n.parameters.workflowId.value.slice(8));
  }
  ids = realIds;
  return out;
}

if (process.argv[1] && process.argv[1].endsWith('workflows.mjs')) {
  const g = await generate();
  await mkdir(outDir, { recursive: true });
  const manifest = {};
  for (const k of ORDER) {
    const { def, json } = g[k];
    await writeFile(path.join(outDir, def.file), JSON.stringify(json, null, 2) + '\n');
    manifest[def.file] = Object.fromEntries(def.nodes.filter((n) => n.codeFile).map((n) => [n.name, n.codeFile]));
  }
  await writeFile(path.join(outDir, 'code-nodes.json'), JSON.stringify(manifest, null, 2) + '\n');
  const sdkIdx = process.argv.indexOf('--sdk');
  if (sdkIdx > 0) {
    const dir = process.argv[sdkIdx + 1];
    await mkdir(dir, { recursive: true });
    for (const k of ORDER) {
      await writeFile(path.join(dir, k + '.sdk.js'), g[k].sdk);
      await writeFile(path.join(dir, k + '.stub.sdk.js'), g[k].sdkStub);
      // One setNodeParameter operation per Code node, for update_workflow.
      const ops = g[k].def.nodes.filter((n) => n.codeFile).map((n) => ({ type: 'setNodeParameter', nodeName: n.name, path: '/jsCode', value: n.parameters.jsCode }));
      await writeFile(path.join(dir, k + '.code-ops.json'), JSON.stringify(ops, null, 1));
    }
  }
  const pending = ORDER.filter((k) => g[k].pendingDeps.length).map((k) => k + ' -> ' + g[k].pendingDeps.join(','));
  console.log(`wrote ${ORDER.length} workflows` + (pending.length ? `; waiting for ids: ${pending.join('; ')}` : ''));
}
