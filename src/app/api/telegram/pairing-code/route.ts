import { randomInt } from 'node:crypto';
import { getPool } from '@/lib/db';
import { HttpError, json, staffRoute } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// No 0/O/1/I, so the code can be read aloud and typed without mistakes.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// Owner only: a single-use code, valid 10 minutes, shown once. Only its hash
// is stored. The owner sends "/pair CODE" to the project's Telegram bot.
export const POST = staffRoute({ cap: 'manage_staff' }, async ({ staff }) => {
  if (staff.role !== 'owner') throw new HttpError(403, 'Only the owner can pair the Telegram admin bot');
  let code = '';
  for (let i = 0; i < 8; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  const r = (await getPool().query(`SELECT app.create_telegram_pairing_code($1, $2) AS r`, [staff.id, code])).rows[0].r;
  return json({ code, expires_at: r.expires_at, command: `/pair ${code}` });
});
