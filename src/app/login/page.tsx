'use client';

import { useState } from 'react';
import { BrandMark, IconCheck } from '@/components/icons';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }),
    }).catch(() => null);
    setBusy(false);
    if (r?.ok) { window.location.href = '/'; return; }
    const d = await r?.json().catch(() => null);
    setError(d?.error ?? 'Could not sign in');
  }

  return (
    <main className="auth">
      <section className="auth-hero" aria-hidden="true">
        <div className="row" style={{ gap: 10 }}>
          <span className="brand-mark"><BrandMark /></span>
          <strong>Infinity Digital Shop</strong>
        </div>
        <div>
          <h1>Every WhatsApp customer, answered well.</h1>
          <p>One place for your team to read, approve and send replies, with AI drafts that never leave without your say-so.</p>
          <ul>
            <li><IconCheck /> Live prices and stock straight from the shop</li>
            <li><IconCheck /> AI drafts you approve from here or from Telegram</li>
            <li><IconCheck /> Emergency stop and full audit trail for every send</li>
          </ul>
        </div>
        <p className="small" style={{ opacity: .7 }}>Staff access only. Activity is logged.</p>
      </section>
      <section className="auth-main">
        <form onSubmit={submit} className="auth-card" aria-labelledby="login-title">
          <div>
            <h2 id="login-title">Sign in</h2>
            <p className="muted small" style={{ margin: '4px 0 0' }}>Use your staff account for the support desk.</p>
          </div>
          <label className="stack small">Email
            <input className="input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </label>
          <label className="stack small">Password
            <input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {error && <div className="error-box" role="alert">{error}</div>}
          <button className="btn primary" type="submit" disabled={busy} style={{ minHeight: 42 }}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
      </section>
    </main>
  );
}
