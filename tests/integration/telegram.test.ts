// Telegram admin bot: database-side rules (pairing, authorization, dedupe,
// command authority, stock-change guard, notices, notes, WhatsApp replies,
// notifications). The workflow calls these as the restricted wa_n8n role.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { asN8nRole, closePool, newConversation, one, resetData, setSetting, sql, staff } from './helpers';

beforeEach(async () => { await resetData(); });
afterAll(async () => { await closePool(); });

let seq = 1000;
const upd = (o: Record<string, unknown>) => ({ update_id: ++seq, kind: 'message', chat_type: 'private', ...o });
const accept = (p: any) => asN8nRole(async (c) => (await c.query('SELECT app.telegram_accept_update($1) AS r', [JSON.stringify(p)])).rows[0].r);

async function pairOwner(userId = 555001, chatId = 555001) {
  const owner = await staff('owner');
  await one(`SELECT app.create_telegram_pairing_code($1, 'ABCD2345')`, [owner]);
  const a = await accept(upd({ user_id: userId, chat_id: chatId, text: '/pair ABCD2345' }));
  expect(a.route).toBe('pair');
  const r = await asN8nRole(async (c) => (await c.query('SELECT app.telegram_pair($1, $2, $3, $4) AS r', [a.update_id, userId, chatId, a.code])).rows[0].r);
  expect(r.ok).toBe(true);
  return { owner, admin: r.admin_id as string, userId, chatId };
}
async function command(p: { admin: string; userId: number; chatId: number }, text: string, action: any) {
  const a = await accept(upd({ user_id: p.userId, chat_id: p.chatId, text }));
  expect(a.route).toBe('command');
  const r = await asN8nRole(async (c) => (await c.query(`SELECT app.admin_command_start($1, $2, $3, $4, 'rules', NULL) AS r`, [a.update_id, p.admin, text, JSON.stringify(action)])).rows[0].r);
  return { ...r, update_id: a.update_id };
}

describe('pairing', () => {
  it('pairs the owner with a single-use code; reuse, expiry and non-owners fail', async () => {
    const p = await pairOwner();
    // Reusing the code (from another Telegram user) fails.
    const again = await accept(upd({ user_id: 777, chat_id: 777, text: '/pair ABCD2345' }));
    const r2 = await asN8nRole(async (c) => (await c.query('SELECT app.telegram_pair($1, 777, 777, $2) AS r', [again.update_id, again.code])).rows[0].r);
    expect(r2).toEqual({ ok: false, reason: 'code_already_used' });
    // Expired code.
    await one(`SELECT app.create_telegram_pairing_code($1, 'ZZZZ2345')`, [p.owner]);
    await sql(`UPDATE app.telegram_pairing_codes SET expires_at = now() - interval '1 second' WHERE used_at IS NULL`);
    const e = await accept(upd({ user_id: 778, chat_id: 778, text: '/pair ZZZZ2345' }));
    const r3 = await asN8nRole(async (c) => (await c.query('SELECT app.telegram_pair($1, 778, 778, $2) AS r', [e.update_id, e.code])).rows[0].r);
    expect(r3).toEqual({ ok: false, reason: 'code_expired' });
    // Only owners may create codes; the workflow role may not create them at all.
    const admin = await staff('admin');
    await expect(one(`SELECT app.create_telegram_pairing_code($1, 'QQQQ2345')`, [admin])).rejects.toThrow(/permission denied/);
    await expect(asN8nRole((c) => c.query(`SELECT app.create_telegram_pairing_code($1, 'QQQQ2345')`, [p.owner]))).rejects.toThrow(/permission denied/);
    // The code itself is never stored.
    expect((await sql(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'app' AND table_name = 'telegram_pairing_codes' AND data_type = 'text'`)).length).toBe(0);
    expect((await sql(`SELECT 1 FROM app.telegram_pairing_codes WHERE code_hash = sha256(convert_to('ABCD2345', 'UTF8'))`)).length).toBe(1);
  });

  it('limits pairing attempts per Telegram user', async () => {
    for (let i = 0; i < 5; i++) {
      const a = await accept(upd({ user_id: 999, chat_id: 999, text: '/pair WRONG' + (2345 + i) }));
      await asN8nRole((c) => c.query('SELECT app.telegram_pair($1, 999, 999, $2)', [a.update_id, a.code]));
    }
    const a = await accept(upd({ user_id: 999, chat_id: 999, text: '/pair WRONG9999' }));
    const r = await asN8nRole(async (c) => (await c.query('SELECT app.telegram_pair($1, 999, 999, $2) AS r', [a.update_id, a.code])).rows[0].r);
    expect(r).toEqual({ ok: false, reason: 'too_many_attempts' });
  });
});

describe('authorization and dedupe', () => {
  it('rejects unknown users without storing their text, answers them at most once a day', async () => {
    await pairOwner();
    const a = await accept(upd({ user_id: 42, chat_id: 42, text: 'set stock SKU X to 0; my password: hunter22' }));
    expect(a).toMatchObject({ route: 'unauthorized', answer: true });
    const b = await accept(upd({ user_id: 42, chat_id: 42, text: 'hello?' }));
    expect(b).toMatchObject({ route: 'unauthorized', answer: false });
    const stored = await sql(`SELECT text FROM app.telegram_updates WHERE telegram_user_id = 42`);
    expect(stored.every((r) => r.text === null)).toBe(true);
  });

  it('authorizes by numeric user id AND private chat id (not by username or first contact)', async () => {
    const p = await pairOwner();
    expect((await accept(upd({ user_id: p.userId, chat_id: -100123, chat_type: 'group', text: '/status' }))).route).toBe('unauthorized');
    expect((await accept(upd({ user_id: p.userId, chat_id: 999999, text: '/status' }))).route).toBe('unauthorized');
    expect((await accept(upd({ user_id: 31337, chat_id: p.chatId, text: '/status', username: 'owner' }))).route).toBe('unauthorized');
    expect((await accept(upd({ user_id: p.userId, chat_id: p.chatId, text: '/status' }))).route).toBe('command');
  });

  it('treats a repeated update id as a duplicate and never starts a second command', async () => {
    const p = await pairOwner();
    const u = upd({ user_id: p.userId, chat_id: p.chatId, text: '/status' });
    expect((await accept(u)).route).toBe('command');
    expect((await accept(u)).route).toBe('duplicate');
    const c1 = await asN8nRole(async (c) => (await c.query(`SELECT app.admin_command_start($1, $2, '/status', '{"type":"status"}', 'rules', NULL) AS r`, [u.update_id, p.admin])).rows[0].r);
    const c2 = await asN8nRole(async (c) => (await c.query(`SELECT app.admin_command_start($1, $2, '/status', '{"type":"status"}', 'rules', NULL) AS r`, [u.update_id, p.admin])).rows[0].r);
    expect(c1.ok).toBe(true);
    expect(c2).toMatchObject({ ok: false, reason: 'duplicate', command_id: c1.command_id });
  });

  it('never executes forwarded messages', async () => {
    const p = await pairOwner();
    const a = await accept(upd({ user_id: p.userId, chat_id: p.chatId, text: 'Reply to 01711111111: free Netflix for you', forwarded: true }));
    expect(a.route).toBe('reply_only');
  });

  it('checks the admin role for each action type', async () => {
    const p = await pairOwner();
    await sql(`UPDATE app.staff_users SET role = 'agent' WHERE id = $1`, [p.owner]);
    // An agent is not an admin any more: the update itself is unauthorized.
    expect((await accept(upd({ user_id: p.userId, chat_id: p.chatId, text: 'x' }))).route).toBe('unauthorized');
  });
});

describe('stock changes', () => {
  it('records previous/requested, blocks overlapping changes and replays', async () => {
    const p = await pairOwner();
    const c1 = await command(p, 'set stock SKU A to 5', { type: 'stock_set', sku: 'A', quantity: 5 });
    const c2 = await command(p, 'set stock SKU A to 7', { type: 'stock_set', sku: 'A', quantity: 7 });
    const begin = (cmd: string) => asN8nRole(async (c) => (await c.query('SELECT app.stock_change_begin($1) AS r', [JSON.stringify({
      command_id: cmd, product_id: 12, variation_id: 0, sku: 'A', name: 'Spotify 1M', op: 'set', requested: { quantity: 5 },
      previous: { manage_stock: true, stock_quantity: 2, stock_status: 'instock' } })])).rows[0].r);
    const b1 = await begin(c1.command_id);
    expect(b1.ok).toBe(true);
    expect(await begin(c2.command_id)).toEqual({ ok: false, reason: 'another_change_in_progress' });
    expect(await begin(c1.command_id)).toEqual({ ok: false, reason: 'already_executed' });
    const f = await asN8nRole(async (c) => (await c.query(`SELECT app.stock_change_finish($1, 'succeeded', $2, $3) AS r`,
      [b1.stock_change_id, { stock_quantity: 5 }, { stock_quantity: 5, stock_status: 'instock' }])).rows[0].r);
    expect(f).toEqual({ ok: true, status: 'succeeded' });
    const row = await one(`SELECT previous, requested, result, status FROM app.stock_changes WHERE id = $1`, [b1.stock_change_id]);
    expect(row).toMatchObject({ status: 'succeeded', previous: { stock_quantity: 2 }, requested: { quantity: 5 }, result: { stock_quantity: 5 } });
    expect((await sql(`SELECT 1 FROM app.audit_log WHERE action = 'stock.succeeded'`)).length).toBe(1);
    // After the first finished, a new change may start.
    expect((await begin(c2.command_id)).ok).toBe(true);
  });

  it('an interrupted change becomes unknown (never retried automatically)', async () => {
    const p = await pairOwner();
    const c1 = await command(p, 'x', { type: 'stock_adjust', product_id: 12, delta: 3 });
    const b = await asN8nRole(async (c) => (await c.query('SELECT app.stock_change_begin($1) AS r', [JSON.stringify({
      command_id: c1.command_id, product_id: 12, op: 'adjust', requested: { delta: 3 }, previous: { stock_quantity: 1 } })])).rows[0].r);
    await sql(`UPDATE app.stock_changes SET created_at = now() - interval '10 minutes' WHERE id = $1`, [b.stock_change_id]);
    await asN8nRole((c) => c.query('SELECT app.expire_stuck_stock_changes()'));
    expect((await one(`SELECT status FROM app.stock_changes WHERE id = $1`, [b.stock_change_id])).status).toBe('unknown');
  });
});

describe('knowledge, notices and notes', () => {
  it('temporary notices need an expiry, expire at read time and support versions and cancel', async () => {
    const p = await pairOwner();
    const noExp = await command(p, 'Temporary: Netflix delayed', { type: 'notice_temporary' });
    const r0 = await asN8nRole(async (c) => (await c.query('SELECT app.admin_save_notice($1) AS r', [JSON.stringify({ command_id: noExp.command_id, body: 'Netflix delivery is delayed.' })])).rows[0].r);
    expect(r0).toEqual({ ok: false, reason: 'expiry_required' });
    const cmd = await command(p, 'Temporary: Netflix delayed until tomorrow 6pm', { type: 'notice_temporary' });
    const exp = new Date(Date.now() + 3600e3).toISOString();
    const r = await asN8nRole(async (c) => (await c.query('SELECT app.admin_save_notice($1) AS r', [JSON.stringify({
      command_id: cmd.command_id, body: 'Netflix delivery is delayed until tomorrow 6pm.', expires_at: exp, keywords: ['netflix'] })])).rows[0].r);
    expect(r.ok).toBe(true);
    expect(r.expires_local).toMatch(/Asia\/Dhaka$/);
    expect((await one(`SELECT app.active_notices_for('netflix er dam?') AS n`)).n).toHaveLength(1);
    expect((await one(`SELECT app.active_notices_for('spotify?') AS n`)).n).toHaveLength(0);
    // Expired by time alone (no cleanup ran): excluded immediately.
    await sql(`UPDATE app.temporary_notices SET starts_at = now() - interval '2 hours', expires_at = now() - interval '1 second'`);
    expect((await one(`SELECT app.active_notices_for('netflix') AS n`)).n).toHaveLength(0);
    // Not started yet: excluded too.
    await sql(`UPDATE app.temporary_notices SET starts_at = now() + interval '1 hour', expires_at = now() + interval '2 hours'`);
    expect((await one(`SELECT app.active_notices_for('netflix') AS n`)).n).toHaveLength(0);
    // Cancel.
    await sql(`UPDATE app.temporary_notices SET starts_at = now() - interval '1 minute'`);
    const cc = await command(p, 'Remove the temporary Netflix notice', { type: 'notice_cancel', match: 'netflix' });
    const x = await asN8nRole(async (c) => (await c.query('SELECT app.admin_cancel_notice($1, $2) AS r', [cc.command_id, r.notice_key])).rows[0].r);
    expect(x).toEqual({ ok: true, canceled: 1 });
    expect((await one(`SELECT app.active_notices_for('netflix') AS n`)).n).toHaveLength(0);
  });

  it('permanent knowledge from the owner is published immediately; private notes never reach customers', async () => {
    const p = await pairOwner();
    const k = await command(p, 'Remember: support hours are 10am to 10pm.', { type: 'knowledge_permanent' });
    const r = await asN8nRole(async (c) => (await c.query(`SELECT app.admin_save_knowledge($1, 'Support hours', 'Support hours are 10am to 10pm.', 'policy') AS r`, [k.command_id])).rows[0].r);
    expect(r.ok).toBe(true);
    expect((await sql(`SELECT title FROM app.search_knowledge('support hours', 5)`)).map((x) => x.title)).toContain('Support hours');
    const n = await command(p, 'Note: supplier SECRETCODE delay', { type: 'staff_note' });
    await asN8nRole((c) => c.query(`SELECT app.admin_save_staff_note($1, 'Supplier SECRETCODE is late this week')`, [n.command_id]));
    expect((await sql(`SELECT * FROM app.search_knowledge('supplier SECRETCODE', 5)`)).length).toBe(0);
    expect(JSON.stringify((await one(`SELECT app.active_notices_for('supplier') AS n`)).n)).not.toMatch(/SECRETCODE/);
    const { conversation } = await newConversation('supplier?');
    const j = await one(`SELECT app.start_ai_job($1, 'reply', NULL, NULL) AS r`, [conversation.id]);
    expect(JSON.stringify((await one(`SELECT app.get_ai_context($1, 20) AS c`, [j.r.job_id])).c)).not.toMatch(/SECRETCODE/);
  });
});

describe('WhatsApp reply from Telegram', () => {
  it('normalizes a local number, queues the exact text through the outbox, takes over in AUTO, and never duplicates', async () => {
    await setSetting('default_mode', 'AUTO');
    const p = await pairOwner();
    const { conversation } = await newConversation('stock ache?', { phone: '+8801350590593' });
    await sql(`UPDATE app.channel_accounts SET enabled = true`);
    const cmd = await command(p, 'Reply to 01350590593: stock available now.', { type: 'reply_whatsapp', phone: '01350590593', text: 'stock available now.' });
    const r = await asN8nRole(async (c) => (await c.query(`SELECT app.admin_reply_whatsapp($1, '01350590593', 'stock available now.', NULL) AS r`, [cmd.command_id])).rows[0].r);
    expect(r).toMatchObject({ ok: true, phone: '+8801350590593', conversation_id: conversation.id });
    const o = await one(`SELECT body, actor_type, payload, status FROM app.outbound_messages WHERE id = $1`, [r.outbound_id]);
    expect(o).toMatchObject({ body: 'stock available now.', actor_type: 'staff', status: 'queued', payload: { origin: 'telegram_admin' } });
    expect((await one(`SELECT mode FROM app.conversations WHERE id = $1`, [conversation.id])).mode).toBe('HUMAN');
    // The same command again cannot queue a second message.
    const again = await asN8nRole(async (c) => (await c.query(`SELECT app.admin_reply_whatsapp($1, '01350590593', 'stock available now.', NULL) AS r`, [cmd.command_id])).rows[0].r);
    expect(again).toMatchObject({ ok: false, reason: 'command_not_open' });
    expect((await sql(`SELECT 1 FROM app.outbound_messages WHERE conversation_id = $1`, [conversation.id])).length).toBe(1);
    // The emergency stop still applies: the dispatcher's claim refuses it.
    await setSetting('sending_enabled', false);
    const claim = await asN8nRole(async (c) => (await c.query(`SELECT app.claim_outbound($1, 'test') AS r`, [r.outbound_id])).rows[0].r);
    expect(claim.claimed).toBe(false);
  });

  it('asks when the number is unknown or matches several WhatsApp conversations', async () => {
    const p = await pairOwner();
    const none = await command(p, 'Reply to 01999999999: hi', { type: 'reply_whatsapp' });
    const r1 = await asN8nRole(async (c) => (await c.query(`SELECT app.admin_reply_whatsapp($1, '01999999999', 'hi', NULL) AS r`, [none.command_id])).rows[0].r);
    expect(r1).toMatchObject({ ok: false, reason: 'no_whatsapp_conversation', phone: '+8801999999999' });
    await newConversation('a', { phone: '+8801888000111', accountId: 'acc_A' });
    await newConversation('b', { phone: '+8801888000111', accountId: 'acc_B' });
    await sql(`UPDATE app.channel_accounts SET enabled = true`);
    const two = await command(p, 'Reply to 01888000111: hi', { type: 'reply_whatsapp' });
    const r2 = await asN8nRole(async (c) => (await c.query(`SELECT app.admin_reply_whatsapp($1, '01888000111', 'hi', NULL) AS r`, [two.command_id])).rows[0].r);
    expect(r2.reason).toBe('ambiguous');
    expect(r2.choices).toHaveLength(2);
  });

  it('the workflow role still cannot act as staff outside a verified admin command', async () => {
    const owner = await staff('owner');
    const { conversation } = await newConversation('x');
    await expect(asN8nRole((c) => c.query(`SELECT app.enqueue_staff_reply($1, $2, 'hi', '{}', NULL)`, [conversation.id, owner])))
      .rejects.toThrow(/permission denied/);
  });
});

describe('admin notifications', () => {
  it('queues by category mode, dedupes, respects the rate limit and summarizes', async () => {
    const p = await pairOwner();
    await setSetting('telegram_notifications', { enabled: true, max_per_minute: 2, categories: { new_conversation: 'immediate', customer_message: 'summary', handoff: 'disabled' } });
    await newConversation('hello');
    await newConversation('hi');
    await newConversation('hey');
    const rows = await sql(`SELECT category, mode FROM app.admin_notifications ORDER BY created_at`);
    expect(rows.filter((r) => r.category === 'new_conversation')).toHaveLength(3);
    // Duplicate dedupe key: nothing new.
    await one(`SELECT app.notify_admin('orders', 'order:1:new', 'New order #1')`);
    await one(`SELECT app.notify_admin('orders', 'order:1:new', 'New order #1')`);
    expect((await sql(`SELECT 1 FROM app.admin_notifications WHERE dedupe_key = 'order:1:new'`)).length).toBe(1);
    // Disabled category: dropped.
    expect((await one(`SELECT app.notify_admin('handoff', 'h:1', 'x') AS r`)).r).toBe(false);
    // Rate limit: at most 2 per minute.
    const batch = await asN8nRole(async (c) => (await c.query('SELECT app.claim_admin_notifications(10) AS r')).rows[0].r);
    expect(batch).toHaveLength(2);
    expect(Number(batch[0].chat_id)).toBe(p.chatId);
    for (const b of batch) await asN8nRole((c) => c.query('SELECT app.finish_admin_notification($1, true, NULL)', [b.notification_id]));
    expect(await asN8nRole(async (c) => (await c.query('SELECT app.claim_admin_notifications(10) AS r')).rows[0].r)).toHaveLength(0);
    // A failed send goes back to pending (the customer action is not repeated; only the message is).
    await sql(`UPDATE app.admin_notifications SET sent_at = now() - interval '2 minutes' WHERE status = 'sent'`);
    const next = await asN8nRole(async (c) => (await c.query('SELECT app.claim_admin_notifications(10) AS r')).rows[0].r);
    await asN8nRole((c) => c.query('SELECT app.finish_admin_notification($1, false, $2)', [next[0].notification_id, 'telegram 502']));
    expect((await one(`SELECT status FROM app.admin_notifications WHERE id = $1`, [next[0].notification_id])).status).toBe('pending');
    // Daily summary.
    const s = await asN8nRole(async (c) => (await c.query('SELECT app.admin_daily_summary() AS r')).rows[0].r);
    expect(s[0].text).toMatch(/Daily summary/);
    expect((await sql(`SELECT 1 FROM app.admin_notifications WHERE mode = 'summary' AND status = 'pending'`)).length).toBe(0);
  });
});

describe('observation mode', () => {
  it('sends COPILOT reply drafts to Telegram with the customer message; staff-assist drafts are not sent', async () => {
    await pairOwner();
    await setSetting('default_mode', 'COPILOT');
    await setSetting('telegram_notifications', { enabled: true, max_per_minute: 20, categories: { ai_draft: 'immediate', new_conversation: 'disabled' } });
    const { conversation } = await newConversation('bhai netflix er dam koto?');
    const job = (await one(`SELECT app.start_ai_job($1, 'reply', NULL, NULL) AS r`, [conversation.id])).r;
    const s = (await one(`SELECT app.submit_ai_result($1, 'reply', 'Netflix 1 month is available.', NULL, '[]', '{}') AS r`, [job.job_id])).r;
    expect(s.result).toBe('drafted');
    const rows = await sql(`SELECT category, mode, title, detail FROM app.admin_notifications WHERE category = 'ai_draft'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].mode).toBe('immediate');
    expect(rows[0].title).toMatch(/NOT sent/);
    expect(rows[0].detail).toContain('bhai netflix er dam koto?');
    expect(rows[0].detail).toContain('Netflix 1 month is available.');
    expect((await sql(`SELECT 1 FROM app.outbound_messages WHERE conversation_id = $1`, [conversation.id])).length).toBe(0);

    const agent = await staff('agent');
    const j2 = (await one(`SELECT app.start_ai_job($1, 'staff_assist', NULL, NULL, $2) AS r`, [conversation.id, agent])).r;
    await one(`SELECT app.submit_ai_result($1, 'reply', 'assist text', NULL, '[]', '{}') AS r`, [j2.job_id]);
    expect(await sql(`SELECT 1 FROM app.admin_notifications WHERE category = 'ai_draft'`)).toHaveLength(1);
  });
});
