'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

export type Me = { id: string; email: string; display_name: string; role: 'owner' | 'admin' | 'agent'; csrf_token: string; capabilities: string[] };

const SessionCtx = createContext<{ me: Me; can: (c: string) => boolean } | null>(null);

export function SessionProvider({ me, children }: { me: Me; children: React.ReactNode }) {
  const can = useCallback((c: string) => me.capabilities.includes(c), [me]);
  return <SessionCtx.Provider value={{ me, can }}>{children}</SessionCtx.Provider>;
}

export function useSession() {
  const v = useContext(SessionCtx);
  if (!v) throw new Error('SessionProvider missing');
  return v;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public data: any) { super(message); }
}

// Every mutation carries the CSRF token; the cookie is SameSite=Strict too.
export function useApi() {
  const { me } = useSession();
  return useCallback(async <T = any>(path: string, init: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> => {
    const method = init.method ?? (init.body !== undefined || init.form ? 'POST' : 'GET');
    const headers: Record<string, string> = {};
    if (method !== 'GET') headers['x-csrf-token'] = me.csrf_token;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(path, {
      method, headers, credentials: 'same-origin', cache: 'no-store',
      body: init.form ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
    });
    if (r.status === 401) { window.location.href = '/login'; throw new ApiError(401, 'Signed out', null); }
    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('application/json') ? await r.json() : await r.text();
    if (!r.ok) throw new ApiError(r.status, (data && data.error) || `Request failed (${r.status})`, data);
    return data as T;
  }, [me.csrf_token]);
}

// Authenticated realtime stream. Calls onEvent for every server event;
// reconnects with backoff. Events carry ids only.
export function useEvents(onEvent: (e: { type: string; conversation_id?: string; [k: string]: unknown }) => void) {
  const ref = useRef(onEvent);
  ref.current = onEvent;
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let es: EventSource | null = null;
    let delay = 1000;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const open = () => {
      es = new EventSource('/api/events');
      es.addEventListener('ready', () => { setConnected(true); delay = 1000; ref.current({ type: 'reconnected' }); });
      es.addEventListener('app', (m) => { try { ref.current(JSON.parse((m as MessageEvent).data)); } catch { /* ignore */ } });
      es.addEventListener('logout', () => { window.location.href = '/login'; });
      es.onerror = () => {
        setConnected(false);
        es?.close();
        if (!stop) { timer = setTimeout(open, delay); delay = Math.min(delay * 2, 30000); }
      };
    };
    open();
    return () => { stop = true; es?.close(); if (timer) clearTimeout(timer); };
  }, []);
  return connected;
}

export function fmtTime(iso: string | null | undefined) {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function langAttr(lang: string | null | undefined) {
  return lang === 'bn' ? 'bn' : lang === 'banglish' ? 'bn-Latn' : undefined;
}

export function containsBangla(s: string | null | undefined) {
  return !!s && /[ঀ-৿]/.test(s);
}
