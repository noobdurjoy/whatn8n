import { z } from 'zod';
import { getPool } from '@/lib/db';
import { HttpError, json, staffRoute } from '@/lib/http';

export const runtime = 'nodejs';

export const PATCH = staffRoute<{ id: string }, any>({ cap: 'manage_staff', body: z.object({
  role: z.enum(['owner', 'admin', 'agent']).optional(), active: z.boolean().optional(),
}) }, async ({ staff, params, body }) => {
  if (params.id === staff.id && (body.active === false || (body.role && body.role !== 'owner'))) {
    throw new HttpError(400, 'You cannot remove your own owner access');
  }
  await getPool().query(`UPDATE app.staff_users SET role = coalesce($2, role), active = coalesce($3, active) WHERE id = $1`,
    [params.id, body.role ?? null, body.active ?? null]);
  if (body.active === false) await getPool().query(`UPDATE app.staff_sessions SET revoked_at = now() WHERE staff_id = $1 AND revoked_at IS NULL`, [params.id]);
  await getPool().query(`SELECT app.audit('staff', $1, 'staff.updated', 'staff', $2, $3)`, [staff.id, params.id, body]);
  return json({ ok: true });
});
