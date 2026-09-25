import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { login, SESSION_COOKIE, sessionCookieOptions } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) });

export async function POST(req: NextRequest) {
  // Same-origin form posts only.
  const origin = req.headers.get('origin');
  if (origin && process.env.APP_ORIGIN && origin !== process.env.APP_ORIGIN) {
    return NextResponse.json({ error: 'Bad origin' }, { status: 403 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid email or password' }, { status: 400 });
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
  const r = await login(parsed.data.email.toLowerCase(), parsed.data.password, { ip, ua: req.headers.get('user-agent') });
  if (!r.ok) {
    return NextResponse.json({ error: r.reason === 'locked' ? 'Too many attempts. Try again in 15 minutes.' : 'Invalid email or password' },
      { status: r.reason === 'locked' ? 429 : 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, r.token, sessionCookieOptions(r.ttlHours * 3600));
  return res;
}
