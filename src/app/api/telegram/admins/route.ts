import { z } from 'zod';
import { getPool } from '@/lib/db';
import { json, staffRoute } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = staffRoute({ cap: 'settings' }, async () => {
  const pool = getPool();
  const admins = (await pool.query(
    `SELECT a.id, a.telegram_user_id::text, a.chat_id::text, a.paired_via, a.created_at, a.revoked_at, s.display_name, s.role
       FROM app.telegram_admins a JOIN app.staff_users s ON s.id = a.staff_id ORDER BY a.revoked_at IS NULL DESC, a.created_at DESC LIMIT 50`)).rows;
  const pending = (await pool.query(
    `SELECT expires_at FROM app.telegram_pairing_codes WHERE used_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1`)).rows[0] ?? null;
  const commands = (await pool.query(
    `SELECT c.id, c.action ->> 'type' AS type, c.status, c.parsed_by, c.created_at, s.display_name
       FROM app.admin_commands c LEFT JOIN app.staff_users s ON s.id = c.staff_id ORDER BY c.created_at DESC LIMIT 30`)).rows;
  const stock = (await pool.query(
    `SELECT id, product_id, variation_id, sku, name, op, status, previous, requested, result, created_at FROM app.stock_changes ORDER BY created_at DESC LIMIT 30`)).rows;
  return json({ admins, pending_code_expires_at: pending?.expires_at ?? null, commands, stock });
});

// Owner: authorize a Telegram account by its numeric user id (for a private
// chat the chat id equals the user id). Usernames are never used.
export const POST = staffRoute({ cap: 'manage_staff', body: z.object({
  staff_id: z.string().uuid(), telegram_user_id: z.string().regex(/^[1-9]\d{4,15}$/), chat_id: z.string().regex(/^[1-9]\d{4,15}$/).optional(),
}) }, async ({ staff, body }) => {
  const r = (await getPool().query(`SELECT app.set_telegram_admin($1, $2, $3::bigint, $4::bigint) AS r`,
    [staff.id, body.staff_id, body.telegram_user_id, body.chat_id ?? body.telegram_user_id])).rows[0].r;
  return json(r, r.ok ? 200 : 400);
});
