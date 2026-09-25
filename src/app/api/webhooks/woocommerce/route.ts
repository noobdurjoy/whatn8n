import { after, type NextRequest } from 'next/server';
import { persistWebhookEvent } from '@/lib/ingest';
import { n8n } from '@/lib/n8n';
import { getPool } from '@/lib/db';
import { sanitizeHeaders, verifyWooSignature } from '@/lib/zernio/signature';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// WooCommerce product/order webhooks. Verified on the raw body, persisted,
// acknowledged, then handed to n8n workflow F (sync) by event id.
export async function POST(req: NextRequest) {
  const raw = Buffer.from(await req.arrayBuffer());
  if (raw.length > 2 * 1024 * 1024) return new Response('payload too large', { status: 413 });

  const topic = req.headers.get('x-wc-webhook-topic');
  // WooCommerce sends an unsigned "webhook_id=N" ping when a webhook is saved.
  if (!topic && /^webhook_id=\d+$/.test(raw.toString('utf8').trim())) return new Response('ok');

  const secret = process.env.WOO_WEBHOOK_SECRET || '';
  if (!verifyWooSignature(raw, req.headers.get('x-wc-webhook-signature'), secret)) {
    return new Response('invalid signature', { status: 401 });
  }
  let payload: any;
  try { payload = JSON.parse(raw.toString('utf8')); } catch { return new Response('invalid json', { status: 400 }); }

  const deliveryId = req.headers.get('x-wc-webhook-delivery-id')
    ?? `${topic}:${payload?.id}:${payload?.date_modified_gmt ?? payload?.date_modified ?? ''}`;
  try {
    const stored = await persistWebhookEvent({
      source: 'woocommerce', providerEventId: deliveryId, eventType: topic ?? 'unknown', signatureValid: true,
      headers: sanitizeHeaders(req.headers), payload,
    });
    if (!stored.duplicate) {
      after(async () => {
        const ok = await n8n.wooEvent(stored.id);
        await getPool().query(
          `UPDATE app.webhook_events SET routed_at = CASE WHEN $2 THEN now() ELSE NULL END, route_attempts = route_attempts + 1,
                  processing_status = 'processed', processed_at = now(), route = jsonb_build_object('action', 'woo_sync')
            WHERE id = $1`, [stored.id, ok]).catch(() => {});
      });
    }
  } catch (err) {
    console.error('[woo webhook] persist failed', (err as Error)?.message);
    return new Response('storage unavailable', { status: 503 });
  }
  return new Response('ok');
}
