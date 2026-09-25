import { NextResponse } from 'next/server';
import { currentStaff, logout, SESSION_COOKIE, sessionCookieOptions } from '@/lib/auth';

export const runtime = 'nodejs';

export async function POST() {
  const s = await currentStaff();
  if (s) await logout(s.session_id);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, '', sessionCookieOptions(0));
  return res;
}
