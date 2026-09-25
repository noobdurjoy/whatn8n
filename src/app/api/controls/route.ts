import { z } from 'zod';
import { getPool } from '@/lib/db';
import { HttpError, json, staffRoute } from '@/lib/http';
import { can } from '@/lib/permissions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = staffRoute({ cap: 'view' }, async () => {
  const r = (await getPool().query(
    `SELECT app.setting_bool('ai_enabled', false) AS ai_enabled, app.setting_bool('sending_enabled', true) AS sending_enabled,
            (SELECT count(*)::int FROM app.outbound_messages WHERE status = 'sending') AS in_flight,
            (SELECT count(*)::int FROM app.outbound_messages WHERE status = 'queued') AS queued,
            coalesce((SELECT checked_at > now() - interval '3 minutes' FROM app.health_checks WHERE component = 'n8n_maintenance'), false) AS automation_ok`)).rows[0];
  return json(r);
});

// Global AI switch and the emergency "stop all outgoing messages" control.
export const POST = staffRoute({ cap: 'view', body: z.object({ ai_enabled: z.boolean().optional(), sending_enabled: z.boolean().optional() }) },
  async ({ staff, body }) => {
    if (body.ai_enabled !== undefined && !can(staff.role, 'global_ai')) throw new HttpError(403, 'Not allowed');
    if (body.sending_enabled !== undefined && !can(staff.role, 'emergency_stop')) throw new HttpError(403, 'Not allowed');
    const r = await getPool().query(`SELECT app.set_global_controls($1, $2, $3) AS r`,
      [staff.id, body.ai_enabled ?? null, body.sending_enabled ?? null]);
    return json(r.rows[0].r);
  });
