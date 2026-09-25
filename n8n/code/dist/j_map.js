// WA · J History Import — "Map History Page"
// Input: pages of GET /v1/inbox/conversations/{id}/messages for ONE known
// conversation (cursor pagination). Each page becomes one call to the
// backend's /api/internal/history-import, which stores the messages as
// historical: they are shown to staff but never routed or answered.

const t = $('History Target').first().json;
const out = [];
for (const it of $input.all()) {
  const page = it.json && it.json.body ? it.json.body : it.json;
  const msgs = Array.isArray(page && page.messages) ? page.messages : [];
  const mapped = msgs.filter((m) => m && m.id && m.createdAt && (m.direction === 'incoming' || m.direction === 'outgoing')).slice(0, 100).map((m) => {
    const att = Array.isArray(m.attachments) && m.attachments[0] ? m.attachments[0].type : null;
    const kinds = ['image', 'audio', 'video', 'file', 'sticker', 'template'];
    return {
      provider_message_id: String(m.id).slice(0, 300),
      direction: m.direction,
      text: typeof m.message === 'string' ? m.message.slice(0, 10000) : null,
      sent_at: m.createdAt,
      kind: att && kinds.indexOf(att) >= 0 ? att : (typeof m.message === 'string' && m.message ? 'text' : 'unsupported'),
    };
  });
  if (!mapped.length) continue;
  out.push({ json: { body: {
    provider_account_id: t.provider_account_id,
    provider_conversation_id: t.provider_conversation_id,
    participant: t.participant,
    messages: mapped,
  } } });
}
return out;
