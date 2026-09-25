import { describe, expect, it } from 'vitest';
import { detectHandoffRequest, detectMarketingOptOut } from '../../shared/handoff.js';
import { detectLanguage } from '../../shared/language.js';
import { redactPersonal, redactSecrets } from '../../shared/redact.js';
import { parseModelJson, validateReply, validateVisionResult, extractUsage } from '../../shared/validate.js';
import { evaluateEscalation } from '../../shared/escalation.js';

describe('handoff detection', () => {
  const explicit = [
    'human please',
    'Human pls',
    'agent',
    'I want to talk to a human',
    'can I speak with a real person?',
    'connect me to an agent',
    'please transfer me to your support team',
    'I dont want a bot',
    'মানুষের সাথে কথা বলতে চাই',
    'অ্যাডমিনের সাথে কথা বলব',
    'এজেন্ট চাই',
    'বট না, মানুষ দিন',
    'bhai admin er sathe kotha bolbo',
    'admin er sathe kotha bolte chai',
    'manush er sathe kotha bolbo',
    'kotha bolte chai admin er sathe',
    'admin ke den',
    'agent chai',
  ];
  for (const t of explicit) {
    it(`explicit: ${t}`, () => expect(detectHandoffRequest(t).kind).toBe('explicit'));
  }

  const notHandoff = [
    'bhai price koto?',
    'bhai thanks',
    'Netflix er dam koto',
    'ok bhai',
    'আমি নেটফ্লিক্স কিনতে চাই',
    'what is the price of spotify',
  ];
  for (const t of notHandoff) {
    it(`none: ${t}`, () => expect(detectHandoffRequest(t).kind).toBe('none'));
  }

  // Mentions a person-word but is not a clear request: classifier decides.
  const possible = ['admin panel e login hocche na', 'is the admin online?', 'bhai admin?', 'Office 365 admin access ache?'];
  for (const t of possible) {
    it(`possible (not explicit): ${t}`, () => expect(detectHandoffRequest(t).kind).toBe('possible'));
  }

  it('marketing opt-out keywords', () => {
    expect(detectMarketingOptOut('STOP')).toBe(true);
    expect(detectMarketingOptOut('অফার পাঠাবেন না')).toBe(true);
    expect(detectMarketingOptOut('stop working after 2 days')).toBe(false);
  });
});

describe('language detection', () => {
  it('detects Bangla script', () => expect(detectLanguage('নেটফ্লিক্সের দাম কত?')).toBe('bn'));
  it('detects Banglish', () => expect(detectLanguage('bhai netflix er dam koto?')).toBe('banglish'));
  it('detects Banglish short', () => expect(detectLanguage('koto taka')).toBe('banglish'));
  it('detects English', () => expect(detectLanguage('What is the price of Netflix Premium?')).toBe('en'));
  it('returns null for emoji only', () => expect(detectLanguage('👍')).toBe(null));
});

describe('redaction', () => {
  it('removes OTPs, passwords, card numbers and token links', () => {
    const r = redactSecrets('my otp is 482913, password: Hunter22! card 4111 1111 1111 1111 cvv 123 link https://x.com/reset?token=abc123');
    expect(r.text).not.toMatch(/482913|Hunter22|4111 1111|abc123/);
    expect(r.redacted).toEqual(expect.arrayContaining(['otp', 'password', 'card_number', 'cvv', 'login_link']));
  });
  it('removes Bangla-digit OTPs', () => {
    expect(redactSecrets('কোড ৪৮২৯১৩').text).not.toContain('৪৮২৯১৩');
  });
  it('keeps ordinary numbers and product links', () => {
    const t = 'Order 3 accounts for 350 taka https://infinitydigitalshop.com/product/netflix-premium-subscription/';
    expect(redactSecrets(t).text).toBe(t);
  });
  it('removes API keys', () => {
    expect(redactSecrets('key sk-or-v1-0123456789abcdef0123456789abcdef').text).toContain('[secret removed]');
    expect(redactSecrets('ck_0123456789abcdef0123456789abcdef01234567').text).toContain('[secret removed]');
  });
  it('removes personal data for learning', () => {
    const t = redactPersonal('call me at 01712345678 or mail a.b@example.com about order #58213, trx id 9ABC1DEF23');
    expect(t).not.toMatch(/01712345678|a\.b@example\.com|58213|9ABC1DEF23/);
  });
});

describe('model output validation', () => {
  const ctx = { mode: 'AUTO', tool_refs: ['t1'], knowledge_refs: ['k1'], image_refs: [], price_tool_used: false, allowed_urls: [] };

  it('parses fenced and bare JSON, rejects prose', () => {
    expect(parseModelJson('```json\n{"a":1}\n```').ok).toBe(true);
    expect(parseModelJson('{"a":1}').ok).toBe(true);
    expect(parseModelJson('Sure! {"a":1}').ok).toBe(false);
    expect(parseModelJson('[1]').ok).toBe(false);
  });

  it('accepts a valid reply and overrides the model language label', () => {
    const r = validateReply({ decision: 'reply', reply_text: 'Ji, ache.', references: [{ type: 'knowledge', id: 'k1' }], language: 'bn' },
      { ...ctx, customer_language: 'banglish' });
    expect(r.ok).toBe(true);
    expect(r.value.language).toBe('banglish');
  });

  it('rejects unknown decisions and fabricated references', () => {
    expect(validateReply({ decision: 'refund_now', reply_text: 'x' }, ctx).ok).toBe(false);
    expect(validateReply({ decision: 'reply', reply_text: 'x', references: [{ type: 'tool', id: 'nope' }] }, ctx).ok).toBe(false);
  });

  it('rejects prices without live tool data', () => {
    const r = validateReply({ decision: 'reply', reply_text: 'Netflix is 350 taka.' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('price_without_live_tool_data');
    expect(validateReply({ decision: 'reply', reply_text: 'Netflix is ৳350.' }, { ...ctx, price_tool_used: true }).ok).toBe(true);
  });

  it('rejects unverified payment confirmations', () => {
    for (const t of ['Your payment has been received.', 'আপনার পেমেন্ট পেয়েছি', 'payment paisi bhai', 'I have marked it as paid']) {
      const r = validateReply({ decision: 'reply', reply_text: t }, ctx);
      expect(r.ok, t).toBe(false);
    }
  });

  it('rejects claims of viewing an image without a successful analysis', () => {
    expect(validateReply({ decision: 'reply', reply_text: 'I can see an error in your screenshot.' }, ctx).ok).toBe(false);
    expect(validateReply({ decision: 'reply', reply_text: 'I can see an error in your screenshot.', references: [{ type: 'image_analysis', id: 'a1' }] },
      { ...ctx, image_refs: ['a1'] }).ok).toBe(true);
  });

  it('rejects links not supplied by a tool or knowledge', () => {
    expect(validateReply({ decision: 'reply', reply_text: 'Buy here https://evil.example/x' }, ctx).ok).toBe(false);
    expect(validateReply({ decision: 'reply', reply_text: 'Buy here https://shop.example/p/1.' },
      { ...ctx, allowed_urls: ['https://shop.example/p/1'] }).ok).toBe(true);
  });

  it('requires a handoff reason and blocks leaked reasoning', () => {
    expect(validateReply({ decision: 'handoff' }, ctx).ok).toBe(false);
    expect(validateReply({ decision: 'handoff', handoff_reason: 'refund_request' }, ctx).ok).toBe(true);
    expect(validateReply({ decision: 'reply', reply_text: '<think>hmm</think> hi' }, ctx).ok).toBe(false);
  });

  it('never lets HUMAN mode produce a customer reply', () => {
    expect(validateReply({ decision: 'reply', reply_text: 'hi' }, { ...ctx, mode: 'HUMAN' }).ok).toBe(false);
  });
});

describe('vision result validation', () => {
  const good = {
    image_type: 'payment_receipt',
    visible_details: ['bKash payment screen'],
    extracted_text: [{ text: 'TrxID 9ABC1DEF23 Amount 350', language: 'en' }],
    references: [{ kind: 'transaction_id', value: '9ABC1DEF23' }],
    unreadable_areas: [],
    uncertainties: [],
    suggested_next_step: 'Check the transaction in the payment gateway.',
  };
  it('accepts a valid observation and never marks it as payment proof', () => {
    const r = validateVisionResult(good);
    expect(r.ok).toBe(true);
    expect(r.value.payment_proof).toBe(false);
    expect(r.value.readable).toBe(true);
  });
  it('rejects schema violations', () => {
    expect(validateVisionResult({ ...good, image_type: 'paid_receipt_verified' }).ok).toBe(false);
    expect(validateVisionResult({ ...good, visible_details: 'text' }).ok).toBe(false);
    expect(validateVisionResult('{"image_type":"other"}').ok).toBe(false);
  });
  it('treats an empty observation as unreadable', () => {
    const r = validateVisionResult({ ...good, image_type: 'unclear', visible_details: [], extracted_text: [], references: [] });
    expect(r.ok).toBe(true);
    expect(r.value.readable).toBe(false);
  });
});

describe('usage extraction', () => {
  it('keeps missing usage as null, not zero', () => {
    const u = extractUsage({ id: 'gen-1', model: 'm' }, 'm', 1200);
    expect(u.prompt_tokens).toBeNull();
    expect(u.cost_usd).toBeNull();
    const v = extractUsage({ id: 'gen-2', usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0001,
      completion_tokens_details: { reasoning_tokens: 3 } } }, 'm', 10);
    expect(v).toMatchObject({ prompt_tokens: 10, completion_tokens: 5, reasoning_tokens: 3, cost_usd: 0.0001, request_id: 'gen-2' });
  });
});

describe('escalation rules', () => {
  const rules = {
    customer_requests_human: { enabled: true },
    unresolved_complaint: { enabled: true, complaint_turns: 2 },
    repeated_failed_answers: { enabled: true, unresolved_turns: 2 },
    refund_request: { enabled: true },
    unavailable_information: { enabled: true },
    purchase_intent: { enabled: false },
  };
  it('purchase intent keeps selling by default', () => {
    expect(evaluateEscalation({ rules, intents: ['purchase_intent'], decision: 'reply', state: {} }).handoff).toBe(false);
  });
  it('purchase intent hands off when the owner enables it', () => {
    const r = evaluateEscalation({ rules: { ...rules, purchase_intent: { enabled: true } }, intents: ['purchase_intent'], decision: 'reply', state: {} });
    expect(r).toEqual({ handoff: true, reason: 'purchase_intent' });
  });
  it('refunds escalate', () => {
    expect(evaluateEscalation({ rules, intents: ['refund_request'], decision: 'reply', state: {} }).reason).toBe('refund_request');
  });
  it('second complaint escalates, first does not', () => {
    expect(evaluateEscalation({ rules, intents: ['complaint'], decision: 'reply', state: { complaint_turns_24h: 0 } }).handoff).toBe(false);
    expect(evaluateEscalation({ rules, intents: ['complaint'], decision: 'reply', state: { complaint_turns_24h: 1 } }).handoff).toBe(true);
  });
  it('repeated failed answers escalate', () => {
    expect(evaluateEscalation({ rules, intents: [], decision: 'reply', state: { ai_unresolved_turns_24h: 2 } }).reason).toBe('repeated_failed_answers');
  });
  it('disabled rules do not fire', () => {
    const off = { ...rules, refund_request: { enabled: false } };
    expect(evaluateEscalation({ rules: off, intents: ['refund_request'], decision: 'reply', state: {} }).handoff).toBe(false);
  });
});
