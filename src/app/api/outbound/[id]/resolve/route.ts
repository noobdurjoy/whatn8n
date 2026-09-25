import { after } from 'next/server';
import { z } from 'zod';
import { getPool } from '@/lib/db';
import { json, staffRoute } from '@/lib/http';
import { n8n } from '@/lib/n8n';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Staff decision for a send whose outcome is unknown or failed:
// mark_sent (after checking WhatsApp), retry_same_key (same Idempotency-Key;
// still passes every dispatch check) or discard.
export const POST = staffRoute<{ id: string }, any>({
  cap: 'reconcile_send',
  body: z.object({
    resolution: z.enum(['mark_sent', 'retry_same_key', 'discard']),
    provider_message_id: z.string().max(300).optional(),
    note: z.string().max(500).optional(),
  }),
}, async ({ staff, params, body }) => {
  const r = (await getPool().query(`SELECT app.resolve_unknown_send($1, $2, $3, $4, $5) AS r`,
    [params.id, body.resolution, staff.id, body.provider_message_id ?? null, { note: body.note ?? null }])).rows[0].r;
  if (r.ok && body.resolution === 'retry_same_key') after(() => n8n.dispatch(params.id));
  return json(r);
});
