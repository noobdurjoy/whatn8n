import { internalRoute, json } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Used by the workflow's connection check to prove the n8n → backend token
// works. Reads and changes nothing.
export const GET = internalRoute(async () => json({ ok: true }));
