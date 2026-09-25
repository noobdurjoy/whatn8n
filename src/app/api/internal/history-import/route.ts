import { z } from 'zod';
import { internalRoute, json } from '@/lib/http';
import { importHistoricalMessages } from '@/lib/ingest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  provider_account_id: z.string().min(1).max(200),
  provider_conversation_id: z.string().min(1).max(200),
  participant: z.object({
    bsuid: z.string().max(200).nullable(),
    phone_e164: z.string().max(40).nullable(),
    participant_id: z.string().max(200).nullable(),
    display_name: z.string().max(200).nullable(),
    provider_contact_id: z.string().max(200).nullable(),
  }),
  messages: z.array(z.object({
    provider_message_id: z.string().min(1).max(300),
    direction: z.enum(['incoming', 'outgoing']),
    text: z.string().max(10000).nullable(),
    sent_at: z.string().datetime({ offset: true }),
    sent_via: z.string().max(40).nullable().optional(),
    kind: z.enum(['text', 'image', 'audio', 'video', 'file', 'sticker', 'location', 'contacts', 'interactive', 'template', 'order', 'unsupported']).optional(),
  })).max(100),
});

// n8n pages Zernio's GET /v1/inbox/conversations/{id}/messages (max 100 per
// page, opaque cursor) and posts each page here. Stored as historical: never
// routed, never answered.
export const POST = internalRoute(async (req) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: 'Invalid request', issues: parsed.error.issues.slice(0, 5) }, 400);
  return json(await importHistoricalMessages(parsed.data));
});
