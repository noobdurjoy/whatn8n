// WA · C Dispatcher — "Send Ready"
// Joins the direct path and the upload path: the item the "Send Message"
// request is built from. Runs only on a claimed row.

const viaUpload = $('After Upload').isExecuted ? $('After Upload').first().json : null;
const s = viaUpload && viaUpload.route === 'send' ? viaUpload : $('Build Send').first().json;
return [{ json: { outbound_id: s.outbound_id, attempt_no: s.attempt_no, idempotency_key: s.idempotency_key, kind: s.kind, path: s.path, send_body: s.send_body } }];
