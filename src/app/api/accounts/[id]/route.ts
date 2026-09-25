import { z } from 'zod';
import { getPool } from '@/lib/db';
import { json, staffRoute } from '@/lib/http';

export const runtime = 'nodejs';

// Enable a connected WhatsApp account for AI/sending. Messages from disabled
// accounts are still saved.
export const PATCH = staffRoute<{ id: string }, any>({ cap: 'settings', body: z.object({ enabled: z.boolean() }) }, async ({ staff, params, body }) => {
  const r = await getPool().query(`UPDATE app.channel_accounts SET enabled = $2 WHERE id = $1 AND provider_account_id <> 'sandbox' RETURNING id`,
    [params.id, body.enabled]);
  await getPool().query(`SELECT app.audit('staff', $1, 'channel_account.enabled', 'channel_account', $2, $3)`, [staff.id, params.id, { enabled: body.enabled }]);
  return json({ ok: r.rowCount === 1 });
});
