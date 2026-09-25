// WA · C Dispatcher — "Send Ready"
// Joins the direct path and the upload path: the item the "Send Message"
// request is built from. Runs only on a claimed row.

// In the single workflow this runs inside the dispatch loop: "After Upload"
// may hold the result of an EARLIER message, so it is only used when it
// belongs to the message being sent now.
const b = $('Build Send').first().json;
const viaUpload = $('After Upload').isExecuted ? $('After Upload').first().json : null;
const s = viaUpload && viaUpload.route === 'send' && viaUpload.outbound_id === b.outbound_id && viaUpload.attempt_no === b.attempt_no ? viaUpload : b;
return [{ json: { outbound_id: s.outbound_id, attempt_no: s.attempt_no, idempotency_key: s.idempotency_key, kind: s.kind, path: s.path, send_body: s.send_body } }];
