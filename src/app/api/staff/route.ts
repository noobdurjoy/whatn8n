import { z } from 'zod';
import { hashPassword } from '@/lib/auth';
import { getPool } from '@/lib/db';
import { json, staffRoute } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = staffRoute({ cap: 'view' }, async () => {
  const r = await getPool().query(`SELECT id, email, display_name, role, active, last_login_at FROM app.staff_users ORDER BY display_name`);
  return json({ staff: r.rows });
});

export const POST = staffRoute({ cap: 'manage_staff', body: z.object({
  email: z.string().email().max(200), display_name: z.string().min(1).max(80), role: z.enum(['owner', 'admin', 'agent']),
  password: z.string().min(12).max(200),
}) }, async ({ staff, body }) => {
  const r = await getPool().query(
    `INSERT INTO app.staff_users (email, display_name, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING id`,
    [body.email.toLowerCase(), body.display_name, body.role, await hashPassword(body.password)]);
  await getPool().query(`SELECT app.audit('staff', $1, 'staff.created', 'staff', $2, $3)`, [staff.id, r.rows[0].id, { role: body.role }]);
  return json(r.rows[0]);
});
