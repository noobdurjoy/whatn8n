import { describe, expect, it } from 'vitest';
import { normalizePhone, parseCommand, validateAction, planStockWrite, stockMatches, formatDhaka } from '../../shared/admin-commands.js';

describe('phone normalization', () => {
  it.each([
    ['01350590593', '8801350590593'], ['+8801350590593', '8801350590593'], ['8801350590593', '8801350590593'],
    ['008801350590593', '8801350590593'], ['01350-590593', '8801350590593'], ['০১৩৫০৫৯০৫৯৩', '8801350590593'],
    ['1350590593', '8801350590593'], ['+44 7700 900123', '447700900123'],
  ])('%s → %s', (a, b) => expect(normalizePhone(a)).toBe(b));
  it.each(['0135059059', '012345678901', 'abc', '', '+880 12 3456 7890'])('rejects %s', (a) => expect(normalizePhone(a)).toBeNull());
});

describe('rule parser', () => {
  it('parses the required examples exactly', () => {
    expect(parseCommand('Set stock for SKU SPOTIFY-1M to 5.'.replace(/\.$/, '')).action).toEqual({ type: 'stock_set', quantity: 5, sku: 'SPOTIFY-1M' });
    expect(parseCommand('Netflix 1 month is out of stock').action).toEqual({ type: 'stock_status', stock_status: 'outofstock', query: 'Netflix 1 month' });
    expect(parseCommand('Add 3 units to product 123').action).toEqual({ type: 'stock_adjust', delta: 3, product_id: 123, variation_id: null });
    expect(parseCommand('Remove 2 units from SKU NF-1M').action).toEqual({ type: 'stock_adjust', delta: -2, sku: 'NF-1M' });
    expect(parseCommand('Remember: support hours are 10am to 10pm.').action).toMatchObject({ type: 'knowledge_permanent', body: 'support hours are 10am to 10pm.' });
    expect(parseCommand('Note: supplier is late').action).toEqual({ type: 'staff_note', body: 'supplier is late' });
    expect(parseCommand('Temporary: Netflix delivery is delayed until tomorrow at 6pm.')).toEqual({ needs_model: true });
    expect(parseCommand('Remove the temporary Netflix delivery notice').action).toEqual({ type: 'notice_cancel', match: 'Netflix delivery' });
    expect(parseCommand('For Spotify customers, explain that delivery requires their email address.')).toEqual({ needs_model: true });
  });
  it('keeps the WhatsApp reply text exactly as written', () => {
    expect(parseCommand('Reply to 01350590593: stock available now.').action).toEqual({ type: 'reply_whatsapp', phone: '8801350590593', text: 'stock available now.' });
    expect(parseCommand('reply to +880 1350-590593: Hi!  Two  spaces: kept').action).toEqual({ type: 'reply_whatsapp', phone: '8801350590593', text: 'Hi!  Two  spaces: kept' });
    expect(parseCommand('Reply to 0135: hi').action.type).toBe('clarify');
  });
  it('uses the open choice list for a bare number, and cancel', () => {
    const pending = { status: 'awaiting_choice', command_id: 'c1', action: { type: 'stock_set', quantity: 5, query: 'netflix' } };
    expect(parseCommand('2', pending)).toEqual({ action: { type: 'stock_set', quantity: 5, query: 'netflix', choice: 2 }, parsed_by: 'choice', parent_id: 'c1' });
    expect(parseCommand('cancel', pending).action.type).toBe('cancel');
  });
});

describe('validation of model proposals', () => {
  const now = new Date('2026-09-25T10:00:00Z');
  it('rejects paraphrased reply text and invented numbers', () => {
    expect(validateAction({ type: 'reply_whatsapp', phone: '01350590593', text: 'Stock is available now!' }, 'reply 01350590593 stock available now', { now }).ok).toBe(false);
    // A cut-down piece of the owner's words is not the exact message.
    expect(validateAction({ type: 'reply_whatsapp', phone: '01350590593', text: 'send the refund now' }, 'tell 01350590593: do not send the refund now', { now }).ok).toBe(false);
    expect(validateAction({ type: 'reply_whatsapp', phone: '01350590593', text: 'do not send the refund now' }, 'tell 01350590593: do not send the refund now', { now }).ok).toBe(true);
    expect(validateAction({ type: 'reply_whatsapp', phone: '01350590593', text: 'Apnar order ready' }, '01350590593 ke bolo "Apnar order ready" please', { now }).ok).toBe(true);
    expect(validateAction({ type: 'reply_whatsapp', phone: '01350590593', text: 'order ready' }, '01350590593 ke bolo "Apnar order ready" please', { now }).ok).toBe(false);
    expect(validateAction({ type: 'stock_set', quantity: 2.5, sku: 'A' }, 'x', { now }).ok).toBe(false);
    expect(validateAction({ type: 'stock_adjust', delta: 0, sku: 'A' }, 'x', { now }).ok).toBe(false);
    expect(validateAction({ type: 'delete_all_orders' }, 'x', { now }).ok).toBe(false);
  });
  it('temporary notices: future expiry required, missing expiry asks', () => {
    const ok = validateAction({ type: 'notice_temporary', body: 'Netflix delivery is delayed.', expires_at: '2026-09-26T18:00:00+06:00', keywords: ['Netflix'] }, 't', { now });
    expect(ok).toMatchObject({ ok: true, action: { expires_at: '2026-09-26T12:00:00.000Z', keywords: ['netflix'] } });
    expect(formatDhaka(ok.action.expires_at)).toBe('Sat 26 Sep 2026, 18:00 Asia/Dhaka');
    expect(validateAction({ type: 'notice_temporary', body: 'Delayed' }, 't', { now })).toMatchObject({ ok: true, action: { expires_at: null } });
    expect(validateAction({ type: 'notice_temporary', body: 'Delayed', expires_at: '2026-09-25T09:00:00Z' }, 't', { now }).ok).toBe(false);
  });
});

describe('stock planning', () => {
  const managed = { manage_stock: true, stock_quantity: 4, stock_status: 'instock' };
  const unmanaged = { manage_stock: false, stock_quantity: null, stock_status: 'instock' };
  it('set vs increment vs status', () => {
    expect(planStockWrite({ type: 'stock_set', quantity: 5 }, managed)).toEqual({ write: { stock_quantity: 5 } });
    expect(planStockWrite({ type: 'stock_adjust', delta: 3 }, managed)).toEqual({ write: { stock_quantity: 7 } });
    expect(planStockWrite({ type: 'stock_adjust', delta: -5 }, managed).clarify).toMatch(/negative/);
    expect(planStockWrite({ type: 'stock_status', stock_status: 'outofstock' }, managed)).toEqual({ write: { stock_quantity: 0 } });
    expect(planStockWrite({ type: 'stock_status', stock_status: 'outofstock' }, unmanaged)).toEqual({ write: { stock_status: 'outofstock' } });
  });
  it('never invents a quantity', () => {
    expect(planStockWrite({ type: 'stock_status', stock_status: 'instock' }, { ...managed, stock_quantity: 0 }).clarify).toMatch(/How many/);
    expect(planStockWrite({ type: 'stock_set', quantity: 5 }, unmanaged).clarify).toMatch(/tracking is OFF/);
    expect(planStockWrite({ type: 'stock_adjust', delta: 1 }, unmanaged).clarify).toMatch(/tracking is OFF/);
  });
  it('verifies the read-back', () => {
    expect(stockMatches({ stock_quantity: 5 }, { stock_quantity: 5, stock_status: 'instock' })).toBe(true);
    expect(stockMatches({ stock_quantity: 5 }, { stock_quantity: 4 })).toBe(false);
  });
});
