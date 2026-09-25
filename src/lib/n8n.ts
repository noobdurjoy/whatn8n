// Backend → n8n notifications. Each call is small (ids only) and
// authenticated with X-Internal-Token (an n8n Header Auth credential on the
// receiving Webhook node). All of them are safe to repeat: the database
// functions refuse duplicate or stale work.

type Hook = 'wa-router' | 'wa-dispatch' | 'wa-ai-job' | 'wa-woo-event';

export async function callN8n(hook: Hook, payload: Record<string, unknown>, timeoutMs = 3000): Promise<boolean> {
  const base = process.env.N8N_WEBHOOK_BASE;
  const token = process.env.N8N_INTERNAL_TOKEN;
  if (!base || !token) return false;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${base.replace(/\/$/, '')}/${hook}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-token': token },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

export const n8n = {
  route: (eventId: string, route: unknown) => callN8n('wa-router', { event_id: eventId, route }),
  dispatch: (outboundId: string) => callN8n('wa-dispatch', { outbound_id: outboundId }),
  aiJob: (jobId: string, extra: Record<string, unknown> = {}) => callN8n('wa-ai-job', { job_id: jobId, ...extra }),
  wooEvent: (eventId: string) => callN8n('wa-woo-event', { event_id: eventId }),
};
