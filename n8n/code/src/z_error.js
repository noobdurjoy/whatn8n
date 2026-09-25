// WA · Z Error Handler — "Format Error"
// Any WA workflow that fails raises one dashboard alert per workflow and hour
// (the maintenance workflow forwards alerts to staff). Only the failing node
// and a short error message are kept; no input data is copied.

const e = $input.first().json || {};
const wf = e.workflow || {};
const ex = e.execution || {};
const msg = String((ex.error && ex.error.message) || '').replace(/\s+/g, ' ').slice(0, 300);
return [{ json: {
  message: ('Workflow failed: ' + String(wf.name || 'unknown')).slice(0, 200),
  details: { workflow_id: wf.id || null, workflow: wf.name || null, execution_id: ex.id || null, node: ex.lastNodeExecuted || null, error: msg, url: ex.url || null },
  dedupe: 'workflow_error:' + (wf.id || 'unknown') + ':' + new Date().toISOString().slice(0, 13),
} }];
