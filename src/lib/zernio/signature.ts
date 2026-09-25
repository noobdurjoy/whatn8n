import { createHmac, timingSafeEqual } from 'node:crypto';

// Zernio signs the exact raw request body: lowercase hex HMAC-SHA256 keyed by
// the subscription secret, in X-Zernio-Signature (legacy X-Late-Signature).
// Source: Zernio OpenAPI spec (Webhooks section) and the official
// @zernio chat-sdk-adapter webhook.ts. Never re-serialize the body first.
export function verifyZernioSignature(rawBody: Buffer | string, signatureHeader: string | null, secret: string): boolean {
  if (!signatureHeader || !secret) return false;
  const sig = signatureHeader.trim().toLowerCase().replace(/^sha256=/, '');
  if (!/^[0-9a-f]{64}$/.test(sig)) return false;
  const computed = createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(sig, 'hex');
  return given.length === computed.length && timingSafeEqual(given, computed);
}

// WooCommerce signs the raw body with base64 HMAC-SHA256 in
// X-WC-Webhook-Signature, keyed by the webhook's secret.
export function verifyWooSignature(rawBody: Buffer | string, signatureHeader: string | null, secret: string): boolean {
  if (!signatureHeader || !secret) return false;
  const computed = createHmac('sha256', secret).update(rawBody).digest();
  let given: Buffer;
  try {
    given = Buffer.from(signatureHeader.trim(), 'base64');
  } catch {
    return false;
  }
  return given.length === computed.length && timingSafeEqual(given, computed);
}

// Headers worth keeping with a stored event (never secrets or signatures).
export function sanitizeHeaders(h: Headers): Record<string, string> {
  const keep = ['x-zernio-event', 'x-zernio-event-id', 'x-late-event', 'x-late-event-id', 'content-type', 'user-agent',
    'x-wc-webhook-topic', 'x-wc-webhook-resource', 'x-wc-webhook-event', 'x-wc-webhook-id', 'x-wc-webhook-delivery-id',
    'x-wc-webhook-source'];
  const out: Record<string, string> = {};
  for (const k of keep) {
    const v = h.get(k);
    if (v) out[k] = v.slice(0, 300);
  }
  return out;
}
