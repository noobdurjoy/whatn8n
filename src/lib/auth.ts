import { createHash, randomBytes } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { cookies } from 'next/headers';
import { getPool } from './db';
import type { Role } from './permissions';

export const SESSION_COOKIE = 'wa_session';

export type Staff = { id: string; email: string; display_name: string; role: Role; csrf_token: string; session_id: string };

const sha256 = (s: string) => createHash('sha256').update(s).digest();

let dummy: Promise<string> | null = null;
function dummyHash() {
  if (!dummy) dummy = hashPassword(randomBytes(16).toString('hex'));
  return dummy;
}

export async function hashPassword(pw: string) {
  return argonHash(pw, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
}

// Login with lockout: 5 failures for an email within 15 minutes blocks further
// attempts for that email for 15 minutes (constant response either way).
export async function login(email: string, password: string, meta: { ip: string | null; ua: string | null }) {
  const pool = getPool();
  const fails = (await pool.query(
    `SELECT count(*)::int AS n FROM app.login_attempts WHERE email = $1 AND NOT succeeded AND at > now() - interval '15 minutes'`,
    [email])).rows[0].n;
  if (fails >= 5) return { ok: false as const, reason: 'locked' };

  const u = (await pool.query(
    `SELECT id, email, display_name, role, password_hash, active FROM app.staff_users WHERE email = $1`, [email])).rows[0];
  // Verify against a dummy hash when the user does not exist to keep timing flat.
  const ok = await argonVerify(u ? u.password_hash : await dummyHash(), password).catch(() => false);
  await pool.query(`INSERT INTO app.login_attempts (email, ip, succeeded) VALUES ($1, $2, $3)`, [email, meta.ip, Boolean(ok && u?.active)]);
  if (!u || !ok || !u.active) return { ok: false as const, reason: 'invalid' };

  const token = randomBytes(32).toString('base64url');
  const csrf = randomBytes(24).toString('base64url');
  const ttlHours = Number(process.env.SESSION_TTL_HOURS || 12);
  await pool.query(
    `INSERT INTO app.staff_sessions (token_hash, staff_id, csrf_token, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, now() + make_interval(hours => $4), $5, $6)`,
    [sha256(token), u.id, csrf, ttlHours, meta.ip, meta.ua?.slice(0, 300) ?? null]);
  await pool.query(`UPDATE app.staff_users SET last_login_at = now() WHERE id = $1`, [u.id]);
  await pool.query(`SELECT app.audit('staff', $1, 'auth.login', 'staff', $2, $3)`, [u.id, String(u.id), { ip: meta.ip }]);
  return { ok: true as const, token, ttlHours };
}

export async function sessionFromToken(token: string | undefined | null): Promise<Staff | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  const r = await getPool().query(
    `SELECT s.id AS session_id, s.csrf_token, u.id, u.email, u.display_name, u.role
       FROM app.staff_sessions s JOIN app.staff_users u ON u.id = s.staff_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.active`,
    [sha256(token)]);
  return r.rows[0] ?? null;
}

export async function currentStaff(): Promise<Staff | null> {
  const jar = await cookies();
  return sessionFromToken(jar.get(SESSION_COOKIE)?.value);
}

export async function logout(sessionId: string) {
  await getPool().query(`UPDATE app.staff_sessions SET revoked_at = now() WHERE id = $1`, [sessionId]);
}

export function sessionCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE !== 'false',
    sameSite: 'strict' as const,
    path: '/',
    maxAge: maxAgeSeconds,
  };
}
