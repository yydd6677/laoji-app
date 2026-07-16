import { EventDeleteCoordinator } from '../src/services/eventDeleteCoordinator';
import { createEventDeleteTransaction } from '../src/services/eventDeleteTransactions';
import { HttpResponseError } from '../src/services/errors';
import type { CalEvent } from '../src/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

const EVENT: CalEvent = {
  id: '7',
  sourceEventId: '7',
  occurrenceDate: '2026-07-20',
  title: '项目评审',
  startDate: '2026-07-20',
  startTime: '10:00',
  endTime: '11:00',
  color: '#1456F0',
  revision: 2,
};

function transaction() {
  return createEventDeleteTransaction({
    scopeKey: 'user:7',
    target: EVENT,
    recurrenceScope: 'series',
    relatedEvents: [EVENT],
    catalogEvent: EVENT,
    now: 1_000,
  });
}

function adapter(overrides: Record<string, unknown> = {}) {
  return {
    persist: jest.fn(async () => undefined),
    applyAbsent: jest.fn(async () => undefined),
    applyPresent: jest.fn(async () => undefined),
    cancelReminders: jest.fn(async () => undefined),
    restoreReminders: jest.fn(async () => undefined),
    executeDelete: jest.fn(async () => ({ observedState: 'absent' as const, revision: 3 })),
    executeRestore: jest.fn(async () => ({ observedState: 'present' as const, revision: 4 })),
    isKnownFailure: (error: unknown) => error instanceof HttpResponseError && error.status < 500,
    onUndoTarget: jest.fn(),
    retryDelayMs: 60_000,
    ...overrides,
  };
}

describe('EventDeleteCoordinator', () => {
  it('persists intent before hiding the event or issuing the command', async () => {
    const calls: string[] = [];
    const bridge = adapter({
      persist: jest.fn(async () => { calls.push('persist'); }),
      applyAbsent: jest.fn(async () => { calls.push('hide'); }),
      executeDelete: jest.fn(async () => {
        calls.push('delete');
        return { observedState: 'absent' as const, revision: 3 };
      }),
    });
    const coordinator = new EventDeleteCoordinator(bridge);
    await coordinator.begin(transaction());
    expect(calls.indexOf('persist')).toBeLessThan(calls.indexOf('hide'));
    expect(calls.indexOf('hide')).toBeLessThan(calls.indexOf('delete'));
    coordinator.dispose();
  });

  it('settles an in-flight delete before restoring when undo races it', async () => {
    const deleting = deferred<{ observedState: 'absent'; revision: number }>();
    const bridge = adapter({ executeDelete: jest.fn(() => deleting.promise) });
    const coordinator = new EventDeleteCoordinator(bridge);
    const tx = transaction();
    const begin = coordinator.begin(tx);
    await Promise.resolve();
    const undo = coordinator.undo(tx.id);
    expect(bridge.executeRestore).not.toHaveBeenCalled();
    deleting.resolve({ observedState: 'absent', revision: 3 });
    await Promise.all([begin, undo]);
    expect(bridge.executeRestore).toHaveBeenCalledTimes(1);
    expect(bridge.applyPresent).toHaveBeenCalledTimes(1);
    expect(coordinator.list()).toEqual([]);
    coordinator.dispose();
  });

  it('keeps an unknown delete durable and retries with the same transaction', async () => {
    const bridge = adapter({
      executeDelete: jest.fn().mockRejectedValueOnce(new Error('timeout')),
    });
    const coordinator = new EventDeleteCoordinator(bridge);
    const tx = transaction();
    await coordinator.begin(tx);
    expect(coordinator.list()[0]).toMatchObject({
      id: tx.id,
      deleteRequestId: tx.deleteRequestId,
      observedState: 'unknown',
      phase: 'retryable',
    });
    expect(bridge.applyPresent).not.toHaveBeenCalled();
    coordinator.dispose();
  });

  it('rolls back a known rejected delete instead of leaving a tombstone', async () => {
    const failure = new HttpResponseError('conflict', 409);
    const bridge = adapter({ executeDelete: jest.fn(async () => { throw failure; }) });
    const coordinator = new EventDeleteCoordinator(bridge);
    await expect(coordinator.begin(transaction())).rejects.toBe(failure);
    expect(bridge.applyPresent).toHaveBeenCalledTimes(1);
    expect(coordinator.list()).toEqual([]);
    coordinator.dispose();
  });
});
