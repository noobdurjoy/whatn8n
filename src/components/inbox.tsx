'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { containsBangla, fmtTime, langAttr, useApi, useSession } from './session';
import { useAppEvents } from './shell';

type ConvRow = {
  id: string; mode: 'AUTO' | 'COPILOT' | 'HUMAN'; status: string; priority: string; queue_state: string; tags: string[];
  unread_count: number; last_message_at: string; last_message_preview: string | null; customer_name: string | null;
  phone_e164: string | null; preferred_language: string | null; pending_drafts: number; send_problems: number;
  automation_hold_reason: string | null; assigned_name: string | null; first_response_due_at: string | null;
};

const AUTHOR_LABEL: Record<string, string> = {
  customer: 'Customer', ai: 'AI', staff: 'Staff', system: 'System message', external_human: 'Staff (outside dashboard)',
  external_automation: 'Other automation', unknown: 'Unknown sender',
};
const ORIGIN_LABEL: Record<string, string> = {
  human_phone_app: 'WhatsApp Business app', human_zernio_inbox: 'Zernio inbox', meta_business_agent: 'Meta Business Agent',
  zernio_automation: 'Zernio automation', other_api: 'another API integration', unknown: 'unknown origin',
};
const OUTBOUND_STATUS: Record<string, string> = {
  queued: 'Waiting to send', sending: 'Sending…', unknown: 'Send outcome unknown', failed: 'Failed', blocked: 'Cannot be sent',
  canceled: 'Canceled', sent: 'Sent',
};
const REASON_TEXT: Record<string, string> = {
  outside_customer_service_window: 'The 24-hour WhatsApp window is closed. Send an approved template instead.',
  takeover: 'Canceled by takeover', emergency_stop: 'Canceled by the emergency stop', ai_disabled: 'Canceled: AI turned off',
  conversation_changed: 'Canceled: the customer wrote again', mode_version_changed: 'Canceled: mode changed',
  ambiguous_provider_result: 'WhatsApp may or may not have received it. Check the chat before retrying.',
  lease_expired: 'The sender stopped mid-send. Check the chat before retrying.',
  provider_delivery_failed: 'WhatsApp reported the message was not delivered.',
};

export function Inbox() {
  const api = useApi();
  const [rows, setRows] = useState<ConvRow[]>([]);
  const [q, setQ] = useState('');
  const [queue, setQueue] = useState('');
  const [mode, setMode] = useState('');
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [showProfile, setShowProfile] = useState(false);
  const [listErr, setListErr] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const loadList = useCallback(async () => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (queue) p.set('queue', queue);
    if (mode) p.set('mode', mode);
    if (status) p.set('status', status);
    try {
      const r = await api<{ conversations: ConvRow[] }>(`/api/conversations?${p}`);
      setRows(r.conversations);
      setListErr(null);
    } catch (e: any) { setListErr(e.message); }
  }, [api, q, queue, mode, status]);

  useEffect(() => { const t = setTimeout(loadList, q ? 250 : 0); return () => clearTimeout(t); }, [loadList, q]);
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('c');
    if (id) setSelected(id);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) { e.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useAppEvents((e) => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(loadList, 400);
  });

  function select(id: string) {
    setSelected(id);
    const u = new URL(window.location.href);
    u.searchParams.set('c', id);
    window.history.replaceState(null, '', u);
  }

  function onListKey(e: React.KeyboardEvent) {
    if (!['ArrowDown', 'ArrowUp'].includes(e.key) || !rows.length) return;
    e.preventDefault();
    const i = rows.findIndex((r) => r.id === selected);
    const next = e.key === 'ArrowDown' ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1);
    select(rows[next].id);
    (document.getElementById(`conv-${rows[next].id}`) as HTMLElement | null)?.focus();
  }

  return (
    <div className={`inbox ${selected ? 'has-selection' : ''} ${showProfile ? 'show-profile' : ''}`}>
      <section className="pane list-pane" aria-label="Conversations">
        <div className="conv-filters stack">
          <label className="sr-only" htmlFor="conv-search">Search conversations</label>
          <input id="conv-search" ref={searchRef} className="input" placeholder="Search name, number or message (press /)"
            value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="row">
            <select className="input" style={{ flex: 1 }} aria-label="Queue" value={queue} onChange={(e) => setQueue(e.target.value)}>
              <option value="">All open</option>
              <option value="attention">Needs attention</option>
              <option value="waiting">Waiting for staff</option>
              <option value="mine">Assigned to me</option>
              <option value="unassigned">Unassigned</option>
            </select>
            <select className="input" style={{ flex: 1 }} aria-label="Mode" value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="">Any mode</option><option>AUTO</option><option>COPILOT</option><option>HUMAN</option>
            </select>
            <select className="input" style={{ flex: 1 }} aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Open & pending</option><option value="resolved">Resolved</option><option value="closed">Closed</option>
            </select>
          </div>
        </div>
        {listErr && <div className="error-box" role="alert" style={{ margin: 10 }}>{listErr}</div>}
        <div role="list" onKeyDown={onListKey}>
          {rows.length === 0 && !listErr && <p className="muted small" style={{ padding: 12 }}>No conversations match.</p>}
          {rows.map((r) => (
            <button id={`conv-${r.id}`} key={r.id} role="listitem" className="conv-item" aria-current={r.id === selected ? 'true' : undefined}
              onClick={() => select(r.id)}>
              <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
                <span className="name" lang={containsBangla(r.customer_name) ? 'bn' : undefined}>{r.customer_name || r.phone_e164 || 'Unknown customer'}</span>
                <span className="small muted">{fmtTime(r.last_message_at)}</span>
              </div>
              <div className="preview" lang={langAttr(r.preferred_language)}>{r.last_message_preview ?? ''}</div>
              <div className="row small" style={{ marginTop: 4 }}>
                <span className={`pill ${r.mode}`}>{r.mode}</span>
                {r.queue_state === 'waiting_staff' && <span className="pill status-serious">Waiting for staff</span>}
                {r.pending_drafts > 0 && <span className="pill">Draft to review</span>}
                {r.send_problems > 0 && <span className="pill status-critical">⚠ Send problem</span>}
                {r.automation_hold_reason && <span className="pill status-warning">AI paused</span>}
                {r.priority !== 'normal' && <span className="pill">{r.priority}</span>}
                {r.assigned_name && <span className="muted">→ {r.assigned_name}</span>}
                {r.unread_count > 0 && <span className="badge" aria-label={`${r.unread_count} unread`}>{r.unread_count}</span>}
              </div>
            </button>
          ))}
        </div>
      </section>

      <section className="pane thread-pane" aria-label="Conversation" style={{ borderRight: '1px solid var(--border)' }}>
        {selected ? <Conversation key={selected} id={selected} onBack={() => setSelected(null)} onToggleProfile={() => setShowProfile((v) => !v)} />
          : <div style={{ display: 'grid', placeItems: 'center', height: '100%' }} className="muted">Select a conversation</div>}
      </section>

      <aside className="pane profile-pane" aria-label="Customer">
        {selected ? <Profile key={selected} id={selected} onClose={() => setShowProfile(false)} /> : null}
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Conversation thread
// ---------------------------------------------------------------------------
type Detail = any;

function useDetail(id: string) {
  const api = useApi();
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setD(await api(`/api/conversations/${id}`)); setErr(null); } catch (e: any) { setErr(e.message); }
  }, [api, id]);
  useEffect(() => { load(); }, [load]);
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  useAppEvents((e) => {
    if (e.type === 'reconnected' || e.conversation_id === id) {
      if (t.current) clearTimeout(t.current);
      t.current = setTimeout(load, 150);
    }
  });
  return { d, err, load };
}

function Conversation({ id, onBack, onToggleProfile }: { id: string; onBack: () => void; onToggleProfile: () => void }) {
  const { d, err, load } = useDetail(id);
  const { can } = useSession();
  const api = useApi();
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ block: 'end' }); }, [d?.messages?.length]);

  async function act(path: string, body?: unknown) {
    setBusy(true);
    setActionErr(null);
    try { await api(`/api/conversations/${id}/${path}`, { body: body ?? {} }); await load(); }
    catch (e: any) { setActionErr(e.message); }
    finally { setBusy(false); }
  }

  if (err) return <div className="error-box" role="alert" style={{ margin: 12 }}>{err}</div>;
  if (!d) return <div className="muted" style={{ padding: 16 }}>Loading…</div>;
  const c = d.conversation;
  const cu = d.customer;

  // Merge messages, notes and mode changes into one timeline.
  const items: Array<{ at: string; kind: string; v: any }> = [
    ...d.messages.map((m: any) => ({ at: m.sent_at, kind: 'msg', v: m })),
    ...d.notes.map((n: any) => ({ at: n.created_at, kind: 'note', v: n })),
    ...d.mode_changes.map((m: any) => ({ at: m.at, kind: 'mode', v: m })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const pendingOut = d.outbound.filter((o: any) => ['queued', 'sending', 'unknown', 'failed', 'blocked'].includes(o.status)
    || (o.status === 'canceled' && o.in_flight_at_takeover));
  const inflight = d.outbound.filter((o: any) => o.in_flight_at_takeover && ['sending', 'unknown', 'sent'].includes(o.status));

  return (
    <div className="thread">
      <div className="thread-head stack">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="row">
            <button className="btn small back-link" onClick={onBack} aria-label="Back to conversations">←</button>
            <h1 style={{ margin: 0 }} lang={containsBangla(cu?.display_name) ? 'bn' : undefined}>{cu?.display_name || cu?.phone_e164 || 'Customer'}</h1>
            <span className={`pill ${c.mode}`} aria-label={`Mode ${c.mode}`}>{c.mode}</span>
            {c.window_open ? <span className="pill status-good" title="WhatsApp customer-service window">24h window open</span>
              : <span className="pill status-warning" title="Only approved templates can be sent">Window closed · templates only</span>}
          </div>
          <button className="btn small" onClick={onToggleProfile}>Customer details</button>
        </div>
        <ModeBar c={c} busy={busy} onMode={(m) => act('mode', { mode: m })} onTakeOver={() => act('takeover')} canResume={can('resume_ai')}
          canCopilot={can('set_copilot')} canTakeover={can('takeover')} />
        {c.automation_hold_reason && (
          <div className="notice small row" role="status">
            <span>AI replies are paused here: {c.automation_hold_reason === 'unknown_outgoing_origin'
              ? 'a message was sent from somewhere we could not identify.' : c.automation_hold_reason === 'meta_business_agent'
              ? 'Meta Business Agent is answering this conversation.' : 'another automation sent a message.'}</span>
            {can('clear_hold') && <button className="btn small" disabled={busy} onClick={() => act('clear-hold', { note: 'reviewed' })}>Reviewed — allow AI again</button>}
          </div>
        )}
        {c.provider_control_owner === 'ai_agent' && <div className="notice small">Meta Business Agent currently controls this thread. Sending a staff reply takes control back.</div>}
        {inflight.length > 0 && (
          <div className="notice small" role="status">
            {inflight.length} AI message{inflight.length > 1 ? 's were' : ' was'} already being handed to WhatsApp when this conversation was taken over.
            It may still reach the customer; WhatsApp does not support recalling it.
          </div>
        )}
        {actionErr && <div className="error-box" role="alert">{actionErr}</div>}
      </div>

      <div className="timeline" aria-live="polite" aria-relevant="additions">
        {items.map((it) => it.kind === 'msg' ? <MessageBubble key={`m-${it.v.id}`} m={it.v} convId={id} />
          : it.kind === 'note' ? <div key={`n-${it.v.id}`} className="note"><strong>Internal note · {it.v.author}:</strong> {it.v.body}</div>
          : <div key={`c-${it.v.at}`} className="event-line">
              Mode {it.v.from_mode ?? '—'} → {it.v.to_mode} · {humanReason(it.v.reason)} · {it.v.actor_name ?? it.v.actor_type} · {fmtTime(it.v.at)}
            </div>)}
        {pendingOut.map((o: any) => <OutboundState key={o.id} o={o} onChanged={load} />)}
        <div ref={bottomRef} />
      </div>

      <div className="composer stack">
        <Drafts drafts={d.drafts.filter((x: any) => x.status === 'pending_review')} onChanged={load} />
        <Composer conv={c} onSent={load} />
      </div>
    </div>
  );
}

function humanReason(r: string) {
  const map: Record<string, string> = {
    customer_requested_human: 'customer asked for a person', staff_take_over: 'staff took over', staff_reply: 'staff replied',
    external_human_reply: 'a person replied outside the dashboard', staff_set_auto: 'AI resumed', staff_set_copilot: 'set to Copilot',
  };
  if (r?.startsWith('ai_handoff:')) return `AI handed off (${r.split(':')[1].replace(/_/g, ' ')})`;
  return map[r] ?? r?.replace(/_/g, ' ');
}

function ModeBar({ c, busy, onMode, onTakeOver, canResume, canCopilot, canTakeover }: {
  c: any; busy: boolean; onMode: (m: string) => void; onTakeOver: () => void; canResume: boolean; canCopilot: boolean; canTakeover: boolean;
}) {
  const [confirmAuto, setConfirmAuto] = useState(false);
  return (
    <div className="row" role="group" aria-label="Conversation mode">
      <fieldset className="row" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="sr-only">Mode</legend>
        {(['AUTO', 'COPILOT', 'HUMAN'] as const).map((m) => {
          const allowed = m === 'AUTO' ? canResume : m === 'COPILOT' ? canCopilot : canTakeover;
          return (
            <label key={m} className={`btn small ${c.mode === m ? 'primary' : ''}`} style={{ opacity: allowed || c.mode === m ? 1 : 0.5 }}
              title={m === 'AUTO' ? 'AI replies automatically after all checks' : m === 'COPILOT' ? 'AI drafts; staff approve' : 'Staff only; no AI replies'}>
              <input type="radio" name={`mode-${c.id}`} className="sr-only" checked={c.mode === m} disabled={busy || !allowed}
                onChange={() => (m === 'AUTO' ? setConfirmAuto(true) : onMode(m))} />
              {m}
            </label>
          );
        })}
      </fieldset>
      {c.mode !== 'HUMAN' && canTakeover && <button className="btn small danger" disabled={busy} onClick={onTakeOver}>Take over</button>}
      {c.mode === 'HUMAN' && canResume && <button className="btn small" disabled={busy} onClick={() => setConfirmAuto(true)}>Resume AI</button>}
      {confirmAuto && (
        <span className="row small notice" role="alertdialog" aria-label="Confirm resume AI">
          AI will answer new customer messages automatically. Nothing canceled earlier is re-sent.
          <button className="btn small primary" onClick={() => { setConfirmAuto(false); onMode('AUTO'); }}>Resume AI</button>
          <button className="btn small" onClick={() => setConfirmAuto(false)}>Cancel</button>
        </span>
      )}
    </div>
  );
}

function MessageBubble({ m, convId }: { m: any; convId: string }) {
  const api = useApi();
  const { can } = useSession();
  const [fb, setFb] = useState<string | null>(null);
  const cls = m.direction === 'inbound' ? 'inbound' : `outbound ${m.author_type}`;
  let who = m.direction === 'inbound' ? 'Customer' : AUTHOR_LABEL[m.author_type] ?? m.author_type;
  if (m.author_type === 'staff' && m.author_name) who = `Staff · ${m.author_name}`;
  if (['external_human', 'external_automation', 'unknown'].includes(m.author_type) && m.origin) who += ` · via ${ORIGIN_LABEL[m.origin] ?? m.origin}`;
  const bn = containsBangla(m.body);
  return (
    <div className={`msg ${cls}`} lang={bn ? 'bn' : undefined}>
      <div className="who">{who}{m.is_historical && ' · imported history'}</div>
      {m.deleted_by_sender_at ? <em className="muted">Deleted by sender. </em> : null}
      {m.body}
      {m.kind === 'unsupported' && !m.body && <em className="muted">Unsupported message type</em>}
      {m.attachments?.map((a: any) => <Attachment key={a.id} a={a} />)}
      <div className="meta">
        <span>{fmtTime(m.sent_at)}</span>
        {m.edited_at && <span>edited</span>}
        {m.direction === 'outbound' && m.delivery_status && (
          <span className={m.delivery_status === 'failed' ? 'status-critical' : undefined}>
            {m.delivery_status === 'read' ? '✓✓ read' : m.delivery_status === 'delivered' ? '✓✓ delivered' : m.delivery_status === 'failed' ? '✗ not delivered' : '✓ sent'}
          </span>
        )}
        {m.delivery_error && <span className="status-critical">{m.delivery_error.explanation || m.delivery_error.title || m.delivery_error.message}</span>}
        {m.reactions?.filter((r: any) => r.action === 'added').map((r: any, i: number) => <span key={i}>{r.emoji}</span>)}
        {m.author_type === 'ai' && can('reply') && !fb && (
          <>
            <button className="btn small" onClick={async () => { await api(`/api/conversations/${convId}/feedback`, { body: { message_id: m.id, label: 'ai_good' } }); setFb('👍 noted'); }} aria-label="Mark AI reply as good">👍</button>
            <button className="btn small" onClick={async () => { await api(`/api/conversations/${convId}/feedback`, { body: { message_id: m.id, label: 'ai_wrong' } }); setFb('👎 noted'); }} aria-label="Mark AI reply as wrong">👎</button>
          </>
        )}
        {fb && <span>{fb}</span>}
      </div>
    </div>
  );
}

function Attachment({ a }: { a: any }) {
  const url = `/api/attachments/${a.id}`;
  const status: Record<string, string> = {
    pending: 'Downloading…', expired: 'Media expired before it could be saved', failed: 'Could not download',
    too_large: 'Too large to store', rejected_type: 'File type not allowed', not_applicable: '',
  };
  const an = a.analysis;
  return (
    <div style={{ marginTop: 6 }}>
      {a.fetch_status === 'stored' && a.mime_type?.startsWith('image/') && (
        <a href={url} target="_blank" rel="noreferrer"><img className="attach" src={url} alt={`Image from customer${a.file_name ? `: ${a.file_name}` : ''}`} loading="lazy" /></a>
      )}
      {a.fetch_status === 'stored' && a.mime_type?.startsWith('audio/') && <audio controls src={url} preload="none" />}
      {a.fetch_status === 'stored' && !a.mime_type?.startsWith('image/') && !a.mime_type?.startsWith('audio/') && (
        <a className="btn small" href={url}>Download {a.file_name || a.media_type}</a>
      )}
      {a.fetch_status !== 'stored' && <div className="small muted">[{a.media_type}] {status[a.fetch_status] ?? a.fetch_status}</div>}
      {an && (
        <details className="small" style={{ marginTop: 4 }}>
          <summary>Image analysis: {an.status === 'ok' ? 'done' : an.status} · {an.model}</summary>
          {an.status === 'ok' ? (
            <div className="stack" style={{ marginTop: 4 }}>
              <div><strong>Type:</strong> {an.result?.image_type}</div>
              {an.result?.visible_details?.length > 0 && <div><strong>Visible:</strong> {an.result.visible_details.join('; ')}</div>}
              {an.result?.extracted_text?.length > 0 && <div lang="bn"><strong>Text:</strong> {an.result.extracted_text.map((t: any) => t.text).join(' | ')}</div>}
              {an.result?.references?.length > 0 && <div><strong>References:</strong> {an.result.references.map((r: any) => `${r.kind}: ${r.value}`).join(', ')}</div>}
              {an.result?.uncertainties?.length > 0 && <div><strong>Uncertain:</strong> {an.result.uncertainties.join('; ')}</div>}
              {an.result?.image_type === 'payment_receipt' && <div className="status-warning">A receipt is only a reference to check. It is not proof of payment.</div>}
            </div>
          ) : <div className="status-critical">{an.error ?? 'Analysis failed'}</div>}
        </details>
      )}
    </div>
  );
}

function OutboundState({ o, onChanged }: { o: any; onChanged: () => void }) {
  const api = useApi();
  const { can } = useSession();
  const [err, setErr] = useState<string | null>(null);
  const [pmid, setPmid] = useState('');
  async function resolve(resolution: string) {
    setErr(null);
    try {
      await api(`/api/outbound/${o.id}/resolve`, { body: { resolution, provider_message_id: pmid || undefined } });
      onChanged();
    } catch (e: any) { setErr(e.message); }
  }
  const tone = ['unknown', 'failed', 'blocked'].includes(o.status) ? 'status-critical' : 'muted';
  return (
    <div className={`msg outbound ${o.actor_type === 'ai' ? 'ai' : o.actor_type}`} style={{ opacity: o.status === 'canceled' ? 0.7 : 1 }}>
      <div className="who">{o.actor_type === 'ai' ? 'AI' : o.kind === 'handoff_ack' ? 'Handoff message' : 'Staff'} · <span className={tone}>{OUTBOUND_STATUS[o.status]}</span></div>
      {o.body}
      <div className="meta">
        {o.status_reason && <span className={tone}>{REASON_TEXT[o.status_reason] ?? o.status_reason.replace(/_/g, ' ')}</span>}
        {o.in_flight_at_takeover && <span className="status-warning">was in flight at takeover</span>}
        {o.attempts > 1 && <span>{o.attempts} attempts</span>}
      </div>
      {['unknown', 'failed'].includes(o.status) && can('reconcile_send') && (
        <div className="stack small" style={{ marginTop: 6 }}>
          <span>Check the WhatsApp chat first. Retrying reuses the same idempotency key.</span>
          <div className="row">
            <input className="input" style={{ width: 200 }} placeholder="WhatsApp message id (optional)" value={pmid} onChange={(e) => setPmid(e.target.value)} />
            <button className="btn small" onClick={() => resolve('mark_sent')}>It was delivered</button>
            <button className="btn small" onClick={() => resolve('retry_same_key')}>Retry</button>
            <button className="btn small danger" onClick={() => resolve('discard')}>Discard</button>
          </div>
          {err && <div className="error-box" role="alert">{err}</div>}
        </div>
      )}
    </div>
  );
}

function Drafts({ drafts, onChanged }: { drafts: any[]; onChanged: () => void }) {
  const api = useApi();
  const { can } = useSession();
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  if (!drafts.length) return null;
  async function approve(d: any, force = false) {
    setErr(null);
    try {
      await api(`/api/drafts/${d.id}/approve`, { body: { final_text: edit[d.id] ?? d.body, force_stale: force } });
      onChanged();
    } catch (e: any) {
      if (e.data?.reason === 'stale_draft') setErr('The customer wrote again after this draft was made. Review it, then use "Send anyway" if it still fits.');
      else setErr(e.message);
    }
  }
  return (
    <div className="stack">
      {drafts.map((d) => (
        <div key={d.id} className="draft stack" aria-label="AI draft for review">
          <div className="row small" style={{ justifyContent: 'space-between' }}>
            <strong>AI draft {d.decision === 'handoff' ? '(suggests a handoff)' : ''}</strong>
            {d.stale && <span className="status-warning">⚠ The conversation changed after this draft</span>}
          </div>
          <label className="sr-only" htmlFor={`draft-${d.id}`}>Edit draft</label>
          <textarea id={`draft-${d.id}`} className="input" rows={3} lang={containsBangla(d.body) ? 'bn' : undefined}
            value={edit[d.id] ?? d.body} onChange={(e) => setEdit({ ...edit, [d.id]: e.target.value })} disabled={!can('approve_draft')} />
          {can('approve_draft') && (
            <div className="row">
              <button className="btn small primary" onClick={() => approve(d)}>{(edit[d.id] ?? d.body) !== d.body ? 'Send edited' : 'Approve & send'}</button>
              {d.stale && <button className="btn small" onClick={() => approve(d, true)}>Send anyway</button>}
              <button className="btn small" onClick={async () => { await api(`/api/drafts/${d.id}/reject`, { body: {} }); onChanged(); }}>Reject</button>
            </div>
          )}
        </div>
      ))}
      {err && <div className="error-box" role="alert">{err}</div>}
    </div>
  );
}

function Composer({ conv, onSent }: { conv: any; onSent: () => void }) {
  const api = useApi();
  const { can } = useSession();
  const [text, setText] = useState('');
  const [asNote, setAsNote] = useState(false);
  const [canned, setCanned] = useState<any[]>([]);
  const [upload, setUpload] = useState<{ upload_id: string; file_name: string } | null>(null);
  const [tpl, setTpl] = useState({ name: '', language: 'en_US' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { api<{ canned: any[] }>('/api/canned').then((r) => setCanned(r.canned)).catch(() => {}); }, [api]);

  async function send() {
    if (busy) return;
    setBusy(true); setErr(null); setInfo(null);
    try {
      if (asNote) {
        await api(`/api/conversations/${conv.id}/notes`, { body: { body: text } });
      } else {
        const body: any = { client_request_id: crypto.randomUUID() };
        if (text.trim()) body.text = text;
        if (upload) body.upload_id = upload.upload_id;
        if (!conv.window_open && tpl.name) body.template = { name: tpl.name, language: tpl.language };
        const r = await api(`/api/conversations/${conv.id}/reply`, { body });
        if (r.takeover) setInfo('You took over this conversation; AI replies stopped.');
      }
      setText(''); setUpload(null);
      onSent();
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function attach(f: File) {
    setErr(null);
    const form = new FormData();
    form.set('file', f);
    form.set('conversation_id', conv.id);
    try { setUpload(await api('/api/uploads', { form })); } catch (e: any) { setErr(e.message); }
  }

  async function assist() {
    setErr(null); setInfo(null);
    try { await api(`/api/conversations/${conv.id}/assist`, { body: { include_images: true } }); setInfo('Asked the AI for a suggestion; it will appear as a draft.'); }
    catch (e: any) { setErr(e.message); }
  }

  const windowClosed = !conv.window_open;
  return (
    <div className="stack">
      {windowClosed && !asNote && (
        <div className="notice small stack">
          <span>The 24-hour window is closed. WhatsApp only allows an approved template now.</span>
          <div className="row">
            <input className="input" style={{ width: 200 }} placeholder="Template name" value={tpl.name} onChange={(e) => setTpl({ ...tpl, name: e.target.value.trim() })} aria-label="Template name" />
            <input className="input" style={{ width: 100 }} placeholder="en_US" value={tpl.language} onChange={(e) => setTpl({ ...tpl, language: e.target.value.trim() })} aria-label="Template language" />
          </div>
        </div>
      )}
      <label className="sr-only" htmlFor="composer">{asNote ? 'Internal note' : 'Reply'}</label>
      <textarea id="composer" className="input" rows={3} value={text} lang={containsBangla(text) ? 'bn' : undefined}
        placeholder={asNote ? 'Internal note (only staff can see this)' : windowClosed ? 'Template parameters are set in WhatsApp Manager' : 'Type a reply… (Ctrl+Enter to send)'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } }}
        style={asNote ? { borderColor: 'var(--warning)' } : undefined} />
      <div className="row">
        <button className="btn primary" onClick={send} disabled={busy || (!text.trim() && !upload && !(windowClosed && tpl.name))}>
          {asNote ? 'Add note' : conv.mode === 'AUTO' ? 'Take over & send' : 'Send'}
        </button>
        <label className="row small"><input type="checkbox" checked={asNote} onChange={(e) => setAsNote(e.target.checked)} /> Internal note</label>
        {!asNote && (
          <>
            <input ref={fileRef} type="file" hidden accept="image/jpeg,image/png,image/webp,application/pdf,video/mp4,audio/mpeg,audio/ogg"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) attach(f); e.target.value = ''; }} />
            <button className="btn small" onClick={() => fileRef.current?.click()}>Attach</button>
            {upload && <span className="pill">{upload.file_name} <button className="btn small" aria-label="Remove attachment" onClick={() => setUpload(null)}>×</button></span>}
            {canned.length > 0 && (
              <select className="input" style={{ width: 180 }} aria-label="Insert canned reply" value="" onChange={(e) => {
                const c = canned.find((x) => x.id === e.target.value); if (c) setText((t) => (t ? `${t}\n` : '') + c.body);
              }}>
                <option value="">Canned replies…</option>
                {canned.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
              </select>
            )}
            {can('request_ai_assist') && <button className="btn small" onClick={assist}>Ask AI for a draft</button>}
          </>
        )}
      </div>
      {info && <div className="small status-good" role="status">{info}</div>}
      {err && <div className="error-box" role="alert">{err}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Customer profile
// ---------------------------------------------------------------------------
function Profile({ id, onClose }: { id: string; onClose: () => void }) {
  const { d, load } = useDetail(id);
  const api = useApi();
  const { can, me } = useSession();
  const [staff, setStaff] = useState<any[]>([]);
  const [tagText, setTagText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api<{ staff: any[] }>('/api/staff').then((r) => setStaff(r.staff.filter((s) => s.active))).catch(() => {}); }, [api]);
  useEffect(() => { if (d) setTagText((d.conversation.tags ?? []).join(', ')); }, [d]);
  const opsPending = useMemo(() => (d?.order_operations ?? []).filter((o: any) => ['awaiting_staff_approval', 'approved', 'unknown'].includes(o.status)), [d]);
  if (!d) return null;
  const c = d.conversation;
  const cu = d.customer;

  async function run(fn: () => Promise<unknown>) {
    setErr(null);
    try { await fn(); await load(); } catch (e: any) { setErr(e.message); }
  }

  return (
    <div className="profile">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Customer</h2>
        <button className="btn small" onClick={onClose} aria-label="Close customer details">Close</button>
      </div>
      <dl className="kv">
        <dt>Name</dt><dd lang={containsBangla(cu.display_name) ? 'bn' : undefined}>{cu.display_name ?? '—'}</dd>
        <dt>WhatsApp</dt><dd>{cu.phone_e164 ?? 'hidden (username user)'}</dd>
        <dt>Language</dt><dd>{cu.preferred_language ?? '—'}</dd>
        <dt>Marketing</dt><dd>{cu.marketing_consent.replace('_', ' ')}</dd>
        <dt>Account link</dt><dd>{cu.account_linked ? 'Verified' : 'Not linked'}</dd>
        <dt>Account</dt><dd>{c.account_name ?? '—'} {c.account_enabled ? '' : '(replies disabled)'}</dd>
      </dl>

      <section className="stack">
        <h3>Assignment & status</h3>
        <select className="input" aria-label="Assigned to" value={c.assigned_to ?? ''} disabled={!can('assign_self')}
          onChange={(e) => run(() => api(`/api/conversations/${id}/assign`, { body: { staff_id: e.target.value || null } }))}>
          <option value="">Unassigned</option>
          {staff.filter((s) => can('assign_any') || s.id === me.id || s.id === c.assigned_to).map((s) => <option key={s.id} value={s.id}>{s.display_name}</option>)}
        </select>
        <div className="row">
          <select className="input" style={{ flex: 1 }} aria-label="Status" value={c.status} disabled={!can('tickets')}
            onChange={(e) => run(() => api(`/api/conversations/${id}/status`, { body: { status: e.target.value } }))}>
            <option value="open">Open</option><option value="pending">Pending</option><option value="resolved">Resolved</option><option value="closed">Closed</option>
          </select>
          <select className="input" style={{ flex: 1 }} aria-label="Priority" value={c.priority} disabled={!can('tag')}
            onChange={(e) => run(() => api(`/api/conversations/${id}/tags`, { body: { tags: c.tags, priority: e.target.value } }))}>
            <option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option>
          </select>
        </div>
        <div className="row">
          <input className="input" style={{ flex: 1 }} aria-label="Tags (comma separated)" value={tagText} onChange={(e) => setTagText(e.target.value)} disabled={!can('tag')} />
          <button className="btn small" disabled={!can('tag')} onClick={() => run(() => api(`/api/conversations/${id}/tags`, {
            body: { tags: tagText.split(',').map((t) => t.trim()).filter(Boolean) } }))}>Save tags</button>
        </div>
      </section>

      {d.summary && (
        <section className="stack small">
          <h3>Summary</h3>
          <p style={{ margin: 0 }}>{d.summary.summary}</p>
          {d.summary.open_issues?.length > 0 && <div><strong>Open:</strong> {d.summary.open_issues.join('; ')}</div>}
        </section>
      )}

      <section className="stack small">
        <h3>Remembered preferences</h3>
        {d.memories.length === 0 && <span className="muted">None stored.</span>}
        {d.memories.map((m: any) => (
          <div key={m.id} className="row" style={{ justifyContent: 'space-between' }}>
            <span><strong>{m.key.replace(/_/g, ' ')}:</strong> {m.value} <span className="muted">({m.confirmed_by})</span></span>
            {can('reply') && <button className="btn small" aria-label={`Delete ${m.key}`} onClick={() => run(() => api(`/api/customers/${cu.id}/memories/${m.id}`, { method: 'DELETE' }))}>Delete</button>}
          </div>
        ))}
      </section>

      {can('view_orders') && (
        <section className="stack small">
          <h3>Orders (verified for this customer)</h3>
          {d.orders.length === 0 && <span className="muted">No verified orders.</span>}
          {d.orders.map((o: any) => (
            <div key={o.woo_order_id}>#{o.woo_order_id} · {o.status ?? 'status not synced'}{o.total_minor != null ? ` · ${(o.total_minor / 100).toFixed(2)} ${o.currency}` : ''}{o.date_paid ? ' · paid (WooCommerce)' : ''}</div>
          ))}
          {opsPending.length > 0 && <h3>Order requests</h3>}
          {opsPending.map((o: any) => (
            <div key={o.id} className="card stack">
              <div><strong>{o.op_type.replace(/_/g, ' ')}</strong>{o.woo_order_id ? ` · #${o.woo_order_id}` : ''}</div>
              <pre className="code">{JSON.stringify({ details: o.payload, quote: o.quote }, null, 1)}</pre>
              {o.op_type === 'create_order' && !o.customer_confirmed_at && <span className="status-warning">Customer has not confirmed yet.</span>}
              {can('order_approve') && o.status === 'awaiting_staff_approval' && (
                <div className="row">
                  <button className="btn small primary" onClick={() => run(() => api(`/api/order-ops/${o.id}`, { body: { approve: true } }))}>Approve</button>
                  <button className="btn small" onClick={() => run(() => api(`/api/order-ops/${o.id}`, { body: { approve: false } }))}>Reject</button>
                </div>
              )}
              {o.status !== 'awaiting_staff_approval' && (
                <span className="small">{o.status === 'unknown' ? 'Outcome unknown: check the order in WooCommerce.' : 'Approved: make the change in WooCommerce, then record the result.'}</span>
              )}
              {can('order_approve') && o.status !== 'awaiting_staff_approval' && (
                <div className="row">
                  <button className="btn small primary" onClick={() => run(() => api(`/api/order-ops/${o.id}`, { body: { outcome: 'succeeded' } }))}>Done in WooCommerce</button>
                  <button className="btn small" onClick={() => run(() => api(`/api/order-ops/${o.id}`, { body: { outcome: 'failed' } }))}>Could not do it</button>
                </div>
              )}
            </div>
          ))}
        </section>
      )}

      <section className="stack small">
        <h3>Recent AI activity</h3>
        {d.ai_jobs.length === 0 && <span className="muted">None.</span>}
        {d.ai_jobs.map((j: any) => (
          <div key={j.id}>{fmtTime(j.started_at)} · {j.kind} · {j.status}{j.discard_reason ? ` (${j.discard_reason.replace(/_/g, ' ')})` : ''}</div>
        ))}
      </section>

      <section className="stack small">
        <h3>Customer data</h3>
        <div className="row">
          {can('export_customer') && <a className="btn small" href={`/api/customers/${cu.id}/export`}>Export data</a>}
          {can('delete_customer') && <DeleteCustomer customerId={cu.id} />}
        </div>
      </section>
      {err && <div className="error-box" role="alert">{err}</div>}
    </div>
  );
}

function DeleteCustomer({ customerId }: { customerId: string }) {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  if (!open) return <button className="btn small danger" onClick={() => setOpen(true)}>Delete customer data…</button>;
  return (
    <div className="card stack">
      <span>This permanently deletes this customer's conversations, messages, attachments, summaries, preferences and links. Type DELETE to confirm.</span>
      <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Type DELETE to confirm" />
      <div className="row">
        <button className="btn small danger solid" disabled={typed !== 'DELETE'} onClick={async () => {
          try { await api(`/api/customers/${customerId}`, { method: 'DELETE', body: { confirm: 'DELETE' } }); window.location.href = '/'; }
          catch (e: any) { setMsg(e.message); }
        }}>Delete permanently</button>
        <button className="btn small" onClick={() => setOpen(false)}>Cancel</button>
      </div>
      {msg && <div className="error-box" role="alert">{msg}</div>}
    </div>
  );
}
