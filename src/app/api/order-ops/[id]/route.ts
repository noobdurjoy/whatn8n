import { after } from 'next/server';
import { z } from 'zod';
import { getPool } from '@/lib/db';
import { json, staffRoute } from '@/lib/http';
import { n8n } from '@/lib/n8n';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Staff approval for refunds, cancellations, discounts, address and payment
// changes, and (by default) order creation. Execution happens in n8n workflow
// E, which claims the approved operation exactly once.
export const POST = staffRoute<{ id: string }, any>({ cap: 'order_approve', body: z.object({ approve: z.boolean(), note: z.string().max(500).optional() }) },
  async ({ staff, params, body }) => {
    const r = (await getPool().query(`SELECT app.decide_order_operation($1, $2, $3, $4) AS r`,
      [params.id, staff.id, body.approve, body.note ?? null])).rows[0].r;
    if (r.ok && body.approve) {
      const op = (await getPool().query(`SELECT operation_id FROM app.pending_order_operations WHERE id = $1`, [params.id])).rows[0];
      after(() => n8n.orderOp(op.operation_id));
    }
    return json(r);
  });
