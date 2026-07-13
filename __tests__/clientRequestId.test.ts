import {
  createClientRequestId,
  createClientRequestState,
  requestStateForPayload,
} from '../src/services/clientRequestId';

describe('client request idempotency keys', () => {
  it('creates compact transport-safe unique IDs', () => {
    const first = createClientRequestId('event');
    const second = createClientRequestId('event');
    expect(first).not.toBe(second);
    expect(first).toMatch(/^event:[a-z0-9]+:[a-z0-9]+:[a-z0-9]+$/);
    expect(first.length).toBeLessThanOrEqual(96);
  });

  it('reuses an ID for the same payload and rotates it after the payload changes', () => {
    const initial = createClientRequestState('event');
    const firstAttempt = requestStateForPayload(initial, 'event', { title: '例会', date: '2026-07-12' });
    const retry = requestStateForPayload(firstAttempt, 'event', { title: '例会', date: '2026-07-12' });
    const changed = requestStateForPayload(retry, 'event', { title: '改期例会', date: '2026-07-13' });

    expect(retry.id).toBe(firstAttempt.id);
    expect(changed.id).not.toBe(firstAttempt.id);
  });
});
