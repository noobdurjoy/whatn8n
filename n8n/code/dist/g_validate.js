// WA · G Memory — "Validate Summary"
// Server-side checks on the summary model's output. Only preferences the
// customer stated, with a known key and a source message from that customer,
// are kept (the database checks the source again). Values with secrets are
// dropped, not stored.
// ---- begin shared/validate.js (parseModelJson, extractUsage) (inlined by n8n/build.mjs; edit the shared file, not this copy) ----
function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

// Pull the first JSON object out of a model message. Accepts a bare object or
// one wrapped in a ```json fence; anything else is a failure, not a guess.
function parseModelJson(content) {
  if (isPlainObject(content)) return { ok: true, value: content };
  if (typeof content !== 'string') return { ok: false, error: 'no_content' };
  let s = content.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1].trim();
  if (!s.startsWith('{') || !s.endsWith('}')) return { ok: false, error: 'not_a_json_object' };
  try {
    const v = JSON.parse(s);
    return isPlainObject(v) ? { ok: true, value: v } : { ok: false, error: 'not_a_json_object' };
  } catch (e) {
    return { ok: false, error: 'invalid_json' };
  }
}

// Reduce OpenRouter's response metadata to what we store. Missing usage stays
// null ("unavailable"), never 0.
function extractUsage(resp, model, latencyMs) {
  const u = resp && resp.usage;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    model: (resp && resp.model) || model,
    provider: (resp && resp.provider) || null,
    request_id: (resp && resp.id) || null,
    latency_ms: typeof latencyMs === 'number' ? Math.round(latencyMs) : null,
    prompt_tokens: u ? num(u.prompt_tokens) : null,
    completion_tokens: u ? num(u.completion_tokens) : null,
    reasoning_tokens: u && u.completion_tokens_details ? num(u.completion_tokens_details.reasoning_tokens) : null,
    cost_usd: u ? num(u.cost) : null,
  };
}
// ---- end shared/validate.js ----
// ---- begin shared/redact.js (redactSecrets, redactSecretsText) (inlined by n8n/build.mjs; edit the shared file, not this copy) ----
// Redaction helpers. Dependency-free; inlined into n8n Code nodes.
//
// redactSecrets: applied to EVERYTHING before it reaches a model, a log line
//   or shared knowledge: OTPs, passwords, card numbers, CVVs, API keys and
//   login/token links.
// redactPersonal: additionally applied before conversation text enters the
//   daily-learning review: phones, emails, order numbers, transaction ids.
function luhnValid(digits) {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';

function asciiDigits(s) {
  return s.replace(/[০-৯]/g, (d) => String(BN_DIGITS.indexOf(d)));
}

function redactSecrets(input) {
  if (input === null || input === undefined) return input;
  let s = String(input);
  const found = [];
  const mark = (kind) => { if (!found.includes(kind)) found.push(kind); };

  // Links that carry credentials or one-time tokens.
  s = s.replace(/\bhttps?:\/\/[^\s<>"']+/gi, (url) => {
    if (/[?&#](?:token|access_token|auth|key|api_key|apikey|sig|signature|code|otp|password|pass|session|magic|login|reset)=/i.test(url)
        || /\/(?:reset-password|password-reset|magic-link|verify-email|login\/token|auth\/callback)\b/i.test(url)) {
      mark('login_link');
      return '[login link removed]';
    }
    return url;
  });

  // API keys and bearer tokens.
  s = s.replace(/\b(?:sk|pk|rk|zrk|sk-or-v1|ghp|gho|xox[abpr])[-_][A-Za-z0-9_-]{16,}\b/g, () => { mark('api_key'); return '[secret removed]'; });
  s = s.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, () => { mark('api_key'); return 'Bearer [secret removed]'; });
  s = s.replace(/\b(?:ck|cs)_[a-f0-9]{30,}\b/gi, () => { mark('api_key'); return '[secret removed]'; });

  // "password: xyz", "pass - xyz", "পাসওয়ার্ড: xyz", "pw xyz"
  s = s.replace(/((?:password|passwd|pass|pwd|pw|pin|পাসওয়ার্ড|পাসওয়ার্ড|পিন)\s*(?:is|hocche|holo|হলো|হচ্ছে)?\s*[:=\-–]?\s*)(\S{3,})/gi, (m, p1) => {
    mark('password');
    return `${p1}[hidden]`;
  });

  // OTP / verification codes near a keyword (English, Bangla, Banglish).
  s = s.replace(/((?:otp|o\.t\.p|verification code|verify code|security code|login code|auth code|code|কোড|ওটিপি|ভেরিফিকেশন কোড)\s*(?:is|holo|hocche|হলো|হচ্ছে)?\s*[:=\-–]?\s*)([0-9০-৯][0-9০-৯\s-]{2,9}[0-9০-৯])/gi, (m, p1, code) => {
    const digits = asciiDigits(code).replace(/\D/g, '');
    if (digits.length >= 4 && digits.length <= 8) { mark('otp'); return `${p1}[hidden]`; }
    return m;
  });

  // Card numbers (13–19 digits, Luhn-valid) and CVV.
  s = s.replace(/\b(?:\d[ -]?){12,18}\d\b/g, (m) => {
    const digits = m.replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) { mark('card_number'); return '[card number hidden]'; }
    return m;
  });
  s = s.replace(/\b(cvv|cvc|cvv2|security number)\s*[:=\-]?\s*\d{3,4}\b/gi, (m, p1) => { mark('cvv'); return `${p1} [hidden]`; });

  return found.length ? { text: s, redacted: found } : { text: s, redacted: [] };
}

function redactSecretsText(input) {
  return redactSecrets(input).text;
}

function redactPersonal(input) {
  let s = redactSecretsText(input);
  if (s === null || s === undefined) return s;
  s = s.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]');
  s = s.replace(/(?:\+?88[\s-]?)?\b01[3-9](?:[\s-]?\d){8}\b/g, '[PHONE]');
  s = s.replace(/(?:\+|\b00)\d(?:[\s-]?\d){8,14}\b/g, '[PHONE]');
  s = s.replace(/[০-৯]{11}/g, '[PHONE]');
  s = s.replace(/(?:order|অর্ডার|ordar)\s*(?:no\.?|number|nomber|#|নং|নম্বর)?\s*[:#]?\s*\d{3,}/gi, '[ORDER]');
  s = s.replace(/#\d{3,}/g, '[ORDER]');
  s = s.replace(/\b(?:trx|txn|transaction|trxid|txnid|ট্রানজেকশন)\s*(?:id|আইডি)?\s*[:#-]?\s*[A-Z0-9]{6,}\b/gi, '[TRANSACTION]');
  s = s.replace(/\b[A-Z0-9]{10}\b/g, (m) => (/\d/.test(m) && /[A-Z]/.test(m) ? '[TRANSACTION]' : m));
  return s;
}
// ---- end shared/redact.js ----

const meta = $('Prepare Summary Request').first().json.meta;
const resp = $input.first().json || {};
const usage = extractUsage(resp, null, Date.now() - meta.started_at);
usage.purpose = 'summary';
const choice = resp.choices && resp.choices[0];
const parsed = choice && choice.finish_reason !== 'length' ? parseModelJson(choice.message && choice.message.content) : { ok: false };
const KEYS = ['preferred_language', 'preferred_payment_method', 'device', 'preferred_contact_time', 'preferred_name', 'operating_system'];
function list(v, n, len) { return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, n).map((x) => redactSecretsText(x).slice(0, len)) : []; }

if (!parsed.ok || typeof parsed.value.summary !== 'string') {
  usage.outcome = resp.error ? 'error' : 'invalid_output';
  return [{ json: { ok: false, save: { usage: usage } } }];
}
usage.outcome = 'ok';
const v = parsed.value;
const memories = [];
for (const p of (Array.isArray(v.preferences) ? v.preferences : []).slice(0, 6)) {
  if (!p || KEYS.indexOf(p.key) < 0 || typeof p.value !== 'string') continue;
  if (meta.customer_message_ids.indexOf(p.source_message_id) < 0) continue;
  const red = redactSecrets(p.value);
  if (red.redacted.length) continue;
  memories.push({ key: p.key, value: p.value.trim().slice(0, 120), source_message_id: p.source_message_id });
}
return [{ json: { ok: true, save: {
  conversation_id: meta.conversation_id,
  summary: redactSecretsText(v.summary).slice(0, 600),
  actions: list(v.actions_taken, 8, 200),
  open: list(v.open_issues, 5, 200),
  covers_until: meta.covers_until,
  memories: memories,
  usage: usage,
} } }];
