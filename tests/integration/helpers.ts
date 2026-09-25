import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL_TEST
  || 'postgresql://dev:dev@localhost/wa_test';

import { closePool, getPool } from '../../src/lib/db';
import { persistWebhookEvent, processWebhookEvent } from '../../src/lib/ingest';
import { buildSendBody, classifySendResult } from '../../shared/send-result.js';

export const db = () => getPool();
export { closePool };

const FIX = path.join(__dirname, '..', '..', 'fixtures', 'zernio');

// Loads a fixture and gives it unique ids so every test is independent.
export function fixture(name: string, opts: { convId?: string; wamid?: string; text?: string; sentAt?: string; eventId?: string;
  phone?: string; bsuid?: string; accountId?: string } = {}) {
  const p = JSON.parse(readFileSync(path.join(FIX, name), 'utf8'));
  p.id = opts.eventId ?? `evt_${randomUUID()}`;
  if (p.message) {
    if (opts.convId) { p.message.conversationId = opts.convId; p.conversation.id = opts.convId; }
    if (opts.wamid) p.message.platformMessageId = opts.wamid;
    else p.message.platformMessageId = `wamid.${randomUUID()}`;
    if (opts.text !== undefined) p.message.text = opts.text;
    if (opts.sentAt) { p.message.sentAt = opts.sentAt; p.timestamp = opts.sentAt; }
    if (p.message.direction === 'incoming') {
      if (opts.phone) { p.message.sender.phoneNumber = opts.phone; p.message.sender.id = opts.phone.replace('+', ''); }
      if (opts.bsuid) p.message.sender.businessScopedUserId = opts.bsuid;
    }
  }
  if (opts.accountId && p.account) { p.account.id = opts.accountId; p.account.accountId = opts.accountId; }
  return p;
}

export async function ingest(payload: any, eventType?: string) {
  const ev = await persistWebhookEvent({
    source: 'zernio',
    providerEventId: payload.id,
    eventType: eventType ?? payload.event,
    signatureValid: true,
    headers: {},
    payload,
  });
  const res = await processWebhookEvent(ev.id);
  return { eventId: ev.id, duplicate: ev.duplicate, ...res };
}

export async function resetData() {
  await db().query(`
    TRUNCATE app.audit_log, app.alerts, app.webhook_events, app.outbound_attempts, app.image_analyses, app.ai_usage,
             app.attachment_blobs, app.attachments, app.feedback, app.tickets, app.internal_notes,
             app.pending_order_operations, app.order_verifications, app.order_links, app.customer_memories,
             app.conversation_summaries, app.mode_changes, app.knowledge_proposals, app.staff_sessions,
             app.admin_notifications, app.stock_changes, app.temporary_notices, app.staff_notes, app.admin_commands,
             app.telegram_updates, app.telegram_admins, app.telegram_pairing_codes
             CASCADE`);
  await db().query(`DELETE FROM app.outbound_messages`);
  await db().query(`DELETE FROM app.ai_drafts`);
  await db().query(`DELETE FROM app.messages`);
  await db().query(`DELETE FROM app.ai_jobs`);
  await db().query(`DELETE FROM app.conversations WHERE NOT is_sandbox`);
  await db().query(`DELETE FROM app.customer_identities`);
  await db().query(`DELETE FROM app.customer_account_links`);
  await db().query(`DELETE FROM app.customers c WHERE NOT EXISTS (SELECT 1 FROM app.conversations v WHERE v.customer_id = c.id)`);
  await db().query(`UPDATE app.knowledge_documents SET published_version_id = NULL`);
  await db().query(`DELETE FROM app.knowledge_versions`);
  await db().query(`DELETE FROM app.knowledge_documents`);
  await db().query(`DELETE FROM app.channel_accounts WHERE provider_account_id <> 'sandbox'`);
  await db().query(`UPDATE app.settings SET updated_by = NULL`);
  await db().query(`DELETE FROM app.settings_history`);
  await db().query(`DELETE FROM app.data_requests`);
  await db().query(`DELETE FROM app.staff_users`);
  await setSetting('ai_enabled', true);
  await setSetting('sending_enabled', true);
  await setSetting('default_mode', 'AUTO');
}

export async function setSetting(key: string, value: unknown) {
  await db().query(
    `INSERT INTO app.settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [key, JSON.stringify(value)]);
}

export async function staff(role: 'owner' | 'admin' | 'agent', email = `${role}-${randomUUID().slice(0, 8)}@example.test`) {
  const r = await db().query(
    `INSERT INTO app.staff_users (email, display_name, role, password_hash) VALUES ($1, $2, $3, 'x') RETURNING id`,
    [email, `${role} user`, role]);
  return r.rows[0].id as string;
}

export async function enableAllAccounts() {
  await db().query(`UPDATE app.channel_accounts SET enabled = true, status = 'active' WHERE provider_account_id <> 'sandbox'`);
}

// Creates a conversation by ingesting a customer message; returns ids.
export async function newConversation(text = 'bhai netflix er dam koto?', opts: Parameters<typeof fixture>[1] = {}) {
  const convId = opts.convId ?? `conv_${randomUUID()}`;
  const phone = opts.phone ?? `+88017${Math.floor(10000000 + Math.random() * 89999999)}`;
  const res = await ingest(fixture('message.received.banglish.json', { ...opts, convId, text, phone, bsuid: opts.bsuid ?? `BD.${randomUUID()}` }));
  await enableAllAccounts();
  const conv = (await db().query(`SELECT * FROM app.conversations WHERE provider_conversation_id = $1`, [convId])).rows[0];
  return { convId, phone, conversation: conv, res };
}

export async function conv(id: string) {
  return (await db().query(`SELECT * FROM app.conversations WHERE id = $1`, [id])).rows[0];
}

export async function sql<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await db().query(text, params)).rows;
}

export async function one<T = any>(text: string, params: unknown[] = []): Promise<T> {
  return (await db().query(text, params)).rows[0];
}

// ---------------------------------------------------------------------------
// Dispatcher harness: executes exactly the steps of n8n workflow
// "C · Outgoing Dispatcher" (claim → build body → HTTP → classify → record),
// using the same shared modules, against a fake Zernio.
// ---------------------------------------------------------------------------
export type FakeZernio = (req: { conversationId: string; idempotencyKey: string; body: any }) =>
  Promise<{ status: number | null; body?: any; headers?: Record<string, string>; networkError?: string | null }>;

export async function dispatchOnce(outboundId: string, zernio: FakeZernio) {
  const claim = (await db().query(`SELECT app.claim_outbound($1, 'test') AS r`, [outboundId])).rows[0].r;
  if (!claim.claimed) return { claimed: false, reason: claim.reason, claim };
  const body = buildSendBody(claim);
  const resp = await zernio({ conversationId: claim.provider_conversation_id, idempotencyKey: claim.idempotency_key, body });
  const cls = classifySendResult({ status: resp.status, body: resp.body ?? null, headers: resp.headers ?? null, networkError: resp.networkError ?? null });
  const rec = (await db().query(`SELECT app.record_send_result($1, $2, $3, $4, $5, $6, $7, $8) AS r`,
    [outboundId, claim.attempt_no, cls.outcome, resp.status, cls.provider_message_id, resp.body ?? null, cls.error, cls.retry_after_seconds])).rows[0].r;
  return { claimed: true, outcome: cls.outcome, record: rec, body };
}

// A fake Zernio that behaves per its documented idempotency contract:
// the same Idempotency-Key replays the first successful response.
export function fakeZernio() {
  const sent: Array<{ key: string; body: any; wamid: string }> = [];
  const byKey = new Map<string, string>();
  const fn: FakeZernio = async ({ idempotencyKey, body }) => {
    const prior = byKey.get(idempotencyKey);
    if (prior) return { status: 200, body: { success: true, data: { messageId: prior } }, headers: { 'idempotent-replayed': 'true' } };
    const wamid = `wamid.SENT.${randomUUID()}`;
    byKey.set(idempotencyKey, wamid);
    sent.push({ key: idempotencyKey, body, wamid });
    return { status: 200, body: { success: true, data: { messageId: wamid, conversationId: 'x' } } };
  };
  return { fn, sent };
}

export async function asN8nRole<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const u = new URL(process.env.DATABASE_URL!);
  u.username = 'wa_n8n';
  u.password = 'n8n';
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}
