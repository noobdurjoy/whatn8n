import { getPool } from '@/lib/db';
import { json, staffRoute } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = staffRoute({ cap: 'view_orders' }, async () => {
  const r = await getPool().query(
    `SELECT p.id, p.operation_id, p.op_type, p.woo_order_id, p.status, p.payload, p.quote, p.customer_confirmed_at, p.created_at,
            p.conversation_id, cu.display_name AS customer_name
       FROM app.pending_order_operations p JOIN app.customers cu ON cu.id = p.customer_id
      WHERE p.status IN ('awaiting_staff_approval', 'awaiting_customer_confirmation', 'approved', 'unknown', 'failed', 'executing')
      ORDER BY p.created_at DESC LIMIT 100`);
  return json({ operations: r.rows });
});
