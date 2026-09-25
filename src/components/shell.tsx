'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useApi, useEvents, useSession } from './session';

type AppEvent = { type: string; conversation_id?: string; [k: string]: unknown };
const EventsCtx = createContext<{ subscribe: (fn: (e: AppEvent) => void) => () => void; connected: boolean } | null>(null);

// One authenticated SSE connection per tab, shared by every page.
export function useAppEvents(fn: (e: AppEvent) => void) {
  const ctx = useContext(EventsCtx);
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => ctx?.subscribe((e) => ref.current(e)), [ctx]);
  return ctx?.connected ?? false;
}

type Controls = { ai_enabled: boolean; sending_enabled: boolean; in_flight: number; queued: number };

export function Shell({ children }: { children: React.ReactNode }) {
  const listeners = useRef(new Set<(e: AppEvent) => void>());
  const connected = useEvents((e) => listeners.current.forEach((l) => l(e)));
  const subscribe = useCallback((fn: (e: AppEvent) => void) => {
    listeners.current.add(fn);
    return () => { listeners.current.delete(fn); };
  }, []);
  return (
    <EventsCtx.Provider value={{ subscribe, connected }}>
      <ShellInner connected={connected}>{children}</ShellInner>
    </EventsCtx.Provider>
  );
}

function ShellInner({ children, connected }: { children: React.ReactNode; connected: boolean }) {
  const { me, can } = useSession();
  const api = useApi();
  const path = usePathname();
  const [controls, setControls] = useState<Controls | null>(null);
  const [alerts, setAlerts] = useState<number>(0);
  const [confirm, setConfirm] = useState<null | { kind: 'ai' | 'send'; next: boolean }>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setControls(await api<Controls>('/api/controls'));
      setAlerts((await api<{ alerts: unknown[] }>('/api/alerts')).alerts.length);
    } catch { /* shown elsewhere */ }
  }, [api]);
  useEffect(() => { load(); }, [load]);
  useAppEvents((e) => { if (['global_controls', 'alert', 'reconnected'].includes(e.type)) load(); });

  async function apply() {
    if (!confirm) return;
    setErr(null);
    try {
      await api('/api/controls', { body: confirm.kind === 'ai' ? { ai_enabled: confirm.next } : { sending_enabled: confirm.next } });
      setConfirm(null);
      load();
    } catch (e: any) { setErr(e.message); }
  }

  const nav = [
    { href: '/', label: 'Inbox' },
    { href: '/knowledge', label: 'Knowledge' },
    ...(can('view_metrics') ? [{ href: '/operations', label: 'Operations' }] : []),
    ...(can('settings') || can('prompts') ? [{ href: '/settings', label: 'Settings' }] : []),
  ];

  return (
    <div className="shell">
      <div>
        {controls && !controls.sending_enabled && (
          <div className="banner-stop" role="alert">All outgoing messages are stopped. Incoming messages are still being saved.</div>
        )}
        <header className="topbar">
          <strong>WhatsApp Support</strong>
          <nav aria-label="Main">
            {nav.map((n) => (
              <Link key={n.href} href={n.href} aria-current={(n.href === '/' ? path === '/' : path.startsWith(n.href)) ? 'page' : undefined}>{n.label}</Link>
            ))}
          </nav>
          <span className="spacer" />
          <div className="global-controls">
            <span className={`small ${connected ? 'status-good' : 'status-warning'}`} title="Live updates">
              {connected ? '● Live' : '○ Reconnecting…'}
            </span>
            {alerts > 0 && <Link className="pill" href="/operations" title="Open alerts">⚠ {alerts} alert{alerts > 1 ? 's' : ''}</Link>}
            {controls && (
              <>
                <span className="pill" aria-live="polite">AI replies: <strong>{controls.ai_enabled ? 'On' : 'Off'}</strong></span>
                {can('global_ai') && (
                  <button className="btn small" onClick={() => setConfirm({ kind: 'ai', next: !controls.ai_enabled })}>
                    {controls.ai_enabled ? 'Turn AI off' : 'Turn AI on'}
                  </button>
                )}
                {can('emergency_stop') && (
                  controls.sending_enabled
                    ? <button className="btn small danger solid" onClick={() => setConfirm({ kind: 'send', next: false })}>Stop all outgoing</button>
                    : <button className="btn small" onClick={() => setConfirm({ kind: 'send', next: true })}>Resume sending</button>
                )}
              </>
            )}
            <span className="small muted">{me.display_name} · {me.role}</span>
            <button className="btn small" onClick={async () => { await fetch('/api/auth/logout', { method: 'POST' }); window.location.href = '/login'; }}>Sign out</button>
          </div>
        </header>
      </div>
      <div style={{ minHeight: 0 }}>{children}</div>

      {confirm && (
        <div role="dialog" aria-modal="true" aria-labelledby="confirm-title" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', display: 'grid', placeItems: 'center', zIndex: 20, padding: 16 }}
          onKeyDown={(e) => { if (e.key === 'Escape') setConfirm(null); }}>
          <div className="card stack" style={{ width: 'min(460px, 100%)' }}>
            <h2 id="confirm-title">
              {confirm.kind === 'ai' ? (confirm.next ? 'Turn AI replies on?' : 'Turn AI replies off?')
                : confirm.next ? 'Resume outgoing messages?' : 'Stop ALL outgoing messages?'}
            </h2>
            <p className="small">
              {confirm.kind === 'ai' && !confirm.next && 'Queued AI replies are canceled and no new AI replies are generated. Staff can still reply.'}
              {confirm.kind === 'ai' && confirm.next && 'AI replies resume only in conversations set to AUTO (COPILOT still needs approval). Canceled replies are not re-sent.'}
              {confirm.kind === 'send' && !confirm.next && `Every queued message (AI, staff, scheduled) is canceled and nothing is sent until you resume. ${controls?.in_flight ?? 0} message(s) already handed to WhatsApp cannot be recalled.`}
              {confirm.kind === 'send' && confirm.next && 'Sending resumes for new messages only. Messages canceled by the stop stay canceled.'}
            </p>
            {err && <div className="error-box" role="alert">{err}</div>}
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setConfirm(null)} autoFocus>Cancel</button>
              <button className={`btn ${confirm.kind === 'send' && !confirm.next ? 'danger solid' : 'primary'}`} onClick={apply}>Confirm</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

}
