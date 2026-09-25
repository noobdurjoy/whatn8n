'use client';

import { useCallback, useEffect, useState } from 'react';
import { containsBangla, fmtTime, useApi, useSession } from '@/components/session';

const LABELS: Record<string, string> = {
  shop_name: 'Shop name', shop_base_url: 'Shop website (WooCommerce)', dashboard_url: 'Dashboard address (used in staff alerts)', default_mode: 'Mode for new conversations', agents_can_resume_ai: 'Support agents may resume AI',
  agents_see_assigned_only: 'Agents see only their own + unassigned chats', per_conversation_sends_per_minute: 'Max sends per chat per minute',
  marketing_max_per_week: 'Max marketing messages per customer per week', burst_debounce_seconds: 'Wait for message bursts (seconds)',
  ai_daily_budget_usd: 'AI spending limit (USD, rolling 24h)', models: 'AI models', vision: 'Image understanding', attachments: 'Attachments',
  handoff_ack: 'Handoff acknowledgment (fixed text)', escalation_rules: 'Escalation rules', business_hours: 'Business hours',
  response_time_targets: 'Response-time targets', notifications: 'Notifications', order_ops: 'Order operations', retention: 'Data retention',
  followups: 'Follow-ups and reminders',
};

export default function SettingsPage() {
  const { can } = useSession();
  const [tab, setTab] = useState(can('settings') ? 'settings' : 'prompts');
  const tabs = [
    ...(can('settings') ? [['settings', 'Settings']] : []),
    ...(can('prompts') ? [['prompts', 'Prompts & test area']] : []),
    ...(can('canned_manage') ? [['canned', 'Canned replies']] : []),
    ['staff', 'Staff'],
  ];
  return (
    <div className="page"><div className="page-narrow stack">
      <h1>Settings</h1>
      <div className="row" role="tablist" aria-label="Settings sections">
        {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`btn small ${tab === k ? 'primary' : ''}`} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === 'settings' && <SettingsEditor />}
      {tab === 'prompts' && <Prompts />}
      {tab === 'canned' && <Canned />}
      {tab === 'staff' && <Staff />}
    </div></div>
  );
}

function SettingsEditor() {
  const api = useApi();
  const { me } = useSession();
  const [data, setData] = useState<any>(null);
  const [draft, setDraft] = useState<Record<string, any>>({});
  const [msg, setMsg] = useState<Record<string, { ok: boolean; text: string }>>({});
  const load = useCallback(async () => { setData(await api('/api/settings')); }, [api]);
  useEffect(() => { load(); }, [load]);
  if (!data) return <span>Loading…</span>;
  const byKey = Object.fromEntries(data.settings.map((s: any) => [s.key, s]));

  async function save(key: string) {
    setMsg((m) => ({ ...m, [key]: { ok: true, text: 'Saving…' } }));
    try {
      await api('/api/settings', { method: 'PUT', body: { key, value: draft[key], expected_version: byKey[key]?.version } });
      setMsg((m) => ({ ...m, [key]: { ok: true, text: 'Saved.' } }));
      setDraft(({ [key]: _, ...rest }) => rest);
      load();
    } catch (e: any) {
      const checks = e.data?.checks?.filter((c: any) => !c.ok).map((c: any) => `${c.model}: ${c.error ?? Object.entries(c.meets).filter(([, v]) => !v).map(([k]) => `missing ${k}`).join(', ')}`);
      setMsg((m) => ({ ...m, [key]: { ok: false, text: checks?.length ? `Model check failed — ${checks.join('; ')}` : e.message } }));
    }
  }

  return (
    <div className="stack">
      <p className="small muted">The global AI switch and the emergency stop are in the top bar. Model changes are checked against OpenRouter (availability, image input, tool and JSON support) before they are saved.</p>
      {data.editable.map((key: string) => {
        const locked = data.owner_only.includes(key) && me.role !== 'owner';
        const value = key in draft ? draft[key] : byKey[key]?.value;
        if (value === undefined) return null;
        return (
          <section key={key} className="card stack" aria-labelledby={`s-${key}`}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h2 id={`s-${key}`}>{LABELS[key] ?? key}</h2>
              <span className="small muted">v{byKey[key]?.version} · {fmtTime(byKey[key]?.updated_at)}{locked ? ' · owner only' : ''}</span>
            </div>
            <Field value={value} disabled={locked} path={key} onChange={(v) => setDraft((d) => ({ ...d, [key]: v }))} />
            {key in draft && (
              <div className="row">
                <button className="btn small primary" onClick={() => save(key)}>Save</button>
                <button className="btn small" onClick={() => setDraft(({ [key]: _, ...rest }) => rest)}>Discard</button>
              </div>
            )}
            {msg[key] && <div className={msg[key].ok ? 'small status-good' : 'error-box'} role="status">{msg[key].text}</div>}
          </section>
        );
      })}
      <details className="card">
        <summary>Change history</summary>
        <table className="data"><thead><tr><th>When</th><th>Setting</th><th>Version</th><th>By</th></tr></thead>
          <tbody>{data.history.map((h: any, i: number) => <tr key={i}><td>{fmtTime(h.changed_at)}</td><td>{h.key}</td><td>{h.version}</td><td>{h.changed_by ?? '—'}</td></tr>)}</tbody>
        </table>
      </details>
    </div>
  );
}

// Generic editor for JSON settings: objects → fieldsets, booleans → checkboxes,
// numbers → number inputs, string arrays → comma lists, strings → text.
function Field({ value, onChange, disabled, path }: { value: any; onChange: (v: any) => void; disabled: boolean; path: string }) {
  const label = path.split('.').pop()!.replace(/_/g, ' ');
  if (value === null) return <label className="stack small">{label}<input className="input" disabled={disabled} placeholder="not set" onChange={(e) => onChange(e.target.value || null)} /></label>;
  if (typeof value === 'boolean') return <label className="row small"><input type="checkbox" checked={value} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />{label}</label>;
  if (typeof value === 'number') return <label className="stack small">{label}<input className="input" type="number" step="any" value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} /></label>;
  if (typeof value === 'string') {
    const long = value.length > 60 || containsBangla(value);
    return <label className="stack small">{label}{long
      ? <textarea className="input" rows={2} value={value} disabled={disabled} lang={containsBangla(value) ? 'bn' : undefined} onChange={(e) => onChange(e.target.value)} />
      : <input className="input" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />}</label>;
  }
  if (Array.isArray(value)) {
    if (value.every((x) => typeof x === 'string')) {
      return <label className="stack small">{label} (comma separated)<input className="input" value={value.join(', ')} disabled={disabled}
        onChange={(e) => onChange(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} /></label>;
    }
    return <pre className="code">{JSON.stringify(value)}</pre>;
  }
  return (
    <fieldset className="stack" style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
      {path.includes('.') && <legend className="small">{label}</legend>}
      {Object.entries(value).map(([k, v]) => (
        <Field key={k} value={v} disabled={disabled} path={`${path}.${k}`} onChange={(nv) => onChange({ ...value, [k]: nv })} />
      ))}
    </fieldset>
  );
}

function Prompts() {
  const api = useApi();
  const [versions, setVersions] = useState<any[]>([]);
  const [name, setName] = useState('customer_system');
  const [editor, setEditor] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => { setVersions((await api<{ versions: any[] }>('/api/prompts')).versions); }, [api]);
  useEffect(() => { load(); }, [load]);
  const list = versions.filter((v) => v.name === name);
  const published = list.find((v) => v.status === 'published');

  async function run(fn: () => Promise<unknown>) {
    setErr(null);
    try { await fn(); await load(); } catch (e: any) { setErr(e.message); }
  }

  return (
    <div className="stack">
      <div className="row">
        <select className="input" style={{ width: 240 }} value={name} onChange={(e) => setName(e.target.value)} aria-label="Prompt">
          <option value="customer_system">Customer assistant</option><option value="vision_system">Image analysis</option>
          <option value="summary_system">Conversation summary</option><option value="learning_system">Daily learning</option>
        </select>
        <button className="btn small" onClick={() => setEditor(published?.body ?? '')}>New version from published</button>
      </div>
      {editor !== null && (
        <section className="card stack">
          <h2>New draft version</h2>
          <textarea className="input" rows={16} value={editor} onChange={(e) => setEditor(e.target.value)} aria-label="Prompt text" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13 }} />
          <input className="input" placeholder="What changed (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="row">
            <button className="btn primary" onClick={() => run(async () => { await api('/api/prompts', { body: { name, body: editor, note: note || undefined } }); setEditor(null); setNote(''); })}>Save as draft</button>
            <button className="btn" onClick={() => setEditor(null)}>Cancel</button>
          </div>
        </section>
      )}
      {err && <div className="error-box" role="alert">{err}</div>}
      <table className="data">
        <thead><tr><th>Version</th><th>Status</th><th>Tested</th><th>Created</th><th>Note</th><th></th></tr></thead>
        <tbody>
          {list.map((v) => (
            <tr key={v.id}>
              <td>v{v.version_no}</td><td>{v.status}</td><td>{v.tested_at ? fmtTime(v.tested_at) : '—'}</td>
              <td>{fmtTime(v.created_at)} {v.created_by_name ? `· ${v.created_by_name}` : ''}</td><td>{v.note}</td>
              <td className="row">
                {v.status !== 'published' && <button className="btn small" disabled={!v.tested_at || v.tested_at < v.created_at}
                  title={!v.tested_at ? 'Test this version first' : ''} onClick={() => run(() => api(`/api/prompts/${v.id}/publish`, { body: {} }))}>
                  {v.status === 'archived' ? 'Roll back to this' : 'Publish'}</button>}
                <details><summary className="small">View</summary><pre className="code">{v.body}</pre></details>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {name === 'customer_system' && <TestArea versions={list} />}
    </div>
  );
}

function TestArea({ versions }: { versions: any[] }) {
  const api = useApi();
  const [message, setMessage] = useState('bhai netflix er dam koto?');
  const [versionId, setVersionId] = useState('');
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setBusy(true); setErr(null); setResult(null);
    try {
      const { job_id } = await api('/api/sandbox', { body: { message, prompt_version_id: versionId || undefined } });
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const r = await api(`/api/sandbox?job_id=${job_id}`);
        if (r.job.status !== 'running') { setResult(r); break; }
      }
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <section className="card stack" aria-labelledby="test-area">
      <h2 id="test-area">Test area</h2>
      <p className="small muted">Runs the real reply workflow against a sandbox conversation that can never send to WhatsApp. A successful run marks the chosen version as tested, which is required before publishing it.</p>
      <select className="input" value={versionId} onChange={(e) => setVersionId(e.target.value)} aria-label="Prompt version to test">
        <option value="">Published version</option>
        {versions.filter((v) => v.status !== 'published').map((v) => <option key={v.id} value={v.id}>v{v.version_no} ({v.status})</option>)}
      </select>
      <textarea className="input" rows={2} value={message} onChange={(e) => setMessage(e.target.value)} aria-label="Test customer message" lang={containsBangla(message) ? 'bn' : undefined} />
      <button className="btn primary" style={{ alignSelf: 'flex-start' }} onClick={run} disabled={busy}>{busy ? 'Running…' : 'Run test'}</button>
      {err && <div className="error-box" role="alert">{err}</div>}
      {result && (
        <div className="stack small">
          <div><strong>Status:</strong> {result.job.status}{result.job.discard_reason ? ` (${result.job.discard_reason})` : ''} · decision: {result.job.decision ?? '—'}</div>
          {result.draft && <div className="msg outbound ai" lang={containsBangla(result.draft.body) ? 'bn' : undefined}>{result.draft.body}</div>}
          {result.job.result?.validation_errors && <div className="error-box">Validation: {result.job.result.validation_errors.join(', ')}</div>}
          <table className="data"><thead><tr><th>Call</th><th>Model</th><th>Latency</th><th>Tokens (in/out/reasoning)</th><th>Cost</th></tr></thead>
            <tbody>{result.usage.map((u: any, i: number) => (
              <tr key={i}><td>{u.purpose}</td><td>{u.model}</td><td>{u.latency_ms ?? '—'} ms</td>
                <td>{u.usage_available ? `${u.prompt_tokens}/${u.completion_tokens}/${u.reasoning_tokens ?? '—'}` : 'unavailable'}</td>
                <td>{u.cost_usd != null ? `$${Number(u.cost_usd).toFixed(5)}` : 'unavailable'}</td></tr>))}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Canned() {
  const api = useApi();
  const [items, setItems] = useState<any[]>([]);
  const [v, setV] = useState({ title: '', body: '', language: 'bn' });
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => { setItems((await api<{ canned: any[] }>('/api/canned')).canned); }, [api]);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="stack">
      <section className="card stack">
        <h2>New canned reply</h2>
        <input className="input" placeholder="Title" value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} />
        <textarea className="input" rows={3} placeholder="Text" value={v.body} onChange={(e) => setV({ ...v, body: e.target.value })} lang={containsBangla(v.body) ? 'bn' : undefined} />
        <select className="input" value={v.language} onChange={(e) => setV({ ...v, language: e.target.value })}><option value="bn">Bangla</option><option value="en">English</option><option value="banglish">Banglish</option></select>
        <button className="btn primary" style={{ alignSelf: 'flex-start' }} onClick={async () => {
          setErr(null); try { await api('/api/canned', { body: v }); setV({ title: '', body: '', language: v.language }); load(); } catch (e: any) { setErr(e.message); }
        }}>Add</button>
        {err && <div className="error-box">{err}</div>}
      </section>
      {items.map((c) => (
        <div key={c.id} className="card row" style={{ justifyContent: 'space-between' }}>
          <div><strong>{c.title}</strong> <span className="pill">{c.language}</span><div className="small" lang={containsBangla(c.body) ? 'bn' : undefined}>{c.body}</div></div>
          <button className="btn small" onClick={async () => { await api(`/api/canned/${c.id}`, { method: 'DELETE' }); load(); }}>Remove</button>
        </div>
      ))}
    </div>
  );
}

function Staff() {
  const api = useApi();
  const { can } = useSession();
  const [staff, setStaff] = useState<any[]>([]);
  const [v, setV] = useState({ email: '', display_name: '', role: 'agent', password: '' });
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => { setStaff((await api<{ staff: any[] }>('/api/staff')).staff); }, [api]);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="stack">
      <table className="data"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Last sign-in</th>{can('manage_staff') && <th></th>}</tr></thead>
        <tbody>{staff.map((s) => (
          <tr key={s.id}><td>{s.display_name}</td><td>{s.email}</td>
            <td>{can('manage_staff') ? <select className="input" value={s.role} onChange={async (e) => { try { await api(`/api/staff/${s.id}`, { method: 'PATCH', body: { role: e.target.value } }); load(); } catch (x: any) { setErr(x.message); } }}>
              <option value="owner">Owner</option><option value="admin">Admin</option><option value="agent">Support agent</option></select> : s.role}</td>
            <td>{s.active ? 'Active' : 'Disabled'}</td><td>{fmtTime(s.last_login_at)}</td>
            {can('manage_staff') && <td><button className="btn small" onClick={async () => { try { await api(`/api/staff/${s.id}`, { method: 'PATCH', body: { active: !s.active } }); load(); } catch (x: any) { setErr(x.message); } }}>{s.active ? 'Disable' : 'Enable'}</button></td>}
          </tr>))}</tbody>
      </table>
      {can('manage_staff') && (
        <section className="card stack">
          <h2>Add staff member</h2>
          <input className="input" placeholder="Name" value={v.display_name} onChange={(e) => setV({ ...v, display_name: e.target.value })} />
          <input className="input" type="email" placeholder="Email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} />
          <select className="input" value={v.role} onChange={(e) => setV({ ...v, role: e.target.value })}><option value="agent">Support agent</option><option value="admin">Admin</option><option value="owner">Owner</option></select>
          <input className="input" type="password" placeholder="Temporary password (12+ characters)" autoComplete="new-password" value={v.password} onChange={(e) => setV({ ...v, password: e.target.value })} />
          <button className="btn primary" style={{ alignSelf: 'flex-start' }} onClick={async () => { setErr(null); try { await api('/api/staff', { body: v }); setV({ email: '', display_name: '', role: 'agent', password: '' }); load(); } catch (e: any) { setErr(e.message); } }}>Add</button>
        </section>
      )}
      {err && <div className="error-box" role="alert">{err}</div>}
    </div>
  );
}
