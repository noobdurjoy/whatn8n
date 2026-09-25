import { getPool } from './db';
import type { Staff } from './auth';

// Agents see every conversation unless the owner turns on
// "agents_see_assigned_only"; then they see their own plus the unassigned
// queue. Used by list/detail queries AND by the realtime stream.
export async function visibilityClause(staff: Staff, alias = 'cv'): Promise<{ sql: string; params: unknown[] }> {
  if (staff.role !== 'agent') return { sql: 'true', params: [] };
  const only = (await getPool().query(`SELECT app.setting_bool('agents_see_assigned_only', false) AS v`)).rows[0].v;
  if (!only) return { sql: 'true', params: [] };
  return { sql: `(${alias}.assigned_to = $V OR ${alias}.assigned_to IS NULL)`, params: [staff.id] };
}

function bindVisibility(clause: { sql: string; params: unknown[] }, startIndex: number) {
  return { sql: clause.sql.replace('$V', `$${startIndex}`), params: clause.params };
}

export async function canSeeConversation(staff: Staff, conversationId: string) {
  const vis = bindVisibility(await visibilityClause(staff), 2);
  const r = await getPool().query(`SELECT 1 FROM app.conversations cv WHERE cv.id = $1 AND NOT cv.is_sandbox AND ${vis.sql}`,
    [conversationId, ...vis.params]);
  return r.rowCount === 1;
}

export type ListFilters = {
  q?: string; mode?: string; status?: string; queue?: 'waiting' | 'mine' | 'unassigned' | 'attention';
  tag?: string; before?: string; limit?: number;
};

export async function listConversations(staff: Staff, f: ListFilters) {
  const params: unknown[] = [];
  const where: string[] = ['NOT cv.is_sandbox'];
  const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
  if (f.mode) where.push(`cv.mode = ${add(f.mode)}`);
  if (f.status) where.push(`cv.status = ${add(f.status)}`);
  else where.push(`cv.status IN ('open', 'pending')`);
  if (f.tag) where.push(`${add(f.tag)} = ANY (cv.tags)`);
  if (f.queue === 'waiting') where.push(`cv.queue_state = 'waiting_staff'`);
  if (f.queue === 'mine') where.push(`cv.assigned_to = ${add(staff.id)}`);
  if (f.queue === 'unassigned') where.push(`cv.assigned_to IS NULL`);
  if (f.queue === 'attention') {
    where.push(`(cv.queue_state = 'waiting_staff' OR cv.automation_hold_reason IS NOT NULL
      OR EXISTS (SELECT 1 FROM app.outbound_messages o WHERE o.conversation_id = cv.id AND o.status IN ('unknown', 'failed', 'blocked'))
      OR EXISTS (SELECT 1 FROM app.ai_drafts d WHERE d.conversation_id = cv.id AND d.status = 'pending_review'))`);
  }
  if (f.before) where.push(`cv.last_message_at < ${add(f.before)}`);
  if (f.q && f.q.trim()) {
    const q = f.q.trim().slice(0, 100);
    where.push(`(cu.display_name ILIKE ${add(`%${q}%`)} OR cu.phone_e164 ILIKE ${add(`%${q}%`)}
      OR EXISTS (SELECT 1 FROM app.messages m WHERE m.conversation_id = cv.id AND m.search_tsv @@ websearch_to_tsquery('simple', ${add(q)})))`);
  }
  const vis = await visibilityClause(staff);
  if (vis.params.length) where.push(vis.sql.replace('$V', add(vis.params[0])));
  const limit = Math.min(Math.max(f.limit ?? 40, 1), 100);
  const r = await getPool().query(
    `SELECT cv.id, cv.mode, cv.mode_version, cv.status, cv.priority, cv.queue_state, cv.tags, cv.unread_count,
            cv.last_message_at, cv.last_message_preview, cv.last_inbound_at, cv.first_response_due_at,
            cv.automation_hold_reason, cv.assigned_to, su.display_name AS assigned_name,
            cu.id AS customer_id, cu.display_name AS customer_name, cu.phone_e164, cu.preferred_language,
            (SELECT count(*)::int FROM app.ai_drafts d WHERE d.conversation_id = cv.id AND d.status = 'pending_review') AS pending_drafts,
            (SELECT count(*)::int FROM app.outbound_messages o WHERE o.conversation_id = cv.id AND o.status IN ('unknown', 'failed', 'blocked')) AS send_problems
       FROM app.conversations cv
       JOIN app.customers cu ON cu.id = cv.customer_id
       LEFT JOIN app.staff_users su ON su.id = cv.assigned_to
      WHERE ${where.join(' AND ')}
      ORDER BY cv.last_message_at DESC NULLS LAST
      LIMIT ${limit}`, params);
  return r.rows;
}

export async function conversationDetail(conversationId: string) {
  const pool = getPool();
  const conv = (await pool.query(
    `SELECT cv.*, su.display_name AS assigned_name, ca.display_name AS account_name, ca.enabled AS account_enabled, ca.status AS account_status,
            cv.last_inbound_at > now() - make_interval(hours => app.setting_int('messaging_window_hours', 24)) AS window_open
       FROM app.conversations cv
       LEFT JOIN app.staff_users su ON su.id = cv.assigned_to
       JOIN app.channel_accounts ca ON ca.id = cv.channel_account_id
      WHERE cv.id = $1`, [conversationId])).rows[0];
  if (!conv) return null;
  const [customer, messages, notes, drafts, outbound, memories, summary, orderOps, orderLinks, modeChanges, jobs] = await Promise.all([
    pool.query(`SELECT id, display_name, phone_e164, preferred_language, marketing_consent, created_at,
                       EXISTS (SELECT 1 FROM app.customer_account_links l WHERE l.customer_id = c.id AND l.revoked_at IS NULL) AS account_linked
                  FROM app.customers c WHERE id = $1`, [conv.customer_id]),
    pool.query(
      `SELECT m.id, m.direction, m.author_type, m.author_staff_id, su.display_name AS author_name, m.kind, m.body, m.sent_at,
              m.delivery_status, m.delivery_error, m.sent_via, m.send_source, m.is_historical, m.edited_at, m.deleted_by_sender_at,
              m.reactions, m.outbound_id, m.metadata ->> 'origin' AS origin,
              coalesce((SELECT jsonb_agg(jsonb_build_object('id', a.id, 'media_type', a.media_type, 'mime_type', a.mime_type,
                        'size_bytes', a.size_bytes, 'fetch_status', a.fetch_status, 'file_name', a.file_name,
                        'analysis', (SELECT jsonb_build_object('status', ia.status, 'model', ia.model, 'result', ia.result, 'error', ia.error, 'at', ia.created_at)
                                     FROM app.image_analyses ia WHERE ia.attachment_id = a.id ORDER BY ia.created_at DESC LIMIT 1))
                        ORDER BY a.position) FROM app.attachments a WHERE a.message_id = m.id), '[]') AS attachments
         FROM app.messages m LEFT JOIN app.staff_users su ON su.id = m.author_staff_id
        WHERE m.conversation_id = $1
        ORDER BY m.sent_at DESC, m.recorded_at DESC LIMIT 200`, [conversationId]),
    pool.query(`SELECT n.id, n.body, n.created_at, su.display_name AS author FROM app.internal_notes n
                  JOIN app.staff_users su ON su.id = n.staff_id WHERE n.conversation_id = $1 ORDER BY n.created_at`, [conversationId]),
    pool.query(`SELECT id, body, decision, status, references_used, revision, mode_version, created_at, invalidated_reason,
                       revision <> $2 AS stale
                  FROM app.ai_drafts WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 10`, [conversationId, conv.revision]),
    pool.query(`SELECT id, kind, actor_type, body, status, status_reason, attempts, in_flight_at_takeover, created_at, sent_at,
                       last_error, provider_message_id
                  FROM app.outbound_messages WHERE conversation_id = $1 AND (status <> 'sent' OR created_at > now() - interval '1 day')
                 ORDER BY created_at DESC LIMIT 30`, [conversationId]),
    pool.query(`SELECT id, key, value, confirmed_by, updated_at FROM app.customer_memories WHERE customer_id = $1 AND deleted_at IS NULL ORDER BY key`, [conv.customer_id]),
    pool.query(`SELECT summary, actions_taken, open_issues, updated_at FROM app.conversation_summaries WHERE conversation_id = $1`, [conversationId]),
    pool.query(`SELECT id, operation_id, op_type, woo_order_id, status, payload, quote, customer_confirmed_at, created_at
                  FROM app.pending_order_operations WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 20`, [conversationId]),
    pool.query(`SELECT l.woo_order_id, l.verified_method, l.verified_at, r.status, r.total_minor, r.currency, r.date_paid
                  FROM app.order_links l LEFT JOIN app.woo_order_refs r ON r.woo_order_id = l.woo_order_id
                 WHERE l.customer_id = $1 AND l.revoked_at IS NULL ORDER BY l.verified_at DESC LIMIT 20`, [conv.customer_id]),
    pool.query(`SELECT mc.from_mode, mc.to_mode, mc.reason, mc.actor_type, su.display_name AS actor_name, mc.at
                  FROM app.mode_changes mc LEFT JOIN app.staff_users su ON su.id = mc.actor_staff_id
                 WHERE mc.conversation_id = $1 ORDER BY mc.at DESC LIMIT 20`, [conversationId]),
    pool.query(`SELECT id, kind, status, decision, discard_reason, started_at, finished_at FROM app.ai_jobs
                 WHERE conversation_id = $1 ORDER BY started_at DESC LIMIT 10`, [conversationId]),
  ]);
  return {
    conversation: conv,
    customer: customer.rows[0],
    messages: messages.rows.reverse(),
    notes: notes.rows,
    drafts: drafts.rows,
    outbound: outbound.rows,
    memories: memories.rows,
    summary: summary.rows[0] ?? null,
    order_operations: orderOps.rows,
    orders: orderLinks.rows,
    mode_changes: modeChanges.rows,
    ai_jobs: jobs.rows,
  };
}
