import { z } from 'zod';
import { getPool } from '@/lib/db';
import { json, staffRoute } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Staff decisions on refunds, cancellations, address changes, renewals and
// access issues. Nothing is executed automatically: the AI's request is free
// text, so after approving, staff make the change in WooCommerce (refunds go
// through the payment gateway there) and then record the outcome here.
const Body = z.union([
  z.object({ approve: z.boolean(), note: z.string().max(500).optional() }),
  z.object({ outcome: z.enum(['succeeded', 'failed']), woo_order_id: z.number().int().positive().optional(), note: z.string().max(500).optional() }),
]);

export const POST = staffRoute<{ id: string }, typeof Body>({ cap: 'order_approve', body: Body },
  async ({ staff, params, body }) => {
    if ('outcome' in body) {
      const r = (await getPool().query(`SELECT app.record_order_operation_outcome($1, $2, $3, $4, $5) AS r`,
        [params.id, staff.id, body.outcome, body.woo_order_id ?? null, body.note ?? null])).rows[0].r;
      return json(r);
    }
    const r = (await getPool().query(`SELECT app.decide_order_operation($1, $2, $3, $4) AS r`,
      [params.id, staff.id, body.approve, body.note ?? null])).rows[0].r;
    return json(r);
  });
