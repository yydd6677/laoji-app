import { EventEditCoordinator, type EventEditCoordinatorAdapter } from '../src/services/eventEditCoordinator';
import { HttpResponseError } from '../src/services/errors';
import type { ApiEventEditCommandResponse } from '../src/services/api';
import type { EventEditTransaction } from '../src/services/eventEditTransactions';

function transaction(overrides: Partial<EventEditTransaction> = {}): EventEditTransaction {
  return {
    id: 'edit-request-1',
    scopeKey: 'user:7',
    ref: { sourceEventId: '42', occurrenceDate: '2026-07-20' },
    recurrenceScope: 'occurrence',
    patch: { title: '产品周会' },
    expectedRevision: 7,
    phase: 'pending',
    createdAt: 1,
    ...overrides,
  };
}

function response(requestId = 'edit-request-1'): ApiEventEditCommandResponse {
  return {
    client_request_id: requestId,
    source_event_id: 42,
    canonical_ref: { source_event_id: 42, occurrence_date: '2026-07-20' },
    scope: 'occurrence',
    previous_revision: 7,
    revision: 8,
    changed: true,
    event: {
      id: 42,
      title: '产品周会',
      event_type: 'weekly',
      start_date: '2026-07-20',
    },
    affected_range: {
      from_occurrence_date: '2026-07-20',
      through_occurrence_date: '2026-07-20',
    },
  };
}

function adapter(
  overrides: Partial<EventEditCoordinatorAdapter<string>> = {},
): EventEditCoordinatorAdapter<string> {
  return {
    persist: jest.fn().mockResolvedValue(undefined),
    execute: jest.fn().mockResolvedValue(response()),
    recover: jest.fn().mockResolvedValue(response()),
    apply: jest.fn().mockResolvedValue('done'),
    classifyFailure: (error, operation) => {
      if (operation === 'recover' && error instanceof HttpResponseError && error.status === 404) {
        return 'command-missing';
      }
      if (error instanceof HttpResponseError && error.status >= 400 && error.status < 500) {
        return 'permanent';
      }
      return 'retryable';
    },
    retryDelayMs: 60_000,
    ...overrides,
  };
}

describe('EventEditCoordinator', () => {
  it('persists the write-ahead journal before executing the command', async () => {
    const calls: string[] = [];
    const current = adapter({
      persist: jest.fn(async transactions => {
        calls.push(`persist:${transactions[0]?.phase ?? 'empty'}`);
      }),
      execute: jest.fn(async () => {
        calls.push('execute');
        return response();
      }),
      apply: jest.fn(async () => {
        calls.push('apply');
        return 'done';
      }),
    });
    const coordinator = new EventEditCoordinator(current);

    await expect(coordinator.begin(transaction())).resolves.toEqual({ status: 'applied', value: 'done' });
    expect(calls).toEqual([
      'persist:pending',
      'persist:submitting',
      'execute',
      'apply',
      'persist:empty',
    ]);
    expect(coordinator.list()).toEqual([]);
    coordinator.dispose();
  });

  it('keeps an unknown network result and resumes with the same request id', async () => {
    const current = adapter({
      execute: jest.fn()
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValueOnce(response()),
      recover: jest.fn().mockRejectedValue(new HttpResponseError('not found', 404)),
    });
    const coordinator = new EventEditCoordinator(current);

    await expect(coordinator.begin(transaction())).resolves.toEqual({ status: 'pending' });
    expect(coordinator.list()[0]).toEqual(expect.objectContaining({
      id: 'edit-request-1',
      phase: 'retryable',
    }));

    await coordinator.resumeAll();
    expect(current.execute).toHaveBeenCalledTimes(2);
    expect((current.execute as jest.Mock).mock.calls[1][0].id).toBe('edit-request-1');
    expect(coordinator.list()).toEqual([]);
    coordinator.dispose();
  });

  it('recovers a committed command without posting it again', async () => {
    const current = adapter();
    const coordinator = new EventEditCoordinator(current);
    coordinator.hydrate([transaction({ phase: 'retryable' })]);

    await coordinator.resumeAll();

    expect(current.recover).toHaveBeenCalledTimes(1);
    expect(current.execute).not.toHaveBeenCalled();
    expect(current.apply).toHaveBeenCalledTimes(1);
    expect(coordinator.list()).toEqual([]);
    coordinator.dispose();
  });

  it('removes a permanently rejected command and surfaces the error', async () => {
    const error = new HttpResponseError('revision conflict', 409);
    const current = adapter({ execute: jest.fn().mockRejectedValue(error) });
    const coordinator = new EventEditCoordinator(current);

    await expect(coordinator.begin(transaction())).rejects.toBe(error);
    expect(coordinator.list()).toEqual([]);
    expect(current.persist).toHaveBeenLastCalledWith([]);
    coordinator.dispose();
  });

  it('retains a committed command when local application fails', async () => {
    const current = adapter({
      apply: jest.fn()
        .mockRejectedValueOnce(new Error('cache unavailable'))
        .mockResolvedValueOnce('recovered'),
    });
    const coordinator = new EventEditCoordinator(current);

    await expect(coordinator.begin(transaction())).resolves.toEqual({ status: 'pending' });
    expect(coordinator.list()[0].phase).toBe('retryable');

    await coordinator.resumeAll();
    expect(current.execute).toHaveBeenCalledTimes(1);
    expect(current.recover).toHaveBeenCalledTimes(1);
    expect(current.apply).toHaveBeenCalledTimes(2);
    expect(coordinator.list()).toEqual([]);
    coordinator.dispose();
  });

  it('serializes commands for the same source event', async () => {
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstPending = new Promise<void>(resolve => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve; });
    const calls: string[] = [];
    const current = adapter({
      execute: jest.fn(async item => {
        calls.push(`start:${item.id}`);
        if (item.id === 'first') {
          markFirstStarted();
          await firstPending;
        }
        calls.push(`end:${item.id}`);
        return response(item.id);
      }),
    });
    const coordinator = new EventEditCoordinator(current);

    const first = coordinator.begin(transaction({ id: 'first' }));
    const second = coordinator.begin(transaction({ id: 'second', createdAt: 2 }));
    await firstStarted;
    expect(calls).toEqual(['start:first']);
    releaseFirst();
    await Promise.all([first, second]);

    expect(calls).toEqual(['start:first', 'end:first', 'start:second', 'end:second']);
    coordinator.dispose();
  });
});
