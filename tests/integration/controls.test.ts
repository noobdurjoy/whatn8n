import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  asN8nRole, closePool, conv, dispatchOnce, fakeZernio, fixture, ingest, newConversation, one, resetData, setSetting,
  sql, staff,
} from './helpers';

beforeEach(async () => { await resetData(); });
afterAll(async () => { await closePool(); });

async function startJob(conversationId: string, revision?: number) {
  return (await one(`SELECT app.start_ai_job($1, 'reply', NULL, $2) AS r`, [conversationId, revision ?? null])).r;
}
async function submit(jobId: string, decision = 'reply', text = 'Netflix Premium ache, kon plan niben?', reason: string | null = null) {
  return (await one(`SELECT app.submit_ai_result($1, $2, $3, $4, '[]', '{}') AS r`, [jobId, decision, text, reason])).r;
}

describe('durable intake and deduplication', () => {
  it('repeated inbound events produce one stored message and one intended reply', async () => {
    const { conversation, convId, phone } = await newConversation('first message');
    const payload = fixture('message.received.banglish.json', { convId, phone, text: 'bhai netflix er dam koto?' });

    const a = await ingest(payload);
    const b = await ingest(payload);                          // same X-Zernio-Event-Id redelivered
    const c = await ingest({ ...payload, id: `evt_${randomUUID()}` }); // different event id, same wamid
    expect(a.route?.action).toBe('customer_message');
    expect(b.duplicate).toBe(true);
    expect(b.route?.action).toBe('customer_message');         // returns the stored route; not re-applied
    expect(c.route).toEqual({ action: 'none', reason: 'duplicate_message' });
    expect((await sql(`SELECT id FROM app.messages WHERE provider_message_id = $1`, [payload.message.platformMessageId])).length).toBe(1);

    // The router may deliver the same route twice: only one job starts.
    const rev = (a.route as any).revision;
    const j1 = await startJob(conversation.id, rev);
    const j2 = await startJob(conversation.id, rev);
    expect(j1.started).toBe(true);
    expect(j2).toMatchObject({ started: false, reason: 'already_running' });
    const s = await submit(j1.job_id);
    expect(s.result).toBe('queued');
    const z = fakeZernio();
    await dispatchOnce(s.outbound_id, z.fn);
    await dispatchOnce(s.outbound_id, z.fn);                   // second dispatch attempt is refused
    expect(z.sent.length).toBe(1);
  });

  it('bot echoes and delivery receipts never create reply routes', async () => {
    const { conversation, convId } = await newConversation();
    const j = await startJob(conversation.id);
    const s = await submit(j.job_id);
    const z = fakeZernio();
    await dispatchOnce(s.outbound_id, z.fn);
    const wamid = z.sent[0].wamid;

    const echo = await ingest(fixture('message.sent.own-api.json', { convId, wamid }));
    expect(echo.route).toEqual({ action: 'none', reason: 'own_echo' });
    for (const f of ['message.delivered.json', 'message.read.json']) {
      const st = await ingest(fixture(f, { convId, wamid }));
      expect(st.route?.action).toBe('none');
    }
    const msg = await one(`SELECT delivery_status, author_type FROM app.messages WHERE provider_message_id = $1`, [wamid]);
    expect(msg).toEqual({ delivery_status: 'read', author_type: 'ai' });
    // A late 'delivered' after 'read' never moves the status backwards.
    await ingest(fixture('message.delivered.json', { convId, wamid }));
    expect((await one(`SELECT delivery_status FROM app.messages WHERE provider_message_id = $1`, [wamid])).delivery_status).toBe('read');
    expect((await conv(conversation.id)).automation_hold_reason).toBeNull();
  });

  it('own echo arriving BEFORE the send result is matched, not treated as a stranger', async () => {
    const { conversation, convId } = await newConversation();
    const s = await submit((await startJob(conversation.id)).job_id);
    const claim = (await one(`SELECT app.claim_outbound($1, 't') AS r`, [s.outbound_id])).r;
    const wamid = `wamid.RACE.${randomUUID()}`;
    // Echo arrives while our HTTP call is in flight: deferred, not held.
    const early = await ingest(fixture('message.sent.own-api.json', { convId, wamid }));
    expect(early.status).toBe('deferred');
    await one(`SELECT app.record_send_result($1, $2, 'accepted', 200, $3, '{}', NULL, NULL) AS r`, [s.outbound_id, claim.attempt_no, wamid]);
    // The deferred event is re-processed by the maintenance sweep.
    const { processWebhookEvent } = await import('../../src/lib/ingest');
    const again = await processWebhookEvent(early.eventId);
    expect(again.route).toEqual({ action: 'none', reason: 'own_echo' });
    expect((await conv(conversation.id)).automation_hold_reason).toBeNull();
    expect((await sql(`SELECT 1 FROM app.messages WHERE provider_message_id = $1`, [wamid])).length).toBe(1);
  });
});

describe('handoff and takeover', () => {
  it('a human request (Bangla) stops pending AI replies and sends one fixed acknowledgment', async () => {
    const { conversation, convId, phone } = await newConversation();
    const s = await submit((await startJob(conversation.id)).job_id);
    expect(s.result).toBe('queued');

    const r = await ingest(fixture('message.received.handoff-bn.json', { convId, phone }));
    expect(r.route).toMatchObject({ action: 'customer_message', handoff: true, mode: 'HUMAN' });
    const c = await conv(conversation.id);
    expect(c.mode).toBe('HUMAN');
    expect(c.mode_reason).toBe('customer_requested_human');
    expect(c.queue_state).toBe('waiting_staff');
    expect((await one(`SELECT status, status_reason FROM app.outbound_messages WHERE id = $1`, [s.outbound_id])))
      .toEqual({ status: 'canceled', status_reason: 'takeover' });
    const acks = await sql(`SELECT kind, actor_type, body FROM app.outbound_messages WHERE conversation_id = $1 AND kind = 'handoff_ack'`, [conversation.id]);
    expect(acks.length).toBe(1);
    expect(acks[0].body).toContain('আমাদের টিমের');           // fixed Bangla text from settings, not generated

    // A second request in HUMAN mode does not re-trigger or send another ack.
    await ingest(fixture('message.received.handoff-banglish.json', { convId, phone }));
    expect((await sql(`SELECT 1 FROM app.outbound_messages WHERE conversation_id = $1 AND kind = 'handoff_ack'`, [conversation.id])).length).toBe(1);
  });

  it('Banglish "bhai admin er sathe kotha bolbo" hands off; "bhai price koto" does not', async () => {
    const a = await newConversation('bhai price koto?');
    expect(a.res.route).toMatchObject({ handoff: false });
    const b = await newConversation('bhai admin er sathe kotha bolbo');
    expect(b.res.route).toMatchObject({ handoff: true, mode: 'HUMAN' });
  });

  it('takeover during generation discards the AI result', async () => {
    const { conversation } = await newConversation();
    const agent = await staff('agent');
    const j = await startJob(conversation.id);
    await one(`SELECT app.take_over($1, 'staff', $2, 'staff_take_over', '{}', false)`, [conversation.id, agent]);
    const s = await submit(j.job_id);
    expect(s.result).toBe('discarded');                       // job was canceled by the takeover
    expect((await sql(`SELECT 1 FROM app.outbound_messages WHERE conversation_id = $1 AND actor_type = 'ai'`, [conversation.id])).length).toBe(0);
    expect((await conv(conversation.id)).assigned_to).toBe(agent);
  });

  it('takeover after an AI reply is queued but before dispatch blocks the send', async () => {
    const { conversation } = await newConversation();
    const agent = await staff('agent');
    const s = await submit((await startJob(conversation.id)).job_id);
    await one(`SELECT app.take_over($1, 'staff', $2, 'staff_take_over', '{}', false)`, [conversation.id, agent]);
    const z = fakeZernio();
    const d = await dispatchOnce(s.outbound_id, z.fn);
    expect(d.claimed).toBe(false);
    expect(z.sent.length).toBe(0);
  });

  it('a send already in flight at takeover is flagged, not hidden', async () => {
    const { conversation } = await newConversation();
    const agent = await staff('agent');
    const s = await submit((await startJob(conversation.id)).job_id);
    await one(`SELECT app.claim_outbound($1, 't')`, [s.outbound_id]);   // HTTP call in progress
    const t = (await one(`SELECT app.take_over($1, 'staff', $2, 'staff_take_over', '{}', false) AS r`, [conversation.id, agent])).r;
    expect(t.in_flight_ai_sends).toBe(1);
    expect((await one(`SELECT in_flight_at_takeover FROM app.outbound_messages WHERE id = $1`, [s.outbound_id])).in_flight_at_takeover).toBe(true);
  });

  it('staff reply in AUTO mode commits the takeover before the staff message is queued', async () => {
    const { conversation } = await newConversation();
    const agent = await staff('agent');
    const pendingAi = await submit((await startJob(conversation.id)).job_id);
    const r = (await one(`SELECT app.enqueue_staff_reply($1, $2, 'Ami dekhchi', '{}', 'req-1') AS r`, [conversation.id, agent])).r;
    expect(r.takeover.mode).toBe('HUMAN');
    expect((await one(`SELECT status FROM app.outbound_messages WHERE id = $1`, [pendingAi.outbound_id])).status).toBe('canceled');
    // Double-click protection.
    const again = (await one(`SELECT app.enqueue_staff_reply($1, $2, 'Ami dekhchi', '{}', 'req-1') AS r`, [conversation.id, agent])).r;
    expect(again.duplicate).toBe(true);
    const z = fakeZernio();
    expect((await dispatchOnce(r.outbound_id, z.fn)).outcome).toBe('accepted');
    expect(z.sent.length).toBe(1);
  });

  it('verified human replies from Zernio or the WhatsApp Business app switch to HUMAN', async () => {
    for (const f of ['message.sent.zernio-inbox-human.json', 'message.sent.business-app.json']) {
      const { conversation, convId } = await newConversation();
      const r = await ingest(fixture(f, { convId }));
      expect(r.route).toMatchObject({ action: 'notify_staff', reason: 'external_human_reply' });
      const c = await conv(conversation.id);
      expect(c.mode).toBe('HUMAN');
      expect(c.mode_reason).toBe('external_human_reply');
      expect((await one(`SELECT author_type FROM app.messages WHERE conversation_id = $1 AND direction = 'outbound'`, [conversation.id])).author_type)
        .toBe('external_human');
    }
  });

  it('unknown-origin and other-automation echoes suppress AI instead of guessing', async () => {
    for (const [f, hold] of [['message.sent.unknown-origin.json', 'unknown_outgoing_origin'], ['message.sent.zernio-workflow.json', 'other_automation']]) {
      const { conversation, convId } = await newConversation();
      const queued = await submit((await startJob(conversation.id)).job_id);
      await ingest(fixture(f, { convId }));
      const c = await conv(conversation.id);
      expect(c.mode).toBe('AUTO');                           // not assumed to be a human
      expect(c.automation_hold_reason).toBe(hold);
      expect((await one(`SELECT status FROM app.outbound_messages WHERE id = $1`, [queued.outbound_id])).status).toBe('canceled');
      expect((await startJob(conversation.id)).reason).toBe('automation_hold');
    }
  });

  it('HUMAN mode survives restarts and time; only an authorized action returns to AUTO', async () => {
    const { conversation, convId, phone } = await newConversation('human please');
    expect((await conv(conversation.id)).mode).toBe('HUMAN');
    await closePool();                                        // simulate a process restart
    await ingest(fixture('message.received.banglish.json', { convId, phone, text: 'hello?' }));
    await one(`UPDATE app.conversations SET mode_changed_at = now() - interval '30 days' WHERE id = $1`, [conversation.id]);
    expect((await conv(conversation.id)).mode).toBe('HUMAN');
    expect((await startJob(conversation.id)).reason).toBe('human_mode');

    const agent = await staff('agent');
    await expect(one(`SELECT app.set_mode($1, 'AUTO', $2)`, [conversation.id, agent])).rejects.toThrow(/permission denied/);
    const admin = await staff('admin');
    const r = (await one(`SELECT app.set_mode($1, 'AUTO', $2) AS r`, [conversation.id, admin])).r;
    expect(r.mode).toBe('AUTO');
  });

  it('returning to AUTO does not release canceled replies', async () => {
    const { conversation } = await newConversation();
    const admin = await staff('admin');
    const s = await submit((await startJob(conversation.id)).job_id);
    await one(`SELECT app.take_over($1, 'staff', $2, 'x', '{}', false)`, [conversation.id, admin]);
    await one(`SELECT app.set_mode($1, 'AUTO', $2)`, [conversation.id, admin]);
    expect((await one(`SELECT status FROM app.outbound_messages WHERE id = $1`, [s.outbound_id])).status).toBe('canceled');
    const z = fakeZernio();
    expect((await dispatchOnce(s.outbound_id, z.fn)).claimed).toBe(false);
    expect(z.sent.length).toBe(0);
  });
});

describe('staleness and global controls', () => {
  it('a new customer message invalidates an answer computed for the older state', async () => {
    const { conversation, convId, phone } = await newConversation();
    const j = await startJob(conversation.id);
    await ingest(fixture('message.received.banglish.json', { convId, phone, text: 'ar spotify?' }));
    expect(await submit(j.job_id)).toMatchObject({ result: 'stale', reason: 'conversation_changed' });

    // Queued before the new message → canceled at dispatch.
    const j2 = await startJob(conversation.id);
    const s2 = await submit(j2.job_id);
    await ingest(fixture('message.received.banglish.json', { convId, phone, text: 'r ekta kotha' }));
    const z = fakeZernio();
    expect(await dispatchOnce(s2.outbound_id, z.fn)).toMatchObject({ claimed: false, reason: 'conversation_changed' });
  });

  it('burst combining: the older message\'s run is skipped, the newest answers both', async () => {
    const { conversation, convId, phone } = await newConversation('hi');
    const r1 = (await ingest(fixture('message.received.banglish.json', { convId, phone, text: 'netflix' }))).route as any;
    const r2 = (await ingest(fixture('message.received.banglish.json', { convId, phone, text: 'er dam koto?' }))).route as any;
    expect(await startJob(conversation.id, r1.revision)).toMatchObject({ started: false, reason: 'superseded_by_newer_message' });
    expect((await startJob(conversation.id, r2.revision)).started).toBe(true);
  });

  it('global AI-off blocks AI dispatch and new AI jobs; staff can still reply', async () => {
    const { conversation } = await newConversation();
    const owner = await staff('owner');
    const s = await submit((await startJob(conversation.id)).job_id);
    await one(`SELECT app.set_global_controls($1, false, NULL)`, [owner]);
    const z = fakeZernio();
    expect((await dispatchOnce(s.outbound_id, z.fn)).claimed).toBe(false);
    expect((await startJob(conversation.id)).reason).toBe('ai_disabled');
    const st = (await one(`SELECT app.enqueue_staff_reply($1, $2, 'hello', '{}', NULL) AS r`, [conversation.id, owner])).r;
    expect((await dispatchOnce(st.outbound_id, z.fn)).outcome).toBe('accepted');
    // Re-enabling AI never releases what was canceled.
    await one(`SELECT app.set_global_controls($1, true, NULL)`, [owner]);
    expect((await one(`SELECT status FROM app.outbound_messages WHERE id = $1`, [s.outbound_id])).status).toBe('canceled');
  });

  it('an AI result finishing after AI is switched off is discarded', async () => {
    const { conversation } = await newConversation();
    const owner = await staff('owner');
    const j = await startJob(conversation.id);
    await one(`SELECT app.set_global_controls($1, false, NULL)`, [owner]);
    expect(await submit(j.job_id)).toMatchObject({ result: 'stale', reason: 'ai_disabled' });
  });

  it('emergency stop cancels every queued message, keeps saving inbound, and resume releases nothing', async () => {
    const { conversation, convId, phone } = await newConversation();
    const owner = await staff('owner');
    const ai = await submit((await startJob(conversation.id)).job_id);
    const st = (await one(`SELECT app.enqueue_staff_reply($1, $2, 'x', '{}', NULL) AS r`, [conversation.id, owner])).r;
    await one(`SELECT app.set_global_controls($1, NULL, false)`, [owner]);
    const r = await ingest(fixture('message.received.banglish.json', { convId, phone, text: 'still there?' }));
    expect(r.status).toBe('processed');
    await one(`SELECT app.set_global_controls($1, NULL, true)`, [owner]);
    const z = fakeZernio();
    expect((await dispatchOnce(ai.outbound_id, z.fn)).claimed).toBe(false);
    expect((await dispatchOnce(st.outbound_id, z.fn)).claimed).toBe(false);
    expect(z.sent.length).toBe(0);
    // The AI reply was already canceled by the staff reply's takeover; the
    // staff reply itself was canceled by the emergency stop.
    expect((await one(`SELECT status_reason FROM app.outbound_messages WHERE id = $1`, [ai.outbound_id])).status_reason).toBe('takeover');
    expect((await one(`SELECT status_reason FROM app.outbound_messages WHERE id = $1`, [st.outbound_id])).status_reason).toBe('emergency_stop');
  });

  it('agents cannot flip global controls', async () => {
    const agent = await staff('agent');
    await expect(one(`SELECT app.set_global_controls($1, false, NULL)`, [agent])).rejects.toThrow(/permission denied/);
    await expect(one(`SELECT app.set_global_controls($1, NULL, false)`, [agent])).rejects.toThrow(/permission denied/);
  });
});

describe('send outcomes and the messaging window', () => {
  it('unknown send outcomes do not trigger blind duplicate retries', async () => {
    const { conversation } = await newConversation();
    const s = await submit((await startJob(conversation.id)).job_id);
    let calls = 0;
    const timeout = async () => { calls++; return { status: null, networkError: 'timeout' }; };
    expect((await dispatchOnce(s.outbound_id, timeout)).outcome).toBe('ambiguous');
    expect((await one(`SELECT status FROM app.outbound_messages WHERE id = $1`, [s.outbound_id])).status).toBe('unknown');
    expect((await dispatchOnce(s.outbound_id, timeout)).claimed).toBe(false);   // no automatic retry
    expect(calls).toBe(1);
    const five = async () => ({ status: 502, body: { error: 'upstream' } });
    const s2 = await submit((await startJob(conversation.id)).job_id);
    expect((await dispatchOnce(s2.outbound_id, five)).outcome).toBe('ambiguous');
    expect((await sql(`SELECT 1 FROM app.alerts WHERE kind = 'send_unknown' AND resolved_at IS NULL`)).length).toBe(2);
  });

  it('an expired lease becomes unknown; reconciliation by evidence or a staff decision', async () => {
    const { conversation } = await newConversation();
    const s = await submit((await startJob(conversation.id)).job_id);
    await one(`SELECT app.claim_outbound($1, 't')`, [s.outbound_id]);
    await one(`UPDATE app.outbound_messages SET lease_until = now() - interval '1 second' WHERE id = $1`, [s.outbound_id]);
    expect((await one(`SELECT app.expire_send_leases() AS n`)).n).toBe(1);
    // Automation may confirm only with provider evidence, never "retry".
    await expect(one(`SELECT app.resolve_unknown_send($1, 'retry_same_key', NULL, NULL, '{}')`, [s.outbound_id])).rejects.toThrow();
    const r = (await one(`SELECT app.resolve_unknown_send($1, 'mark_sent', NULL, 'wamid.EVIDENCE', '{"found_in":"list_messages"}') AS r`, [s.outbound_id])).r;
    expect(r.ok).toBe(true);
    expect((await one(`SELECT status, provider_message_id FROM app.outbound_messages WHERE id = $1`, [s.outbound_id])))
      .toEqual({ status: 'sent', provider_message_id: 'wamid.EVIDENCE' });
  });

  it('a staff-approved retry reuses the same Idempotency-Key', async () => {
    const { conversation } = await newConversation();
    const agent = await staff('agent');
    const admin = await staff('admin');
    const st = (await one(`SELECT app.enqueue_staff_reply($1, $2, 'x', '{}', NULL) AS r`, [conversation.id, agent])).r;
    const z = fakeZernio();
    let first = true;
    const flaky = async (req: any) => { if (first) { first = false; await z.fn(req); return { status: null, networkError: 'timeout' }; } return z.fn(req); };
    await dispatchOnce(st.outbound_id, flaky);                // provider accepted, response lost
    await expect(one(`SELECT app.resolve_unknown_send($1, 'retry_same_key', $2)`, [st.outbound_id, agent])).rejects.toThrow(/permission denied/);
    await one(`SELECT app.resolve_unknown_send($1, 'retry_same_key', $2)`, [st.outbound_id, admin]);
    await dispatchOnce(st.outbound_id, flaky);
    expect(z.sent.length).toBe(1);                            // replayed by key, not sent twice
  });

  it('retryable rejections back off; permanent ones fail visibly', async () => {
    const { conversation } = await newConversation();
    const s = await submit((await startJob(conversation.id)).job_id);
    await dispatchOnce(s.outbound_id, async () => ({ status: 429, headers: { 'Retry-After': '30' } }));
    const row = await one(`SELECT status, next_attempt_at > now() + interval '20 seconds' AS later FROM app.outbound_messages WHERE id = $1`, [s.outbound_id]);
    expect(row).toEqual({ status: 'queued', later: true });
    const s2 = await submit((await startJob(conversation.id)).job_id);
    await dispatchOnce(s2.outbound_id, async () => ({ status: 400, body: { error: 'x', platformError: { code: 131026 } } }));
    expect((await one(`SELECT status FROM app.outbound_messages WHERE id = $1`, [s2.outbound_id])).status).toBe('failed');
  });

  it('messaging-window checks apply to AI, staff and system senders alike', async () => {
    const { conversation } = await newConversation();
    const agent = await staff('agent');
    const ai = await submit((await startJob(conversation.id)).job_id);
    await one(`UPDATE app.conversations SET last_inbound_at = now() - interval '25 hours' WHERE id = $1`, [conversation.id]);
    const z = fakeZernio();
    expect(await dispatchOnce(ai.outbound_id, z.fn)).toMatchObject({ claimed: false, reason: 'outside_customer_service_window' });
    await one(`UPDATE app.conversations SET mode = 'COPILOT' WHERE id = $1`, [conversation.id]);
    const st = (await one(`SELECT app.enqueue_staff_reply($1, $2, 'hello', '{}', NULL) AS r`, [conversation.id, agent])).r;
    expect(await dispatchOnce(st.outbound_id, z.fn)).toMatchObject({ claimed: false, reason: 'outside_customer_service_window' });
    const tpl = (await one(`SELECT app.enqueue_staff_reply($1, $2, NULL, '{"template":{"name":"order_update","language":"en_US"}}', NULL) AS r`,
      [conversation.id, agent])).r;
    const d = await dispatchOnce(tpl.outbound_id, z.fn);
    expect(d.outcome).toBe('accepted');
    expect(d.body!.template.elements[0].name).toBe('order_update');
    expect(z.sent.length).toBe(1);
  });
});

describe('copilot drafts', () => {
  it('COPILOT produces drafts only; approval sends; stale drafts need explicit confirmation', async () => {
    await setSetting('default_mode', 'COPILOT');
    const { conversation, convId, phone } = await newConversation();
    const agent = await staff('agent');
    const s = await submit((await startJob(conversation.id)).job_id);
    expect(s.result).toBe('drafted');
    expect((await sql(`SELECT 1 FROM app.outbound_messages WHERE conversation_id = $1`, [conversation.id])).length).toBe(0);

    await ingest(fixture('message.received.banglish.json', { convId, phone, text: 'hello?' }));
    expect((await one(`SELECT app.approve_draft($1, $2, NULL, false) AS r`, [s.draft_id, agent])).r)
      .toMatchObject({ ok: false, reason: 'stale_draft' });
    const ok = (await one(`SELECT app.approve_draft($1, $2, 'Edited reply', true) AS r`, [s.draft_id, agent])).r;
    expect(ok.ok).toBe(true);
    const z = fakeZernio();
    const d = await dispatchOnce(ok.outbound_id, z.fn);
    expect(d.body!.message).toBe('Edited reply');
    expect((await one(`SELECT author_type FROM app.messages WHERE outbound_id = $1`, [ok.outbound_id])).author_type).toBe('staff');
  });

  it('staff-assist in HUMAN mode produces a draft, never a send', async () => {
    const { conversation } = await newConversation('human please');
    const agent = await staff('agent');
    const j = (await one(`SELECT app.start_ai_job($1, 'staff_assist', NULL, NULL, $2) AS r`, [conversation.id, agent])).r;
    expect(j.started).toBe(true);
    const s = await submit(j.job_id);
    expect(s.result).toBe('drafted');
  });
});

describe('workflow database role (least privilege)', () => {
  it('cannot change modes or send directly, and cannot act as staff', async () => {
    const { conversation } = await newConversation();
    const owner = await staff('owner');
    await asN8nRole(async (c) => {
      await expect(c.query(`UPDATE app.conversations SET mode = 'AUTO' WHERE id = $1`, [conversation.id])).rejects.toThrow(/permission denied/);
      await expect(c.query(`UPDATE app.outbound_messages SET status = 'queued'`)).rejects.toThrow(/permission denied/);
      await expect(c.query(`SELECT app.set_mode($1, 'AUTO', $2)`, [conversation.id, owner])).rejects.toThrow(/permission denied/);
      await expect(c.query(`SELECT app.take_over($1, 'staff', $2, 'x', '{}', false)`, [conversation.id, owner]))
        .rejects.toThrow(/not allowed for the workflow role/);
      await expect(c.query(`SELECT app.set_global_controls($1, true, true)`, [owner])).rejects.toThrow(/permission denied/);
      // The functions it is meant to use work.
      const r = await c.query(`SELECT app.start_ai_job($1, 'reply', NULL, NULL) AS r`, [conversation.id]);
      expect(r.rows[0].r.started).toBe(true);
    });
  });
});

describe('history import', () => {
  it('imported messages never trigger replies or change the revision', async () => {
    const { conversation, convId, phone } = await newConversation();
    const before = (await conv(conversation.id)).revision;
    const { importHistoricalMessages } = await import('../../src/lib/ingest');
    const r = await importHistoricalMessages({
      provider_account_id: 'acc_000000000000000000000001',
      provider_conversation_id: convId,
      participant: { bsuid: null, phone_e164: phone, participant_id: phone.replace('+', ''), display_name: null, provider_contact_id: null },
      messages: [
        { provider_message_id: 'wamid.H1', direction: 'incoming', text: 'human please', sent_at: '2026-01-01T10:00:00Z' },
        { provider_message_id: 'wamid.H2', direction: 'outgoing', text: 'ok', sent_at: '2026-01-01T10:01:00Z', sent_via: 'human' },
      ],
    });
    expect(r.inserted).toBe(2);
    const c = await conv(conversation.id);
    expect(c.revision).toBe(before);
    expect(c.mode).toBe('AUTO');                              // the old "human please" did not hand off
    expect((await sql(`SELECT count(*)::int AS n FROM app.messages WHERE conversation_id = $1 AND is_historical`, [conversation.id]))[0].n).toBe(2);
    expect((await sql(`SELECT 1 FROM app.webhook_events`)).length).toBe(1); // only the live message was an event
  });
});

describe('customer identity scoping', () => {
  it('different WhatsApp BSUIDs never merge into one customer, even if a weaker id matches', async () => {
    const a = await newConversation('hi', { bsuid: 'BD.PERSON-A', phone: '+8801755555555' });
    const b = await newConversation('hello', { bsuid: 'BD.PERSON-B', phone: '+8801766666666' });
    // Force a shared participant id (e.g. a re-used number) on the second person.
    const p = fixture('message.received.banglish.json', { convId: b.convId, bsuid: 'BD.PERSON-B', phone: '+8801755555555' });
    await ingest(p);
    const ca = await conv(a.conversation.id);
    const cb = await conv(b.conversation.id);
    expect(ca.customer_id).not.toBe(cb.customer_id);
  });

  it('the same BSUID in a new conversation resolves to the same customer', async () => {
    const a = await newConversation('hi', { bsuid: 'BD.SAME', phone: '+8801777777777' });
    const b = await newConversation('again', { bsuid: 'BD.SAME', phone: '+8801777777777' });
    expect((await conv(a.conversation.id)).customer_id).toBe((await conv(b.conversation.id)).customer_id);
  });
});

describe('order operations', () => {
  async function pendingRefund() {
    const { conversation } = await newConversation('amar order refund chai');
    return (await one(`INSERT INTO app.pending_order_operations (operation_id, conversation_id, customer_id, op_type, woo_order_id, payload, status)
      VALUES ($1, $2, $3, 'refund', 1234, '{"details":"wrong plan"}', 'awaiting_staff_approval') RETURNING id`,
      [`test:${randomUUID()}`, conversation.id, conversation.customer_id])).id as string;
  }

  it('agents cannot approve or record outcomes; admins approve, then record the WooCommerce result once', async () => {
    const id = await pendingRefund();
    const agent = await staff('agent');
    const admin = await staff('admin');
    await expect(one(`SELECT app.decide_order_operation($1, $2, true) AS r`, [id, agent])).rejects.toThrow();
    // Recording before approval is refused.
    expect((await one(`SELECT app.record_order_operation_outcome($1, $2, 'succeeded') AS r`, [id, admin])).r)
      .toEqual({ ok: false, reason: 'status_awaiting_staff_approval' });
    expect((await one(`SELECT app.decide_order_operation($1, $2, true) AS r`, [id, admin])).r.ok).toBe(true);
    await expect(one(`SELECT app.record_order_operation_outcome($1, $2, 'succeeded') AS r`, [id, agent])).rejects.toThrow();
    await expect(one(`SELECT app.record_order_operation_outcome($1, $2, 'paid') AS r`, [id, admin])).rejects.toThrow();
    expect((await one(`SELECT app.record_order_operation_outcome($1, $2, 'succeeded', NULL, 'refunded in Woo') AS r`, [id, admin])).r)
      .toEqual({ ok: true, status: 'succeeded' });
    const row = await one(`SELECT status, result FROM app.pending_order_operations WHERE id = $1`, [id]);
    expect(row.status).toBe('succeeded');
    expect(row.result.note).toBe('refunded in Woo');
    expect((await one(`SELECT app.record_order_operation_outcome($1, $2, 'failed') AS r`, [id, admin])).r)
      .toEqual({ ok: false, reason: 'status_succeeded' });
    expect((await sql(`SELECT 1 FROM app.audit_log WHERE action = 'order_op.outcome_recorded' AND entity_id = $1`, [id])).length).toBe(1);
  });

  it('settling an unknown outcome resolves its alert', async () => {
    const id = await pendingRefund();
    const admin = await staff('admin');
    await one(`SELECT app.decide_order_operation($1, $2, true) AS r`, [id, admin]);
    await one(`SELECT app.claim_order_operation($1) AS r`, [id]);
    await one(`SELECT app.finish_order_operation($1, 'unknown', NULL, '{}') AS r`, [id]);
    expect((await sql(`SELECT 1 FROM app.alerts WHERE kind = 'order_op_unknown' AND resolved_at IS NULL`)).length).toBe(1);
    expect((await one(`SELECT app.record_order_operation_outcome($1, $2, 'failed') AS r`, [id, admin])).r.ok).toBe(true);
    expect((await sql(`SELECT 1 FROM app.alerts WHERE kind = 'order_op_unknown' AND resolved_at IS NULL`)).length).toBe(0);
  });
});
