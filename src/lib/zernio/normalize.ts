// Normalizes Zernio webhook payloads into the shapes the ingest step stores.
// Field names follow Zernio's OpenAPI spec (WebhookPayloadMessage,
// WebhookPayloadMessageSent, WebhookPayloadMessageDeliveryStatus, ...).
// Unknown fields are ignored; missing required fields make the event 'failed'
// (kept for review), never guessed.

export type NormalizedAttachment = {
  position: number;
  media_type: string;
  mime_type: string | null;
  file_name: string | null;
  provider_media_ref: string | null;
};

export type NormalizedMessage = {
  provider_internal_id: string | null;
  provider_message_id: string;
  provider_conversation_id: string;
  platform_conversation_id: string | null;
  provider_account_id: string;
  account_username: string | null;
  account_display_name: string | null;
  platform: string;
  direction: 'incoming' | 'outgoing';
  text: string | null;
  sent_at: string;
  attachments: NormalizedAttachment[];
  // Customer identity (incoming) or the conversation participant (outgoing).
  participant: {
    bsuid: string | null;
    phone_e164: string | null;
    participant_id: string | null;
    display_name: string | null;
    provider_contact_id: string | null;
  };
  sent_via: string | null;     // message.sent only
  source: string | null;       // message.sent only (WhatsApp)
  standby: boolean;            // Meta Business Agent holds the thread
  quoted_provider_id: string | null;
  interactive: Record<string, unknown> | null;
  kind: string;
};

export type NormalizedEvent =
  | { type: 'message.received'; event_id: string; message: NormalizedMessage }
  | { type: 'message.sent'; event_id: string; message: NormalizedMessage }
  | { type: 'message.status'; event_id: string; status: 'delivered' | 'read' | 'failed'; provider_message_id: string;
      provider_conversation_id: string; provider_account_id: string; status_at: string; error: Record<string, unknown> | null }
  | { type: 'message.edited' | 'message.deleted'; event_id: string; provider_message_id: string; provider_conversation_id: string;
      provider_account_id: string; direction: string; text: string | null; at: string }
  | { type: 'reaction.received'; event_id: string; provider_conversation_id: string; provider_account_id: string;
      provider_message_id: string; emoji: string; action: string; at: string }
  | { type: 'conversation.control_changed'; event_id: string; provider_conversation_id: string; owner: string | null }
  | { type: 'account.status'; event_id: string; provider_account_id: string | null; status: string; raw_event: string }
  | { type: 'ignored'; event_id: string; reason: string };

export class NormalizeError extends Error {}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function req(v: unknown, name: string): string {
  const s = str(v);
  if (!s) throw new NormalizeError(`missing ${name}`);
  return s;
}

const KIND_BY_ATTACHMENT: Record<string, string> = {
  image: 'image', video: 'video', audio: 'audio', file: 'file', sticker: 'sticker', share: 'file',
  location: 'location', contact: 'contacts',
};

function normalizeMessage(p: any, eventType: string): NormalizedMessage {
  const m = p.message ?? {};
  const conv = p.conversation ?? {};
  const acct = p.account ?? {};
  const meta = (p.metadata ?? m.metadata ?? {}) as Record<string, any>;
  const sender = m.sender ?? {};
  const atts: NormalizedAttachment[] = Array.isArray(m.attachments)
    ? m.attachments.slice(0, 10).map((a: any, i: number) => ({
        position: i,
        media_type: str(a?.type) ?? 'file',
        mime_type: str(a?.mimeType),
        file_name: str(a?.payload?.filename) ?? str(a?.name),
        // WhatsApp: an authenticated Zernio media endpoint (needs the API key);
        // stored as a reference only, fetched server-side by the media workflow.
        provider_media_ref: str(a?.url),
      }))
    : [];
  const incoming = eventType === 'message.received';
  const interactive = meta.interactiveType || meta.buttonPayload || meta.order || meta.flowResponseData
    ? { type: meta.interactiveType ?? (meta.order ? 'order' : 'button'), id: meta.interactiveId ?? null,
        button_payload: meta.buttonPayload ?? null, order: meta.order ?? null, flow: meta.flowResponseData ?? null }
    : null;
  let kind = 'text';
  if (atts.length) kind = KIND_BY_ATTACHMENT[atts[0].media_type] ?? 'file';
  else if (meta.order) kind = 'order';
  else if (interactive) kind = 'interactive';
  else if (meta.location) kind = 'location';
  else if (meta.contacts) kind = 'contacts';
  if (!atts.length && !str(m.text) && !interactive && !meta.location && !meta.contacts) kind = 'unsupported';

  return {
    provider_internal_id: str(m.id),
    provider_message_id: req(m.platformMessageId, 'message.platformMessageId'),
    provider_conversation_id: req(m.conversationId ?? conv.id, 'message.conversationId'),
    platform_conversation_id: str(conv.platformConversationId),
    provider_account_id: req(acct.accountId ?? acct.id, 'account.id'),
    account_username: str(acct.username),
    account_display_name: str(acct.displayName),
    platform: req(m.platform ?? acct.platform, 'message.platform'),
    direction: m.direction === 'outgoing' ? 'outgoing' : 'incoming',
    text: typeof m.text === 'string' ? m.text : null,
    sent_at: req(m.sentAt ?? p.timestamp, 'message.sentAt'),
    attachments: atts,
    participant: incoming
      ? {
          bsuid: str(sender.businessScopedUserId),
          phone_e164: str(sender.phoneNumber),
          participant_id: str(sender.id) ?? str(conv.participantId),
          display_name: str(sender.name) ?? str(conv.participantName),
          provider_contact_id: str(sender.contactId) ?? str(conv.contactId),
        }
      : {
          // On message.sent the sender is our own business account; the
          // customer is the conversation participant (Zernio docs).
          bsuid: null,
          phone_e164: null,
          participant_id: str(conv.participantId),
          display_name: str(conv.participantName),
          provider_contact_id: str(conv.contactId),
        },
    sent_via: incoming ? null : (str(m.sentVia) ?? null),
    source: incoming ? null : str(m.source),
    standby: meta.standby === true,
    quoted_provider_id: str(meta.quotedMessage?.platformMessageId) ?? str(meta.quotedMessageId),
    interactive,
    kind,
  };
}

export function normalizeZernioEvent(eventType: string, eventId: string, payload: any): NormalizedEvent {
  const p = payload ?? {};
  switch (eventType) {
    case 'message.received':
    case 'message.sent': {
      const platform = p.message?.platform ?? p.account?.platform;
      if (platform !== 'whatsapp') return { type: 'ignored', event_id: eventId, reason: `platform_${platform ?? 'unknown'}` };
      return { type: eventType, event_id: eventId, message: normalizeMessage(p, eventType) };
    }
    case 'message.delivered':
    case 'message.read':
    case 'message.failed':
      return {
        type: 'message.status',
        event_id: eventId,
        status: eventType.split('.')[1] as 'delivered' | 'read' | 'failed',
        provider_message_id: req(p.message?.platformMessageId, 'message.platformMessageId'),
        provider_conversation_id: req(p.message?.conversationId ?? p.conversation?.id, 'conversation.id'),
        provider_account_id: req(p.account?.accountId ?? p.account?.id, 'account.id'),
        status_at: req(p.statusAt ?? p.timestamp, 'statusAt'),
        error: p.error && typeof p.error === 'object' ? p.error : null,
      };
    case 'message.edited':
    case 'message.deleted':
      return {
        type: eventType,
        event_id: eventId,
        provider_message_id: req(p.message?.platformMessageId, 'message.platformMessageId'),
        provider_conversation_id: req(p.message?.conversationId ?? p.conversation?.id, 'conversation.id'),
        provider_account_id: req(p.account?.accountId ?? p.account?.id, 'account.id'),
        direction: str(p.message?.direction) ?? 'unknown',
        text: typeof p.message?.text === 'string' ? p.message.text : null,
        at: str(p.editedAt) ?? str(p.deletedAt) ?? req(p.timestamp, 'timestamp'),
      };
    case 'reaction.received':
      return {
        type: 'reaction.received',
        event_id: eventId,
        provider_conversation_id: req(p.conversation?.id, 'conversation.id'),
        provider_account_id: req(p.account?.accountId ?? p.account?.id, 'account.id'),
        provider_message_id: req(p.reaction?.platformMessageId, 'reaction.platformMessageId'),
        emoji: str(p.reaction?.emoji) ?? '',
        action: str(p.reaction?.action) ?? 'added',
        at: str(p.reaction?.reactedAt) ?? req(p.timestamp, 'timestamp'),
      };
    case 'conversation.control_changed':
      return {
        type: 'conversation.control_changed',
        event_id: eventId,
        provider_conversation_id: req(p.conversation?.platformConversationId ?? p.conversation?.id, 'conversation.id'),
        owner: str(p.control?.owner),
      };
    case 'account.connected':
    case 'account.disconnected':
    case 'whatsapp.number.suspended':
    case 'whatsapp.number.reactivated':
    case 'whatsapp.number.released':
      return {
        type: 'account.status',
        event_id: eventId,
        provider_account_id: str(p.account?.accountId ?? p.account?.id),
        status: eventType === 'account.connected' || eventType === 'whatsapp.number.reactivated' ? 'active'
          : eventType === 'account.disconnected' ? 'disconnected' : 'suspended',
        raw_event: eventType,
      };
    default:
      return { type: 'ignored', event_id: eventId, reason: `event_${eventType}` };
  }
}
