import { z } from 'zod';

// All secrets stay on the server. Nothing here is exposed to the browser
// (no NEXT_PUBLIC_ variables are used anywhere in this app).
const schema = z.object({
  DATABASE_URL: z.string().min(1),
  // HMAC secret configured on the Zernio webhook subscription.
  ZERNIO_WEBHOOK_SECRET: z.string().min(16),
  // WooCommerce webhook secret (one per webhook; the same value may be reused).
  WOO_WEBHOOK_SECRET: z.string().min(16).optional(),
  // Base URL of n8n webhooks, e.g. https://n8n.example.com/webhook
  N8N_WEBHOOK_BASE: z.string().url().optional(),
  // Shared secret sent to n8n in X-Internal-Token (n8n Header Auth credential).
  N8N_INTERNAL_TOKEN: z.string().min(24).optional(),
  // Token n8n uses to call backend internal endpoints (history import).
  BACKEND_INTERNAL_TOKEN: z.string().min(24).optional(),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(12),
  COOKIE_SECURE: z.enum(['true', 'false']).default('true'),
  APP_ORIGIN: z.string().url().optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;
export function env(): Env {
  if (!cached) cached = schema.parse(process.env);
  return cached;
}

export function resetEnvForTests() {
  cached = null;
}
