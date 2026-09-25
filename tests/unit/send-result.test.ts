import { describe, expect, it } from 'vitest';
import { buildSendBody, classifySendResult } from '../../shared/send-result.js';

describe('send result classification (Zernio contract)', () => {
  it('2xx is accepted with the wamid', () => {
    expect(classifySendResult({ status: 200, body: { success: true, data: { messageId: 'wamid.X' } }, headers: null, networkError: null }))
      .toMatchObject({ outcome: 'accepted', provider_message_id: 'wamid.X' });
  });
  it('5xx and timeouts are ambiguous (reconcile, never blind retry)', () => {
    expect(classifySendResult({ status: 502, body: {}, headers: null, networkError: null }).outcome).toBe('ambiguous');
    expect(classifySendResult({ status: null, body: null, headers: null, networkError: 'timeout' }).outcome).toBe('ambiguous');
    expect(classifySendResult({ status: null, body: null, headers: null, networkError: 'reset' }).outcome).toBe('ambiguous');
  });
  it('requests that never reached Zernio are retryable', () => {
    expect(classifySendResult({ status: null, body: null, headers: null, networkError: 'refused' }).outcome).toBe('rejected_retryable');
  });
  it('409 idempotency in flight and 429 wait and retry; 422 key reuse is a bug', () => {
    expect(classifySendResult({ status: 409, body: {}, headers: { 'Retry-After': '5' }, networkError: null })).toMatchObject({ outcome: 'rejected_retryable', retry_after_seconds: 5 });
    expect(classifySendResult({ status: 429, body: {}, headers: null, networkError: null }).outcome).toBe('rejected_retryable');
    expect(classifySendResult({ status: 422, body: {}, headers: null, networkError: null }).outcome).toBe('rejected_permanent');
  });
  it('WhatsApp pair rate limit retries; closed window is permanent', () => {
    expect(classifySendResult({ status: 400, body: { platformError: { code: 131056 } }, headers: null, networkError: null }).outcome).toBe('rejected_retryable');
    expect(classifySendResult({ status: 400, body: { platformError: { code: 131047 } }, headers: null, networkError: null }))
      .toMatchObject({ outcome: 'rejected_permanent', error: { code: 'outside_customer_service_window' } });
  });
  it('builds documented request bodies only', () => {
    expect(buildSendBody({ provider_account_id: 'a', body: 'hi', payload: { junk: 1 } })).toEqual({ accountId: 'a', message: 'hi' });
    expect(buildSendBody({ provider_account_id: 'a', body: null, payload: { template: { name: 't', language: 'bn' } } }))
      .toEqual({ accountId: 'a', template: { elements: [{ name: 't', language: 'bn', components: [] }] } });
    expect(buildSendBody({ provider_account_id: 'a', body: 'see', payload: { attachment: { url: 'https://x/y.pdf', type: 'file', filename: 'Invoice.pdf' } } }))
      .toEqual({ accountId: 'a', message: 'see', attachmentUrl: 'https://x/y.pdf', attachmentType: 'file', attachmentName: 'Invoice.pdf' });
  });
});
