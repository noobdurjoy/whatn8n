import { getPool } from '@/lib/db';
import { HttpError, staffRoute, uuid } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Data export for one customer: their profile, conversations and messages,
// stored preferences and linked orders. Internal staff notes are excluded.
export const GET = staffRoute<{ id: string }>({ cap: 'export_customer' }, async ({ staff, params }) => {
  if (!uuid.safeParse(params.id).success) throw new HttpError(404, 'Not found');
  const pool = getPool();
  const customer = (await pool.query(
    `SELECT id, display_name, phone_e164, preferred_language, marketing_consent, created_at FROM app.customers WHERE id = $1 AND deleted_at IS NULL`,
    [params.id])).rows[0];
  if (!customer) throw new HttpError(404, 'Not found');
  const conversations = (await pool.query(
    `SELECT c.id, c.created_at, c.status,
            coalesce((SELECT jsonb_agg(jsonb_build_object('direction', m.direction, 'author', m.author_type, 'kind', m.kind,
                      'text', m.body, 'sent_at', m.sent_at) ORDER BY m.sent_at) FROM app.messages m WHERE m.conversation_id = c.id), '[]') AS messages
       FROM app.conversations c WHERE c.customer_id = $1`, [params.id])).rows;
  const memories = (await pool.query(`SELECT key, value, confirmed_by, updated_at FROM app.customer_memories WHERE customer_id = $1 AND deleted_at IS NULL`, [params.id])).rows;
  const orders = (await pool.query(`SELECT woo_order_id, verified_method, verified_at FROM app.order_links WHERE customer_id = $1 AND revoked_at IS NULL`, [params.id])).rows;
  await pool.query(`INSERT INTO app.data_requests (customer_id, kind, requested_by, summary) VALUES ($1, 'export', $2, $3)`,
    [params.id, staff.id, { conversations: conversations.length }]);
  await pool.query(`SELECT app.audit('staff', $1, 'customer.export', 'customer', $2, '{}')`, [staff.id, params.id]);
  const body = JSON.stringify({ exported_at: new Date().toISOString(), customer, conversations, memories, orders }, null, 2);
  return new Response(body, { headers: {
    'content-type': 'application/json; charset=utf-8',
    'content-disposition': `attachment; filename="customer-${params.id.slice(0, 8)}.json"`,
    'cache-control': 'no-store',
  } });
});
