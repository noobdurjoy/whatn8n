'use client';

import { useCallback, useEffect, useState } from 'react';
import { containsBangla, fmtTime, useApi, useSession } from '@/components/session';

const CATEGORY_LABELS: Record<string, string> = {
  new_conversation: 'New conversations', customer_message: 'Customer messages', ai_reply: 'AI replies sent', ai_draft: 'AI draft replies (not sent)', staff_reply: 'Staff replies sent',
  delivery_failure: 'Delivery failures', handoff: 'Handoffs to a person', unresolved: 'Unresolved conversations', orders: 'Orders and payments',
  stock: 'Stock changes', knowledge: 'Knowledge changes', notice_expiring: 'Temporary notices about to expire', api_failure: 'API failures',
  connection: 'Connection problems', spending: 'AI spending limit', deployment: 'Deployment status', backup: 'Backups',
  admin_reply_status: 'Status of my replies sent from Telegram',
};

// Settings → Telegram: pairing, authorized accounts, notification categories,
// temporary notices and private staff notes, recent bot commands.
export function TelegramAdmin() {
  const api = useApi();
  const { me, can } = useSession();
  const [data, setData] = useState<any>(null);
  const [settings, setSettings] = useState<any>(null);
  const [notices, setNotices] = useState<any>(null);
  const [code, setCode] = useState<{ code: string; expires_at: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [manual, setManual] = useState({ staff_id: '', telegram_user_id: '' });
  const [staff, setStaff] = useState<any[]>([]);

  const load = useCallback(async () => {
    const [a, s, n, st] = await Promise.all([
      api('/api/telegram/admins'), api('/api/settings'),
      can('knowledge_review') ? api('/api/telegram/notices') : Promise.resolve(null), api<{ staff: any[] }>('/api/staff'),
    ]);
    setData(a);
    const row = s.settings.find((x: any) => x.key === 'telegram_notifications');
    setSettings(row ? { value: row.value, version: row.version } : null);
    setNotices(n);
    setStaff(st.staff.filter((x: any) => x.active && (x.role === 'owner' || x.role === 'admin')));
  }, [api, can]);
  useEffect(() => { load().catch((e) => setErr(e.message)); }, [load]);

  async function run(fn: () => Promise<unknown>, done?: string) {
    setErr(null); setOk(null);
    try { await fn(); if (done) setOk(done); await load(); } catch (e: any) { setErr(e.message); }
  }

  if (!data) return <span>Loading…</span>;
  const active = data.admins.filter((a: any) => !a.revoked_at);
  const cats = settings?.value?.categories ?? {};

  return (
    <div className="stack">
      <section className="card stack" aria-labelledby="tg-pair">
        <h2 id="tg-pair">Telegram admin bot</h2>
        <p className="small muted">A private bot used only by this project (credential <code>IDS Telegram Admin</code> in n8n). Commands are accepted only from the paired account’s numeric Telegram user id in its private chat — never by username. Other people get “This is a private bot.” and their messages are not stored or sent to any AI.</p>
        {me.role === 'owner' && (
          <div className="stack">
            <button className="btn primary" style={{ alignSelf: 'flex-start' }} onClick={() => run(async () => setCode(await api('/api/telegram/pairing-code', { body: {} })))}>Create pairing code</button>
            {code && (
              <div className="card stack" role="status">
                <div>Send this to the bot in a private chat within 10 minutes (until {fmtTime(code.expires_at)}). It works once and is not shown again:</div>
                <code style={{ fontSize: 20, letterSpacing: 2 }}>/pair {code.code}</code>
              </div>
            )}
            {!code && data.pending_code_expires_at && <div className="small muted">An unused code is valid until {fmtTime(data.pending_code_expires_at)}. Creating a new one ends it.</div>}
          </div>
        )}
        <table className="data"><thead><tr><th>Staff</th><th>Telegram user id</th><th>Paired</th><th>Status</th>{can('manage_staff') && <th></th>}</tr></thead>
          <tbody>{data.admins.map((a: any) => (
            <tr key={a.id}><td>{a.display_name} <span className="pill">{a.role}</span></td><td><code>{a.telegram_user_id}</code></td>
              <td>{fmtTime(a.created_at)} · {a.paired_via === 'pairing_code' ? 'pairing code' : 'set by owner'}</td>
              <td>{a.revoked_at ? `Revoked ${fmtTime(a.revoked_at)}` : 'Active'}</td>
              {can('manage_staff') && <td>{!a.revoked_at && <button className="btn small" onClick={() => run(() => api(`/api/telegram/admins/${a.id}`, { method: 'DELETE' }), 'Access revoked.')}>Revoke</button>}</td>}
            </tr>))}
            {!data.admins.length && <tr><td colSpan={5} className="muted">Not paired yet.</td></tr>}
          </tbody>
        </table>
        {can('manage_staff') && (
          <details>
            <summary className="small">Authorize an owner/admin by numeric Telegram user id instead</summary>
            <div className="stack" style={{ marginTop: 8 }}>
              <p className="small muted">Get the numeric id from Telegram (for example with @userinfobot). The bot then accepts commands only in that account’s private chat.</p>
              <select className="input" value={manual.staff_id} onChange={(e) => setManual({ ...manual, staff_id: e.target.value })} aria-label="Staff member">
                <option value="">Staff member…</option>{staff.map((s) => <option key={s.id} value={s.id}>{s.display_name} ({s.role})</option>)}
              </select>
              <input className="input" inputMode="numeric" placeholder="Numeric Telegram user id" value={manual.telegram_user_id} onChange={(e) => setManual({ ...manual, telegram_user_id: e.target.value.trim() })} />
              <button className="btn small" style={{ alignSelf: 'flex-start' }} disabled={!manual.staff_id || !/^\d{5,16}$/.test(manual.telegram_user_id)}
                onClick={() => run(() => api('/api/telegram/admins', { body: manual }), 'Authorized.')}>Authorize</button>
            </div>
          </details>
        )}
        {active.length > 1 && <div className="small muted">{active.length} accounts can command the bot.</div>}
      </section>

      {settings && (
        <section className="card stack" aria-labelledby="tg-notify">
          <h2 id="tg-notify">Telegram notifications</h2>
          <p className="small muted">Sent only to paired accounts. “Immediately” sends within a minute; “Daily summary” collects them for 21:00 (Asia/Dhaka); “Off” records nothing. Repeats are merged and at most {settings.value.max_per_minute} messages go per minute. A failed Telegram message never repeats the customer action behind it.</p>
          <label className="row small"><input type="checkbox" checked={settings.value.enabled} disabled={!can('settings')}
            onChange={(e) => setSettings({ ...settings, value: { ...settings.value, enabled: e.target.checked }, dirty: true })} />Notifications on</label>
          <table className="data"><tbody>{Object.keys(CATEGORY_LABELS).map((k) => (
            <tr key={k}><td>{CATEGORY_LABELS[k]}</td><td>
              <select className="input" value={cats[k] ?? 'summary'} disabled={!can('settings')} aria-label={CATEGORY_LABELS[k]}
                onChange={(e) => setSettings({ ...settings, value: { ...settings.value, categories: { ...cats, [k]: e.target.value } }, dirty: true })}>
                <option value="immediate">Immediately</option><option value="summary">Daily summary</option><option value="disabled">Off</option>
              </select></td></tr>))}</tbody></table>
          {settings.dirty && <button className="btn small primary" style={{ alignSelf: 'flex-start' }}
            onClick={() => run(() => api('/api/settings', { method: 'PUT', body: { key: 'telegram_notifications', value: { enabled: settings.value.enabled, max_per_minute: settings.value.max_per_minute, categories: settings.value.categories }, expected_version: settings.version } }), 'Saved.')}>Save</button>}
        </section>
      )}

      {notices && (
        <section className="card stack" aria-labelledby="tg-notices">
          <h2 id="tg-notices">Temporary notices</h2>
          <p className="small muted">Short-lived information the AI may tell customers (for example a delivery delay). They add to approved policies but never override live prices, stock, payment status, security rules or permissions. Expired notices are ignored automatically.</p>
          <table className="data"><thead><tr><th>Notice</th><th>Version</th><th>Valid</th><th>Status</th><th></th></tr></thead>
            <tbody>{notices.notices.map((n: any) => (
              <tr key={n.id}><td lang={containsBangla(n.body) ? 'bn' : undefined}><strong>{n.title}</strong><div className="small">{n.body}</div>
                {n.scope?.type === 'keywords' && <div className="small muted">When customers mention: {(n.scope.keywords ?? []).join(', ')}</div>}</td>
                <td>v{n.version} · {n.created_via} · {n.created_by}</td>
                <td className="small">{fmtTime(n.starts_at)} → {fmtTime(n.expires_at)}</td>
                <td>{n.live ? 'Live' : n.status === 'active' ? (new Date(n.expires_at) <= new Date() ? 'Expired' : 'Scheduled') : n.status}</td>
                <td className="row">{n.status === 'active' && new Date(n.expires_at) > new Date() && <button className="btn small" onClick={() => run(() => api(`/api/telegram/notices/${n.id}`, { body: { action: 'cancel' } }), 'Notice ended.')}>End now</button>}
                  {n.status !== 'active' && new Date(n.expires_at) > new Date() && <button className="btn small" onClick={() => run(() => api(`/api/telegram/notices/${n.id}`, { body: { action: 'restore' } }), 'Version restored.')}>Restore this version</button>}</td>
              </tr>))}
              {!notices.notices.length && <tr><td colSpan={5} className="muted">None yet. Send the bot e.g. “Temporary: Netflix delivery is delayed until tomorrow 6pm.”</td></tr>}
            </tbody>
          </table>
          <h2>Private staff notes</h2>
          <p className="small muted">Internal only: never shown to customers and never given to the AI.</p>
          {notices.notes.map((n: any) => <div key={n.id} className="card small" lang={containsBangla(n.body) ? 'bn' : undefined}>{n.body}<div className="muted">{fmtTime(n.created_at)} · {n.created_by} · {n.created_via}</div></div>)}
          {!notices.notes.length && <div className="small muted">No notes.</div>}
        </section>
      )}

      <details className="card">
        <summary>Recent bot commands and stock changes</summary>
        <table className="data"><thead><tr><th>When</th><th>Command</th><th>Status</th><th>Understood by</th><th>By</th></tr></thead>
          <tbody>{data.commands.map((c: any) => <tr key={c.id}><td>{fmtTime(c.created_at)}</td><td>{c.type}</td><td>{c.status}</td><td>{c.parsed_by}</td><td>{c.display_name}</td></tr>)}</tbody></table>
        <table className="data"><thead><tr><th>When</th><th>Item</th><th>Change</th><th>Before → after</th><th>Status</th></tr></thead>
          <tbody>{data.stock.map((s: any) => (
            <tr key={s.id}><td>{fmtTime(s.created_at)}</td><td>{s.name} {s.sku ? `(${s.sku})` : ''} #{s.product_id}{Number(s.variation_id) ? `/${s.variation_id}` : ''}</td><td>{s.op}</td>
              <td className="small">{JSON.stringify(s.previous)} → {s.result ? JSON.stringify(s.result) : '—'}</td><td>{s.status}</td></tr>))}</tbody></table>
      </details>
      {ok && <div className="small status-good" role="status">{ok}</div>}
      {err && <div className="error-box" role="alert">{err}</div>}
    </div>
  );
}
