// WA · B2 Image Analysis — "Vision Output"
// Last node of the sub-workflow; its item is what the Tool Runner receives:
// { ok, ref, result, reused, attempted, usage, error }.
// The vision model's output is only returned as observations. It never sends
// a message or triggers an order action; the reply model uses it, and the
// usual validation and dispatch checks still apply.

const inp = $input.first().json || {};
if (inp.final) return [{ json: inp.final }];

const v = $('Validate Vision Result').first().json;
const stored = inp; // { analysis_id, cur } from "Store Analysis"
const current = stored.cur && stored.cur.current;
const out = { ok: false, ref: null, result: null, reused: false, attempted: true, usage: null, error: v.error };
// Usage was recorded by "Store Analysis"; it is not returned again to avoid
// double counting in the reply job.
if (!current) {
  // A takeover or a newer message arrived during analysis: the stored result
  // can be reused later, but this job must not use it.
  out.error = 'job_not_current';
} else if (v.status === 'ok') {
  out.ok = true;
  out.ref = 'img:' + stored.analysis_id;
  out.result = v.result;
  out.error = null;
}
return [{ json: out }];
