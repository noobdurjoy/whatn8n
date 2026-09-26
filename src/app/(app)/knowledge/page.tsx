'use client';

import { useCallback, useEffect, useState } from 'react';
import { containsBangla, fmtTime, useApi } from '@/components/session';

export default function KnowledgePage() {
  const api = useApi();
  const [data, setData] = useState<{ documents: any[]; proposals: any[]; can_review: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<any | null>(null);
  const load = useCallback(async () => {
    try { setData(await api('/api/knowledge')); } catch (e: any) { setErr(e.message); }
  }, [api]);
  useEffect(() => { load(); }, [load]);

  async function run(fn: () => Promise<unknown>) {
    setErr(null);
    try { await fn(); setEditing(null); await load(); } catch (e: any) { setErr(e.message); }
  }

  if (!data) return <div className="page">{err ? <div className="error-box">{err}</div> : 'Loading…'}</div>;
  return (
    <div className="page"><div className="page-narrow stack">
      <div className="page-head">
        <div><h1>Knowledge</h1><p className="small">What the AI may tell customers: FAQs, procedures and policies.</p></div>
        {data.can_review && <button className="btn primary" onClick={() => setEditing({ category: 'faq', title: '', body: '', slug: '' })}>New entry</button>}
      </div>
      <p className="muted small">Only published, approved entries are used by the AI. Prices, stock and order status are always read live from WooCommerce and should not be written here.</p>
      {err && <div className="error-box" role="alert">{err}</div>}

      {editing && <Editor initial={editing} onCancel={() => setEditing(null)} onSave={(v) => run(() => api('/api/knowledge', { body: v }))} />}

      {data.can_review && (
        <section className="card stack">
          <h2>Proposals from daily learning ({data.proposals.length})</h2>
          {data.proposals.length === 0 && <span className="muted small">Nothing waiting for review.</span>}
          {data.proposals.map((p) => <Proposal key={p.id} p={p} onDone={load} />)}
        </section>
      )}

      <section className="stack">
        <h2>Entries</h2>
        {data.documents.length === 0 && <span className="muted small">No knowledge entries yet.</span>}
        {data.documents.map((d) => {
          const published = d.versions.find((v: any) => v.id === d.published_version_id);
          return (
            <div key={d.id} className="card stack">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <strong lang={containsBangla(published?.title) ? 'bn' : undefined}>{published?.title ?? d.slug}</strong>
                <span className="row small"><span className="pill">{d.category}</span><span className="muted">v{published?.version_no ?? '—'}</span></span>
              </div>
              <div className="small" style={{ whiteSpace: 'pre-wrap' }} lang={containsBangla(published?.body) ? 'bn' : undefined}>{published?.body}</div>
              {data.can_review && (
                <details className="small">
                  <summary>Versions and rollback</summary>
                  <div className="stack" style={{ marginTop: 6 }}>
                    <button className="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => setEditing({ document_id: d.id, category: d.category, title: published?.title ?? '', body: published?.body ?? '' })}>Edit (creates a new version)</button>
                    {d.versions.map((v: any) => (
                      <div key={v.id} className="row">
                        <span>v{v.version_no} · {v.status} · {v.source.replace('_', ' ')} · {fmtTime(v.created_at)}</span>
                        {v.id !== d.published_version_id && v.status !== 'rejected' && (
                          <button className="btn small" onClick={() => run(() => api(`/api/knowledge/versions/${v.id}/publish`, { body: {} }))}>Publish this version</button>
                        )}
                        {v.id === d.published_version_id && <span className="pill status-good">published</span>}
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          );
        })}
      </section>
    </div></div>
  );
}

function Editor({ initial, onSave, onCancel }: { initial: any; onSave: (v: any) => void; onCancel: () => void }) {
  const [v, setV] = useState(initial);
  return (
    <section className="card stack" aria-label="Knowledge editor">
      <h2>{v.document_id ? 'Edit entry' : 'New entry'}</h2>
      {!v.document_id && (
        <label className="stack small">Short id (letters, numbers, dashes)
          <input className="input" value={v.slug} onChange={(e) => setV({ ...v, slug: e.target.value.toLowerCase() })} />
        </label>
      )}
      <label className="stack small">Category
        <select className="input" value={v.category} onChange={(e) => setV({ ...v, category: e.target.value })}>
          <option value="faq">FAQ</option><option value="product">Product explanation</option><option value="procedure">Support procedure</option><option value="policy">Business policy</option>
        </select>
      </label>
      <label className="stack small">Title<input className="input" value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} /></label>
      <label className="stack small">Text<textarea className="input" rows={8} value={v.body} onChange={(e) => setV({ ...v, body: e.target.value })} /></label>
      <div className="row">
        <button className="btn primary" onClick={() => onSave({ ...v, slug: v.slug || undefined })}>Save & publish</button>
        <button className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </section>
  );
}

function Proposal({ p, onDone }: { p: any; onDone: () => void }) {
  const api = useApi();
  const [title, setTitle] = useState(p.proposed_title);
  const [body, setBody] = useState(p.proposed_body);
  const [err, setErr] = useState<string | null>(null);
  const edited = title !== p.proposed_title || body !== p.proposed_body;
  async function act(action: string) {
    setErr(null);
    try { await api(`/api/knowledge/proposals/${p.id}`, { body: { action, title, body } }); onDone(); } catch (e: any) { setErr(e.message); }
  }
  return (
    <div className="card stack">
      <div className="row small"><span className="pill">{p.kind === 'new' ? 'New' : `Revise ${p.document_slug}`}</span><span className="pill">{p.category}</span><span className="muted">{fmtTime(p.created_at)}</span></div>
      <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Proposed title" />
      <textarea className="input" rows={5} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Proposed text" />
      {p.rationale && <div className="small"><strong>Why:</strong> {p.rationale}</div>}
      {p.evidence_refs?.length > 0 && (
        <div className="small">Evidence (open to check):{' '}
          {p.evidence_refs.map((r: any, i: number) => <a key={i} href={`/?c=${r.conversation_id ?? r}`} style={{ marginRight: 6 }}>conversation {i + 1}</a>)}
        </div>
      )}
      {p.redaction_report && Object.keys(p.redaction_report).length > 0 && <div className="small muted">Redacted before review: {JSON.stringify(p.redaction_report)}</div>}
      <div className="row">
        <button className="btn small primary" onClick={() => act(edited ? 'edit_approve' : 'approve')}>{edited ? 'Save edits & approve' : 'Approve'}</button>
        <button className="btn small" onClick={() => act('reject')}>Reject</button>
      </div>
      {err && <div className="error-box" role="alert">{err}</div>}
    </div>
  );
}
