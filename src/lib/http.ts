import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { currentStaff, type Staff } from './auth';
import { getPool, pgErrorStatus } from './db';
import { can, type Capability } from './permissions';

export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

type Ctx<P> = { req: NextRequest; staff: Staff; params: P };

// Wraps a staff API handler: authentication, CSRF on mutations, capability
// check, input validation and error mapping. Every staff action goes through
// here; the database functions then re-check permissions themselves.
export function staffRoute<P = Record<string, string>, B extends z.ZodTypeAny = z.ZodTypeAny>(
  opts: { cap: Capability; body?: B },
  handler: (ctx: Ctx<P> & { body: z.infer<B> }) => Promise<Response>,
) {
  return async (req: NextRequest, route: { params: Promise<P> }) => {
    try {
      const staff = await currentStaff();
      if (!staff) return json({ error: 'Not signed in' }, 401);
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const token = req.headers.get('x-csrf-token') || '';
        if (!token || !safeEqual(token, staff.csrf_token)) return json({ error: 'Invalid CSRF token' }, 403);
      }
      const agentsCanResumeAi = opts.cap === 'resume_ai'
        ? Boolean((await getPool().query(`SELECT app.setting_bool('agents_can_resume_ai', false) AS v`)).rows[0].v) : false;
      if (!can(staff.role, opts.cap, { agentsCanResumeAi })) return json({ error: 'Not allowed' }, 403);
      let body: any = undefined;
      if (opts.body) {
        const raw = await req.json().catch(() => null);
        const parsed = opts.body.safeParse(raw);
        if (!parsed.success) return json({ error: 'Invalid request', issues: parsed.error.issues.slice(0, 5) }, 400);
        body = parsed.data;
      }
      return await handler({ req, staff, params: await route.params, body });
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      const m = pgErrorStatus(err);
      if (m.status === 500) console.error('[api]', req.method, req.nextUrl.pathname, (err as Error)?.message);
      return json({ error: m.message }, m.status);
    }
  };
}

// For n8n → backend internal calls (history import, event re-processing).
export function internalRoute(handler: (req: NextRequest) => Promise<Response>) {
  return async (req: NextRequest) => {
    const expected = process.env.BACKEND_INTERNAL_TOKEN || '';
    const got = req.headers.get('x-internal-token') || '';
    if (!expected || !got || !safeEqual(got, expected)) return json({ error: 'Unauthorized' }, 401);
    try {
      return await handler(req);
    } catch (err) {
      console.error('[internal]', req.nextUrl.pathname, (err as Error)?.message);
      return json({ error: 'Internal error' }, 500);
    }
  };
}

export const uuid = z.string().uuid();
