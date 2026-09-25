// WA · B AI Reply — "Resolve Job"
// Two entries: (1) the router, after the burst debounce, started a reply job
// with start_ai_job (refused if a newer message arrived, the mode changed,
// AI is off, or a hold is set); (2) the backend already started a
// staff-assist or sandbox job and called the wa-ai-job webhook.

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if ($('AI Job Webhook').isExecuted) {
  const b = ($('AI Job Webhook').first().json || {}).body || {};
  if (!uuid.test(String(b.job_id || ''))) return [];
  return [{ json: { job_id: b.job_id, sandbox: Boolean(b.sandbox), include_images: Boolean(b.include_images), possible_handoff: false } }];
}
const started = ($input.first().json || {}).r || {};
if (!started.started) return [];
const t = $('Reply Request').first().json;
return [{ json: { job_id: started.job_id, sandbox: false, include_images: true, possible_handoff: Boolean(t.possible_handoff) } }];
