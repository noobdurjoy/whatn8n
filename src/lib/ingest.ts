import type pg from 'pg';
import { detectHandoffRequest, detectMarketingOptOut } from '@shared/handoff.js';
import { detectLanguage } from '@shared/language.js';
import { getPool, withTx } from './db';
import { classifyOutgoingOrigin, isVerifiedHuman, type OriginClass } from './zernio/origin';
import { normalizeZernioEvent, NormalizeError, type NormalizedMessage } from './zernio/normalize';

// ---------------------------------------------------------------------------
// Step 1 (inside the webhook request): persist + deduplicate, then ack.
// ---------------------------------------------------------------------------
export async function persistWebhookEvent(input: {
  source: 'zernio' | 'woocommerce';
  providerEventId: string;
  eventType: string;
  signatureValid: boolean;
  headers: Record<string, string>;
  payload: unknown;
}): Promise<{ id: string; duplicate: boolean }> {
  const r = await getPool().query(
    `INSERT INTO app.webhook_events (source, provider_event_id, event_type, signature_valid, headers, payload)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (source, provider_event_id)
       DO UPDATE SET duplicate_count = app.webhook_events.duplicate_count + 1
     RETURNING id, (xmax <> 0) AS duplicate`,
    [input.source, input.providerEventId, input.eventType, input.signatureValid, input.headers, input.payload],
  );
  return { id: r.rows[0].id, duplicate: r.rows[0].duplicate };
}

// ---------------------------------------------------------------------------
// Step 2: normalize and apply. One transaction per event.
// ---------------------------------------------------------------------------
export type Route =
  | { action: 'customer_message'; conversation_id: string; message_id: string; revision: number; mode: string;
      attachment_ids: string[]; handoff: boolean; possible_handoff: boolean; language: string | null; is_new_conversation: boolean }
  | { action: 'fetch_media'; conversation_id: string; attachment_ids: string[] }
  | { action: 'notify_staff'; conversation_id: string; reason: string; detail?: Record<string, unknown> }
  | { action: 'none'; reason: string };

const MAX_DEFERRALS = 6;

export async function processWebhookEvent(eventId: string): Promise<{ status: string; route: Route | null }> {
  return withTx(async (c) => {
    const ev = (await c.query(
      `SELECT * FROM app.webhook_events WHERE id = $1 FOR UPDATE`, [eventId])).rows[0];
    if (!ev) return { status: 'missing', route: null };
    if (!['received', 'deferred', 'failed'].includes(ev.processing_status)) return { status: ev.processing_status, route: ev.route };
    if (!ev.signature_valid) {
      await markEvent(c, eventId, 'ignored', null, 'invalid signature');
      return { status: 'ignored', route: null };
    }
    if (ev.source !== 'zernio') return { status: ev.processing_status, route: null };

    let route: Route;
    try {
      const n = normalizeZernioEvent(ev.event_type, ev.provider_event_id, ev.payload);
      switch (n.type) {
        case 'message.received':
          route = await applyInbound(c, n.message);
          break;
        case 'message.sent': {
          const r = await applyOutgoingEcho(c, n.message, ev.attempts);
          if (r === 'defer') {
            await c.query(
              `UPDATE app.webhook_events SET processing_status = 'deferred', attempts = attempts + 1,
                      next_attempt_at = now() + interval '20 seconds', last_error = 'waiting for own send result' WHERE id = $1`,
              [eventId]);
            return { status: 'deferred', route: null };
          }
          route = r;
          break;
        }
        case 'message.status': {
          const r = await applyStatus(c, n);
          if (r === 'defer') {
            if (ev.attempts >= MAX_DEFERRALS) {
              route = { action: 'none', reason: 'status_for_unknown_message' };
              break;
            }
            await c.query(
              `UPDATE app.webhook_events SET processing_status = 'deferred', attempts = attempts + 1,
                      next_attempt_at = now() + interval '30 seconds', last_error = 'message not recorded yet' WHERE id = $1`,
              [eventId]);
            return { status: 'deferred', route: null };
          }
          route = r;
          break;
        }
        case 'message.edited':
        case 'message.deleted':
          route = await applyEditDelete(c, n);
          break;
        case 'reaction.received':
          route = await applyReaction(c, n);
          break;
        case 'conversation.control_changed':
          route = await applyControlChanged(c, n);
          break;
        case 'account.status':
          route = await applyAccountStatus(c, n);
          break;
        case 'ignored':
          await markEvent(c, eventId, 'ignored', { action: 'none', reason: n.reason }, null);
          return { status: 'ignored', route: { action: 'none', reason: n.reason } };
      }
    } catch (err) {
      if (err instanceof NormalizeError) {
        await markEvent(c, eventId, 'failed', null, err.message);
        await c.query(`SELECT app.raise_alert('event_failed', 'warning', 'A webhook event could not be parsed.', $1, $2)`,
          [{ event_id: eventId, error: err.message }, `event_failed:${eventId}`]);
        return { status: 'failed', route: null };
      }
      throw err;
    }
    await markEvent(c, eventId, 'processed', route, null);
    return { status: 'processed', route };
  });
}

async function markEvent(c: pg.PoolClient, id: string, status: string, route: Route | null, error: string | null) {
  await c.query(
    `UPDATE app.webhook_events SET processing_status = $2, route = $3, last_error = $4,
            processed_at = CASE WHEN $2 IN ('processed', 'ignored') THEN now() ELSE processed_at END,
            attempts = attempts + 1,
            routed_at = CASE WHEN $3::jsonb IS NULL OR $3::jsonb ->> 'action' = 'none' THEN now() ELSE NULL END
      WHERE id = $1`,
    [id, status, route ? JSON.stringify(route) : null, error]);
}

// --- shared upserts --------------------------------------------------------

async function ensureAccount(c: pg.PoolClient, m: { provider_account_id: string; account_username: string | null; account_display_name: string | null; platform: string }) {
  const shop = (await c.query(`SELECT id FROM app.shops ORDER BY created_at LIMIT 1`)).rows[0];
  if (!shop) throw new Error('shop not seeded');
  const r = await c.query(
    `INSERT INTO app.channel_accounts (shop_id, provider, platform, provider_account_id, username, display_name, enabled, last_event_at)
     VALUES ($1, 'zernio', $2, $3, $4, $5, false, now())
     ON CONFLICT (provider, provider_account_id) DO UPDATE SET last_event_at = now(),
       username = coalesce(excluded.username, app.channel_accounts.username),
       display_name = coalesce(excluded.display_name, app.channel_accounts.display_name)
     RETURNING id, shop_id, enabled, (xmax = 0) AS created`,
    [shop.id, m.platform, m.provider_account_id, m.account_username, m.account_display_name]);
  const acct = r.rows[0];
  if (acct.created) {
    await c.query(`SELECT app.raise_alert('new_channel_account', 'info', 'Messages arrived for a WhatsApp account that is not enabled yet. Messages are saved; enable it in Settings to allow replies.', $1, $2)`,
      [{ provider_account_id: m.provider_account_id }, `new_account:${m.provider_account_id}`]);
  }
  return acct as { id: string; shop_id: string; enabled: boolean };
}

async function ensureCustomer(c: pg.PoolClient, shopId: string, accountId: string, p: NormalizedMessage['participant']) {
  const ids: Array<[string, string]> = [];
  if (p.bsuid) ids.push(['bsuid', p.bsuid]);
  if (p.phone_e164) ids.push(['phone', p.phone_e164]);
  if (p.participant_id) ids.push(['participant_id', p.participant_id]);
  if (!ids.length) throw new NormalizeError('no participant identity');

  let customerId: string | null = null;
  for (const [kind, value] of ids) {
    const r = await c.query(
      `SELECT customer_id FROM app.customer_identities WHERE channel_account_id = $1 AND identity_kind = $2 AND identity_value = $3`,
      [accountId, kind, value]);
    if (r.rows[0]) { customerId = r.rows[0].customer_id; break; }
  }
  if (!customerId) {
    customerId = (await c.query(
      `INSERT INTO app.customers (shop_id, display_name, phone_e164) VALUES ($1, $2, $3) RETURNING id`,
      [shopId, p.display_name, p.phone_e164])).rows[0].id;
  } else if (p.display_name || p.phone_e164) {
    await c.query(
      `UPDATE app.customers SET display_name = coalesce($2, display_name), phone_e164 = coalesce(phone_e164, $3), updated_at = now()
        WHERE id = $1 AND deleted_at IS NULL`, [customerId, p.display_name, p.phone_e164]);
  }
  for (const [kind, value] of ids) {
    await c.query(
      `INSERT INTO app.customer_identities (customer_id, channel_account_id, identity_kind, identity_value, provider_contact_id)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (channel_account_id, identity_kind, identity_value) DO NOTHING`,
      [customerId, accountId, kind, value, p.provider_contact_id]);
  }
  return customerId!;
}

async function ensureConversation(c: pg.PoolClient, acct: { id: string; shop_id: string }, customerId: string, m: NormalizedMessage) {
  const r = await c.query(
    `INSERT INTO app.conversations (shop_id, channel_account_id, customer_id, provider_conversation_id, platform_conversation_id, mode)
     VALUES ($1, $2, $3, $4, $5, coalesce((SELECT value #>> '{}' FROM app.settings WHERE key = 'default_mode'), 'COPILOT'))
     ON CONFLICT (channel_account_id, provider_conversation_id) DO UPDATE
       SET platform_conversation_id = coalesce(app.conversations.platform_conversation_id, excluded.platform_conversation_id)
     RETURNING id, (xmax = 0) AS created`,
    [acct.shop_id, acct.id, customerId, m.provider_conversation_id, m.platform_conversation_id]);
  const conv = (await c.query(`SELECT * FROM app.conversations WHERE id = $1 FOR UPDATE`, [r.rows[0].id])).rows[0];
  return { conv, created: r.rows[0].created as boolean };
}

async function insertAttachments(c: pg.PoolClient, messageId: string, m: NormalizedMessage) {
  const ids: string[] = [];
  for (const a of m.attachments) {
    const r = await c.query(
      `INSERT INTO app.attachments (message_id, position, media_type, mime_type, file_name, provider_media_ref, fetch_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (message_id, position) DO NOTHING RETURNING id`,
      [messageId, a.position, a.media_type, a.mime_type, a.file_name, a.provider_media_ref,
       a.provider_media_ref ? 'pending' : 'not_applicable']);
    if (r.rows[0] && a.provider_media_ref) ids.push(r.rows[0].id);
  }
  return ids;
}

// --- inbound customer message ----------------------------------------------

async function applyInbound(c: pg.PoolClient, m: NormalizedMessage): Promise<Route> {
  const acct = await ensureAccount(c, m);
  const customerId = await ensureCustomer(c, acct.shop_id, acct.id, m.participant);
  const { conv, created } = await ensureConversation(c, acct, customerId, m);

  const ins = await c.query(
    `INSERT INTO app.messages (conversation_id, direction, author_type, kind, body, provider_message_id, provider_internal_id,
                               sent_at, quoted_provider_id, metadata)
     VALUES ($1, 'inbound', 'customer', $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (conversation_id, provider_message_id) WHERE provider_message_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [conv.id, m.kind, m.text, m.provider_message_id, m.provider_internal_id, m.sent_at, m.quoted_provider_id,
     { interactive: m.interactive, standby: m.standby }]);
  if (!ins.rows[0]) return { action: 'none', reason: 'duplicate_message' };
  const messageId: string = ins.rows[0].id;
  const attachmentIds = await insertAttachments(c, messageId, m);

  const language = detectLanguage(m.text);
  const targets = (await c.query(`SELECT app.setting('response_time_targets') AS v`)).rows[0]?.v;
  const firstMinutes = Number(targets?.first_response_minutes ?? 10);

  const upd = await c.query(
    `UPDATE app.conversations SET
        revision = revision + 1,
        last_inbound_at = greatest(coalesce(last_inbound_at, $2::timestamptz), $2::timestamptz),
        last_message_at = greatest(coalesce(last_message_at, $2::timestamptz), $2::timestamptz),
        last_message_preview = CASE WHEN $2::timestamptz >= coalesce(last_message_at, '-infinity') THEN left(coalesce($3, '[' || $4 || ']'), 140) ELSE last_message_preview END,
        unread_count = unread_count + 1,
        first_response_due_at = coalesce(first_response_due_at, now() + make_interval(mins => $5)),
        status = CASE WHEN status IN ('resolved', 'closed') THEN 'open' ELSE status END,
        updated_at = now()
      WHERE id = $1 RETURNING revision, mode`,
    [conv.id, m.sent_at, m.text, m.kind, firstMinutes]);

  if (language) {
    await c.query(`UPDATE app.customers SET preferred_language = $2, updated_at = now() WHERE id = $1`, [customerId, language]);
  }
  if (detectMarketingOptOut(m.text)) {
    await c.query(`UPDATE app.customers SET marketing_consent = 'opted_out', marketing_consent_at = now() WHERE id = $1`, [customerId]);
    await c.query(`SELECT app.audit('customer', NULL, 'customer.marketing_opt_out', 'customer', $1, '{}')`, [customerId]);
  }

  // Meta Business Agent holds this thread: it answers; we only record.
  if (m.standby) {
    await c.query(`SELECT app.notify('message', $1, jsonb_build_object('message_id', $2::text))`, [conv.id, messageId]);
    return attachmentIds.length
      ? { action: 'fetch_media', conversation_id: conv.id, attachment_ids: attachmentIds }
      : { action: 'none', reason: 'provider_agent_standby' };
  }

  let mode: string = upd.rows[0].mode;
  const h = detectHandoffRequest(m.text);
  let handoff = false;
  if (h.kind === 'explicit' && mode !== 'HUMAN') {
    const rules = (await c.query(`SELECT app.setting('escalation_rules') AS v`)).rows[0]?.v;
    if (rules?.customer_requests_human?.enabled !== false) {
      await c.query(`SELECT app.take_over($1, 'customer', NULL, 'customer_requested_human', $2, true)`,
        [conv.id, { rule: h.rule, message_id: messageId }]);
      handoff = true;
      mode = 'HUMAN';
    }
  }
  const revision = Number((await c.query(`SELECT revision FROM app.conversations WHERE id = $1`, [conv.id])).rows[0].revision);
  await c.query(`SELECT app.notify('message', $1, jsonb_build_object('message_id', $2::text))`, [conv.id, messageId]);

  return {
    action: 'customer_message',
    conversation_id: conv.id,
    message_id: messageId,
    revision,
    mode,
    attachment_ids: attachmentIds,
    handoff,
    possible_handoff: h.kind === 'possible',
    language,
    is_new_conversation: created,
  };
}

// --- outgoing echo (message.sent) -----------------------------------------

async function applyOutgoingEcho(c: pg.PoolClient, m: NormalizedMessage, priorAttempts: number): Promise<Route | 'defer'> {
  const acct = await ensureAccount(c, m);
  const customerId = await ensureCustomer(c, acct.shop_id, acct.id, m.participant);
  const { conv } = await ensureConversation(c, acct, customerId, m);

  const existing = (await c.query(
    `SELECT id, outbound_id FROM app.messages WHERE conversation_id = $1 AND provider_message_id = $2`,
    [conv.id, m.provider_message_id])).rows[0];
  if (existing) {
    await c.query(`UPDATE app.messages SET sent_via = coalesce(sent_via, $2), send_source = coalesce(send_source, $3) WHERE id = $1`,
      [existing.id, m.sent_via, m.source]);
    return { action: 'none', reason: existing.outbound_id ? 'own_echo' : 'duplicate_echo' };
  }

  const own = (await c.query(
    `SELECT id FROM app.outbound_messages WHERE conversation_id = $1 AND provider_message_id = $2`,
    [conv.id, m.provider_message_id])).rows[0];
  const pending = (await c.query(
    `SELECT count(*)::int AS n FROM app.outbound_messages WHERE conversation_id = $1 AND status IN ('sending', 'unknown')`,
    [conv.id])).rows[0].n > 0;

  let origin: OriginClass = classifyOutgoingOrigin({
    sentVia: m.sent_via, source: m.source, matchesOwnOutbound: Boolean(own), hasPendingOwnSend: pending,
  });
  if (origin === 'possibly_own_pending') {
    if (priorAttempts < MAX_DEFERRALS) return 'defer';
    origin = 'unknown'; // still unmatched after waiting: suppress automation, reconcile
  }

  const author = origin === 'own' ? 'system' : isVerifiedHuman(origin) ? 'external_human'
    : origin === 'unknown' ? 'unknown' : 'external_automation';
  const msg = (await c.query(
    `INSERT INTO app.messages (conversation_id, direction, author_type, kind, body, provider_message_id, provider_internal_id,
                               outbound_id, sent_at, delivery_status, delivery_status_at, sent_via, send_source, metadata)
     VALUES ($1, 'outbound', $2, $3, $4, $5, $6, $7, $8, 'sent', $8, $9, $10, $11) RETURNING id`,
    [conv.id, author, m.kind, m.text, m.provider_message_id, m.provider_internal_id, own?.id ?? null, m.sent_at,
     m.sent_via, m.source, { origin }])).rows[0];

  await c.query(
    `UPDATE app.conversations SET last_outbound_at = greatest(coalesce(last_outbound_at, $2::timestamptz), $2::timestamptz),
            last_message_at = greatest(coalesce(last_message_at, $2::timestamptz), $2::timestamptz), updated_at = now()
      WHERE id = $1`, [conv.id, m.sent_at]);

  if (isVerifiedHuman(origin)) {
    // A person replied from Zernio or the WhatsApp Business app: AI stops.
    await c.query(`UPDATE app.conversations SET revision = revision + 1, first_response_due_at = NULL WHERE id = $1`, [conv.id]);
    if (conv.mode !== 'HUMAN') {
      await c.query(`SELECT app.take_over($1, 'provider', NULL, 'external_human_reply', $2, false)`,
        [conv.id, { origin, sent_via: m.sent_via, source: m.source, message_id: msg.id }]);
    }
    await c.query(`SELECT app.notify('message', $1, jsonb_build_object('message_id', $2::text))`, [conv.id, msg.id]);
    return { action: 'notify_staff', conversation_id: conv.id, reason: 'external_human_reply', detail: { origin } };
  }

  if (origin !== 'own') {
    const reason = origin === 'unknown' || origin === 'other_api' ? 'unknown_outgoing_origin'
      : origin === 'meta_business_agent' ? 'meta_business_agent' : 'other_automation';
    await c.query(`SELECT app.set_automation_hold($1, $2, $3)`, [conv.id, reason, { origin, message_id: msg.id }]);
    await c.query(`SELECT app.raise_alert('outgoing_origin', 'warning', $1, $2, $3)`,
      [origin === 'zernio_automation' || origin === 'other_api'
        ? 'Another automation sent a WhatsApp message. AI replies are paused on that conversation.'
        : 'An outgoing message of unknown origin was seen. AI replies are paused on that conversation until reviewed.',
       { conversation_id: conv.id, origin, sent_via: m.sent_via, source: m.source }, `origin:${conv.id}`]);
  }
  await c.query(`SELECT app.notify('message', $1, jsonb_build_object('message_id', $2::text))`, [conv.id, msg.id]);
  return origin === 'own' ? { action: 'none', reason: 'own_echo' }
    : { action: 'notify_staff', conversation_id: conv.id, reason: 'automation_hold', detail: { origin } };
}

// --- delivery status -------------------------------------------------------

const STATUS_RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3, failed: 4 };

async function applyStatus(c: pg.PoolClient, n: Extract<ReturnType<typeof normalizeZernioEvent>, { type: 'message.status' }>): Promise<Route | 'defer'> {
  const row = (await c.query(
    `SELECT m.id, m.conversation_id, m.delivery_status, m.outbound_id
       FROM app.messages m JOIN app.conversations cv ON cv.id = m.conversation_id
       JOIN app.channel_accounts a ON a.id = cv.channel_account_id
      WHERE m.provider_message_id = $1 AND a.provider_account_id = $2
      LIMIT 1`, [n.provider_message_id, n.provider_account_id])).rows[0];
  if (!row) return 'defer';
  await c.query(`SELECT app.lock_conversation($1)`, [row.conversation_id]);
  // Out-of-order safe: never move backwards (read → delivered), failed wins.
  if ((STATUS_RANK[n.status] ?? 0) > (STATUS_RANK[row.delivery_status] ?? 0)) {
    await c.query(
      `UPDATE app.messages SET delivery_status = $2, delivery_status_at = $3, delivery_error = $4 WHERE id = $1`,
      [row.id, n.status, n.status_at, n.error]);
  }
  if (n.status === 'failed' && row.outbound_id) {
    await c.query(
      `UPDATE app.outbound_messages SET status = 'failed', status_reason = 'provider_delivery_failed', last_error = $2, updated_at = now()
        WHERE id = $1`, [row.outbound_id, n.error]);
    await c.query(`SELECT app.raise_alert('delivery_failed', 'warning', 'WhatsApp reported a delivery failure.', $1, $2)`,
      [{ conversation_id: row.conversation_id, message_id: row.id, error: n.error }, `delivery_failed:${row.id}`]);
  }
  await c.query(`SELECT app.notify('delivery', $1, jsonb_build_object('message_id', $2::text, 'status', $3::text))`,
    [row.conversation_id, row.id, n.status]);
  return n.status === 'failed'
    ? { action: 'notify_staff', conversation_id: row.conversation_id, reason: 'delivery_failed', detail: { error: n.error } }
    : { action: 'none', reason: 'status_recorded' };
}

async function applyEditDelete(c: pg.PoolClient, n: any): Promise<Route> {
  const row = (await c.query(
    `SELECT m.id, m.conversation_id, m.body FROM app.messages m JOIN app.conversations cv ON cv.id = m.conversation_id
       JOIN app.channel_accounts a ON a.id = cv.channel_account_id
      WHERE m.provider_message_id = $1 AND a.provider_account_id = $2 LIMIT 1`, [n.provider_message_id, n.provider_account_id])).rows[0];
  if (!row) return { action: 'none', reason: 'edit_for_unknown_message' };
  if (n.type === 'message.edited') {
    await c.query(
      `UPDATE app.messages SET body = $2, edited_at = $3,
              metadata = jsonb_set(metadata, '{edit_history}', coalesce(metadata -> 'edit_history', '[]') || jsonb_build_array(jsonb_build_object('text', body, 'replaced_at', $3::text)))
        WHERE id = $1`, [row.id, n.text, n.at]);
  } else {
    await c.query(`UPDATE app.messages SET deleted_by_sender_at = $2 WHERE id = $1`, [row.id, n.at]);
  }
  await c.query(`SELECT app.notify('message', $1, jsonb_build_object('message_id', $2::text))`, [row.conversation_id, row.id]);
  return { action: 'none', reason: n.type };
}

async function applyReaction(c: pg.PoolClient, n: any): Promise<Route> {
  const row = (await c.query(
    `SELECT m.id, m.conversation_id, m.author_type FROM app.messages m JOIN app.conversations cv ON cv.id = m.conversation_id
       JOIN app.channel_accounts a ON a.id = cv.channel_account_id
      WHERE m.provider_message_id = $1 AND a.provider_account_id = $2 LIMIT 1`, [n.provider_message_id, n.provider_account_id])).rows[0];
  if (!row) return { action: 'none', reason: 'reaction_for_unknown_message' };
  await c.query(`UPDATE app.messages SET reactions = reactions || jsonb_build_array(jsonb_build_object('emoji', $2::text, 'action', $3::text, 'at', $4::text)) WHERE id = $1`,
    [row.id, n.emoji, n.action, n.at]);
  // Thumbs up/down on a message we sent counts as customer feedback.
  if (n.action === 'added' && ['ai', 'staff'].includes(row.author_type) && ['👍', '👎'].includes(n.emoji)) {
    await c.query(`INSERT INTO app.feedback (conversation_id, message_id, source, rating, label) VALUES ($1, $2, 'customer', $3, 'reaction')`,
      [row.conversation_id, row.id, n.emoji === '👍' ? 5 : 1]);
  }
  await c.query(`SELECT app.notify('message', $1, jsonb_build_object('message_id', $2::text))`, [row.conversation_id, row.id]);
  return { action: 'none', reason: 'reaction' };
}

async function applyControlChanged(c: pg.PoolClient, n: any): Promise<Route> {
  const r = await c.query(
    `UPDATE app.conversations SET provider_control_owner = $2, updated_at = now()
      WHERE provider_conversation_id = $1 OR platform_conversation_id = $1 RETURNING id`, [n.provider_conversation_id, n.owner]);
  for (const row of r.rows) {
    await c.query(`SELECT app.notify('conversation', $1, jsonb_build_object('provider_control_owner', $2::text))`, [row.id, n.owner]);
  }
  return r.rows[0] ? { action: 'notify_staff', conversation_id: r.rows[0].id, reason: 'provider_control_changed', detail: { owner: n.owner } }
    : { action: 'none', reason: 'control_change_unknown_conversation' };
}

async function applyAccountStatus(c: pg.PoolClient, n: any): Promise<Route> {
  if (n.provider_account_id) {
    await c.query(`UPDATE app.channel_accounts SET status = $2 WHERE provider_account_id = $1`, [n.provider_account_id, n.status]);
  }
  await c.query(
    `INSERT INTO app.health_checks (component, status, detail, checked_at) VALUES ('whatsapp_account', $1, $2, now())
     ON CONFLICT (component) DO UPDATE SET status = excluded.status, detail = excluded.detail, checked_at = now()`,
    [n.status === 'active' ? 'ok' : 'down', { event: n.raw_event, account: n.provider_account_id }]);
  if (n.status !== 'active') {
    await c.query(`SELECT app.raise_alert('connection_down', 'critical', 'The WhatsApp connection reported a problem.', $1, $2)`,
      [{ event: n.raw_event, account: n.provider_account_id }, `connection:${n.provider_account_id}`]);
  } else {
    await c.query(`UPDATE app.alerts SET resolved_at = now() WHERE dedupe_key = $1 AND resolved_at IS NULL`, [`connection:${n.provider_account_id}`]);
  }
  return { action: 'none', reason: n.raw_event };
}

// ---------------------------------------------------------------------------
// History import: messages are stored as historical and NEVER routed to the
// reply workflow, never bump the revision and never trigger handoffs.
// ---------------------------------------------------------------------------
export async function importHistoricalMessages(input: {
  provider_account_id: string;
  provider_conversation_id: string;
  participant: NormalizedMessage['participant'];
  messages: Array<{ provider_message_id: string; direction: 'incoming' | 'outgoing'; text: string | null; sent_at: string;
                    sent_via?: string | null; kind?: string }>;
}): Promise<{ inserted: number; skipped: number }> {
  return withTx(async (c) => {
    const pseudo: NormalizedMessage = {
      provider_internal_id: null, provider_message_id: 'n/a', provider_conversation_id: input.provider_conversation_id,
      platform_conversation_id: null, provider_account_id: input.provider_account_id, account_username: null,
      account_display_name: null, platform: 'whatsapp', direction: 'incoming', text: null, sent_at: new Date().toISOString(),
      attachments: [], participant: input.participant, sent_via: null, source: null, standby: false, quoted_provider_id: null,
      interactive: null, kind: 'text',
    };
    const acct = await ensureAccount(c, pseudo);
    const customerId = await ensureCustomer(c, acct.shop_id, acct.id, input.participant);
    const { conv } = await ensureConversation(c, acct, customerId, pseudo);
    let inserted = 0;
    for (const h of input.messages) {
      const r = await c.query(
        `INSERT INTO app.messages (conversation_id, direction, author_type, kind, body, provider_message_id, sent_at, sent_via, is_historical, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, '{"imported": true}')
         ON CONFLICT (conversation_id, provider_message_id) WHERE provider_message_id IS NOT NULL DO NOTHING RETURNING id`,
        [conv.id, h.direction === 'incoming' ? 'inbound' : 'outbound',
         h.direction === 'incoming' ? 'customer' : (h.sent_via === 'human' ? 'external_human' : 'unknown'),
         h.kind ?? 'text', h.text, h.provider_message_id, h.sent_at, h.sent_via ?? null]);
      if (r.rows[0]) inserted++;
    }
    // Only timestamps are updated so the inbox sorts correctly; the 24h window
    // anchor moves only if an imported customer message is genuinely newer.
    await c.query(
      `UPDATE app.conversations cv SET
          last_message_at = greatest(coalesce(cv.last_message_at, '-infinity'), x.max_at),
          last_inbound_at = CASE WHEN x.max_in IS NOT NULL THEN greatest(coalesce(cv.last_inbound_at, '-infinity'), x.max_in) ELSE cv.last_inbound_at END
        FROM (SELECT max(sent_at) AS max_at, max(sent_at) FILTER (WHERE direction = 'inbound') AS max_in
                FROM app.messages WHERE conversation_id = $1) x
       WHERE cv.id = $1`, [conv.id]);
    return { inserted, skipped: input.messages.length - inserted };
  });
}
