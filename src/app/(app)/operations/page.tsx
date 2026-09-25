'use client';

import { useCallback, useEffect, useState } from 'react';
import { fmtTime, useApi, useSession } from '@/components/session';
import { useAppEvents } from '@/components/shell';

// Headline numbers are stat tiles, not charts: each shows one value with its
// definition underneath (definitions: docs/METRICS.md).
function Tile({ label, value, def, tone }: { label: string; value: string; def: string; tone?: string }) {
  return (
    <div className="card tile">
      <div className="label">{label}</div>
      <div className={`value ${tone ?? ''}`}>{value}</div>
      <div className="def">{def}</div>
    </div>
  );
}

const fmtSec = (s: number | null | undefined) => (s == null ? '—' : s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);

export default function OperationsPage() {
  const api = useApi();
  const { can } = useSession();
  const [days, setDays] = useState(7);
  const [m, setM] = useState<any>(null);
  const [health, setHealth] = useState<any>(null);
  const [alerts, setAlerts] = useState<any[]>([]);
  const [ops, setOps] = useState<any[]>([]);
  const [audit, setAudit] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [mm, hh, aa, oo] = await Promise.all([
        api(`/api/metrics?days=${days}`), api('/api/health'), api('/api/alerts'), api('/api/order-ops'),
      ]);
      setM(mm); setHealth(hh); setAlerts(aa.alerts); setOps(oo.operations);
      if (can('view_audit')) setAudit((await api('/api/audit')).entries);
    } catch (e: any) { setErr(e.message); }
  }, [api, days, can]);
  useEffect(() => { load(); }, [load]);
  useAppEvents((e) => { if (['alert', 'global_controls', 'order_operation'].includes(e.type)) load(); });

  const x = m?.metrics;
  const b = health?.backlog;
  return (
    <div className="page"><div className="page-narrow stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>Operations</h1>
        <label className="row small">Period
          <select className="input" style={{ width: 120 }} value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={1}>24 hours</option><option value={7}>7 days</option><option value={30}>30 days</option>
          </select>
        </label>
      </div>
      {err && <div className="error-box" role="alert">{err}</div>}

      <section className="stack" aria-labelledby="alerts-h">
        <h2 id="alerts-h">Open alerts ({alerts.length})</h2>
        {alerts.length === 0 && <span className="small status-good">✓ No open alerts</span>}
        {alerts.map((a) => (
          <div key={a.id} className="card row" style={{ justifyContent: 'space-between' }}>
            <div>
              <span className={`status-${a.severity === 'critical' ? 'critical' : a.severity === 'warning' ? 'warning' : 'good'}`}>
                {a.severity === 'critical' ? '⛔' : a.severity === 'warning' ? '⚠' : 'ℹ'} {a.severity}
              </span>{' '}
              {a.message} <span className="small muted">· {fmtTime(a.created_at)}</span>
              {a.details?.conversation_id && <> · <a href={`/?c=${a.details.conversation_id}`}>open conversation</a></>}
            </div>
            {can('reconcile_send') && <button className="btn small" onClick={async () => { await api(`/api/alerts/${a.id}`, { body: {} }); load(); }}>Mark resolved</button>}
          </div>
        ))}
      </section>

      {x && (
        <section className="stack" aria-labelledby="metrics-h">
          <h2 id="metrics-h">Metrics</h2>
          <div className="tiles">
            <Tile label="First response (median)" value={fmtSec(x.first_response_seconds_median)} def="Time from a customer's first message in a burst to the next AI or staff reply." />
            <Tile label="First response (90th pct.)" value={fmtSec(x.first_response_seconds_p90)} def="9 out of 10 bursts were answered within this time." />
            <Tile label="Unanswered bursts" value={String(x.unanswered_customer_bursts ?? 0)} def="Customer message bursts in the period with no reply yet." tone={x.unanswered_customer_bursts ? 'status-warning' : ''} />
            <Tile label="Unresolved conversations" value={String(x.unresolved_conversations ?? 0)} def="Open or pending right now." />
            <Tile label="Waiting for staff" value={String(x.waiting_for_staff ?? 0)} def="Handed off and not yet assigned." tone={x.waiting_for_staff ? 'status-serious' : ''} />
            <Tile label="Handoffs" value={String(Object.values(x.handoffs ?? {}).reduce((a: number, n: any) => a + Number(n), 0))}
              def={Object.entries(x.handoffs ?? {}).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join(' · ') || 'Switches to HUMAN mode.'} />
            <Tile label="Messages sent" value={String(Object.values(x.messages_sent ?? {}).reduce((a: number, n: any) => a + Number(n), 0))}
              def={Object.entries(x.messages_sent ?? {}).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join(' · ') || 'Outgoing messages by author.'} />
            <Tile label="Drafts" value={String(Object.values(x.drafts ?? {}).reduce((a: number, n: any) => a + Number(n), 0))}
              def={Object.entries(x.drafts ?? {}).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join(' · ') || 'AI drafts created in COPILOT.'} />
            <Tile label="Customer feedback" value={x.customer_feedback_avg != null ? `${Number(x.customer_feedback_avg).toFixed(1)} / 5` : '—'} def="Average rating from customer reactions (👍 = 5, 👎 = 1) on our replies." />
            <Tile label="AI cost" value={x.ai_cost_usd != null ? `$${Number(x.ai_cost_usd).toFixed(4)}` : '—'}
              def={`${x.ai_calls ?? 0} model calls${x.ai_calls_usage_unavailable ? `; ${x.ai_calls_usage_unavailable} without usage data (not counted)` : ''}.`} />
            <Tile label="Orders created in chat" value={String(x.orders_created_in_chat ?? 0)} def="Order operations of type 'create order' that succeeded." />
            <Tile label="Chat-assisted paid orders" value={String(x.orders_chat_assisted_paid ?? 0)} def="Paid orders linked to a customer who wrote to us within 72 h before payment." />
          </div>
        </section>
      )}

      {health && (
        <section className="stack" aria-labelledby="health-h">
          <h2 id="health-h">Connection health</h2>
          <div className="tiles">
            <Tile label="Last Zernio event" value={b?.last_zernio_event ? fmtTime(b.last_zernio_event) : 'never'} def="Most recent webhook received." />
            <Tile label="Events waiting" value={String(b?.events_pending ?? 0)} def={`${b?.events_dead ?? 0} dead-lettered, ${b?.events_unrouted ?? 0} not yet handed to n8n.`} tone={b?.events_dead ? 'status-critical' : ''} />
            <Tile label="Stuck sends" value={String(b?.sends_stuck ?? 0)} def="Queued more than 2 minutes past their send time." tone={b?.sends_stuck ? 'status-warning' : ''} />
            <Tile label="Unknown send outcomes" value={String(b?.sends_unknown ?? 0)} def="Need a staff decision in the conversation." tone={b?.sends_unknown ? 'status-critical' : ''} />
            <Tile label="Media downloads pending" value={String(b?.media_pending ?? 0)} def="Attachments older than 5 minutes not yet saved." />
            <Tile label="AI spend (24h)" value={b?.ai_budget ? `$${Number(b.ai_budget.spent_24h_usd).toFixed(4)}` : '—'} def={b?.ai_budget ? `Limit $${b.ai_budget.limit_24h_usd}. ${b.ai_budget.within_budget ? 'Within budget.' : 'Budget reached: AI calls are refused.'}` : ''} tone={b?.ai_budget && !b.ai_budget.within_budget ? 'status-critical' : ''} />
          </div>
          <table className="data">
            <thead><tr><th>Component</th><th>Status</th><th>Checked</th><th>Detail</th></tr></thead>
            <tbody>{health.checks.map((c: any) => (
              <tr key={c.component}><td>{c.component}</td>
                <td className={c.status === 'ok' ? 'status-good' : c.status === 'degraded' ? 'status-warning' : 'status-critical'}>{c.status === 'ok' ? '✓' : '⚠'} {c.status}</td>
                <td>{fmtTime(c.checked_at)}</td><td className="small">{JSON.stringify(c.detail)}</td></tr>))}</tbody>
          </table>
          <h3>WhatsApp accounts</h3>
          <table className="data">
            <thead><tr><th>Account</th><th>Status</th><th>Replies</th><th>Last event</th></tr></thead>
            <tbody>{health.accounts.filter((a: any) => a.provider_account_id !== 'sandbox').map((a: any) => (
              <tr key={a.id}><td>{a.display_name ?? a.username ?? a.provider_account_id}</td><td>{a.status}</td>
                <td>{can('settings') ? <label className="row small"><input type="checkbox" checked={a.enabled} onChange={async (e) => { await api(`/api/accounts/${a.id}`, { method: 'PATCH', body: { enabled: e.target.checked } }); load(); }} />{a.enabled ? 'Enabled' : 'Disabled (messages still saved)'}</label> : (a.enabled ? 'Enabled' : 'Disabled')}</td>
                <td>{fmtTime(a.last_event_at)}</td></tr>))}</tbody>
          </table>
        </section>
      )}

      <section className="stack" aria-labelledby="ops-h">
        <h2 id="ops-h">Order operations</h2>
        {ops.length === 0 && <span className="small muted">Nothing pending.</span>}
        <table className="data">
          <thead><tr><th>Type</th><th>Order</th><th>Customer</th><th>Status</th><th>Created</th></tr></thead>
          <tbody>{ops.map((o) => (
            <tr key={o.id}><td>{o.op_type.replace(/_/g, ' ')}</td><td>{o.woo_order_id ? `#${o.woo_order_id}` : '—'}</td>
              <td><a href={`/?c=${o.conversation_id}`}>{o.customer_name ?? 'open'}</a></td><td>{o.status.replace(/_/g, ' ')}</td><td>{fmtTime(o.created_at)}</td></tr>))}</tbody>
        </table>
      </section>

      {can('view_audit') && (
        <details className="card">
          <summary>Audit log (latest 200)</summary>
          <table className="data">
            <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Entity</th></tr></thead>
            <tbody>{audit.map((a) => (
              <tr key={a.id}><td>{fmtTime(a.at)}</td><td>{a.actor_name ?? a.actor_type}</td><td>{a.action}</td><td className="small">{a.entity_type} {a.entity_id?.slice(0, 8)}</td></tr>))}</tbody>
          </table>
        </details>
      )}
    </div></div>
  );
}
