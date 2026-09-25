import { EventEmitter } from 'node:events';
import pg from 'pg';

// One LISTEN connection per server process, fanned out to SSE clients.
// Notifications carry ids only; clients re-fetch through permission-checked
// endpoints, so a notification never leaks message content.
type AppEvent = { type: string; conversation_id?: string | null; [k: string]: unknown };

const bus = new EventEmitter();
bus.setMaxListeners(500);
let client: pg.Client | null = null;
let connecting: Promise<void> | null = null;

async function connect() {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  c.on('notification', (n) => {
    try { bus.emit('event', JSON.parse(n.payload || '{}') as AppEvent); } catch { /* ignore malformed */ }
  });
  c.on('error', () => { client = null; setTimeout(() => ensureListener().catch(() => {}), 2000); });
  c.on('end', () => { client = null; });
  await c.connect();
  await c.query('LISTEN app_events');
  client = c;
}

export async function ensureListener() {
  if (client) return;
  if (!connecting) connecting = connect().finally(() => { connecting = null; });
  await connecting;
}

export function subscribe(fn: (e: AppEvent) => void) {
  bus.on('event', fn);
  return () => bus.off('event', fn);
}
