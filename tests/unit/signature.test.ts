import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyWooSignature, verifyZernioSignature } from '../../src/lib/zernio/signature';

const secret = 'test-secret-0123456789abcdef';
const body = Buffer.from('{"id":"evt_1","event":"message.received","message":{"text":"নেটফ্লিক্স"}}');

describe('Zernio signature (hex HMAC-SHA256 of the raw body)', () => {
  const good = createHmac('sha256', secret).update(body).digest('hex');
  it('accepts the exact raw body', () => expect(verifyZernioSignature(body, good, secret)).toBe(true));
  it('rejects a re-serialized body', () => {
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 1));
    expect(verifyZernioSignature(reserialized, good, secret)).toBe(false);
  });
  it('rejects wrong secret, missing and malformed signatures', () => {
    expect(verifyZernioSignature(body, good, 'other-secret-0123456789')).toBe(false);
    expect(verifyZernioSignature(body, null, secret)).toBe(false);
    expect(verifyZernioSignature(body, 'zz', secret)).toBe(false);
    expect(verifyZernioSignature(body, good.slice(0, 63), secret)).toBe(false);
  });
});

describe('WooCommerce signature (base64 HMAC-SHA256 of the raw body)', () => {
  const good = createHmac('sha256', secret).update(body).digest('base64');
  it('accepts valid and rejects tampered', () => {
    expect(verifyWooSignature(body, good, secret)).toBe(true);
    expect(verifyWooSignature(Buffer.concat([body, Buffer.from(' ')]), good, secret)).toBe(false);
  });
});
