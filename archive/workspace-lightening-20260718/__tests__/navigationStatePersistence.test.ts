import {
  NavigationStateWriter,
  NAVIGATION_STATE_STORAGE_KEY,
  readPersistedNavigationState,
  type NavigationStateStorage,
} from '../src/services/navigationStatePersistence';
import {
  createPersistedNavigationState,
  defaultNavigationState,
} from '../src/services/navigationState';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function stateAt(name: 'EventDetail' | 'Transcription', id: string) {
  return {
    index: 1,
    routes: [
      { name: 'MainTabs', params: { screen: 'Schedule' } },
      name === 'EventDetail'
        ? { name, params: { eventRef: { sourceEventId: id, occurrenceDate: '2026-07-17' } } }
        : { name, params: { meetingId: id } },
    ],
  };
}

function memoryStorage() {
  const values = new Map<string, string>();
  const storage: NavigationStateStorage = {
    getItem: jest.fn(async key => values.get(key) ?? null),
    setItem: jest.fn(async (key, value) => { values.set(key, value); }),
    removeItem: jest.fn(async key => { values.delete(key); }),
  };
  return { storage, values };
}

describe('NavigationStateWriter ordering', () => {
  afterEach(() => jest.useRealTimers());

  it('debounces to the latest state in one auth generation', async () => {
    jest.useFakeTimers();
    const { storage, values } = memoryStorage();
    let now = 100;
    const writer = new NavigationStateWriter({ storage, debounceMs: 200, now: () => now });
    writer.activateInitialScope('user:7');
    writer.schedule('user:7', stateAt('EventDetail', 'old-event'));
    now = 200;
    writer.schedule('user:7', stateAt('Transcription', 'latest-meeting'));

    expect(storage.setItem).not.toHaveBeenCalled();
    jest.advanceTimersByTime(200);
    await flushMicrotasks();
    await writer.waitForIdle();

    expect(storage.setItem).toHaveBeenCalledTimes(1);
    const record = JSON.parse(values.get(NAVIGATION_STATE_STORAGE_KEY)!);
    expect(record.updatedAt).toBe(200);
    expect(record.state.routes[1]).toMatchObject({
      name: 'Transcription',
      params: { meetingId: 'latest-meeting' },
    });
  });

  it('serializes already-started writes so an older state cannot finish last', async () => {
    const values = new Map<string, string>();
    const firstWrite = deferred<void>();
    let calls = 0;
    const storage: NavigationStateStorage = {
      getItem: jest.fn(async key => values.get(key) ?? null),
      setItem: jest.fn(async (key, value) => {
        calls += 1;
        if (calls === 1) await firstWrite.promise;
        values.set(key, value);
      }),
      removeItem: jest.fn(async key => { values.delete(key); }),
    };
    const writer = new NavigationStateWriter({ storage, debounceMs: 1 });
    writer.activateInitialScope('user:7');
    writer.schedule('user:7', stateAt('EventDetail', 'old-event'));
    const oldWrite = writer.flush();
    await flushMicrotasks();
    expect(storage.setItem).toHaveBeenCalledTimes(1);

    writer.schedule('user:7', stateAt('Transcription', 'new-meeting'));
    const newWrite = writer.flush();
    await flushMicrotasks();
    expect(storage.setItem).toHaveBeenCalledTimes(1);

    firstWrite.resolve();
    await Promise.all([oldWrite, newWrite]);
    const record = JSON.parse(values.get(NAVIGATION_STATE_STORAGE_KEY)!);
    expect(storage.setItem).toHaveBeenCalledTimes(2);
    expect(record.state.routes[1]).toMatchObject({
      name: 'Transcription',
      params: { meetingId: 'new-meeting' },
    });
  });

  it('places scope clearing after old writes and before the new generation', async () => {
    const values = new Map<string, string>();
    const operations: string[] = [];
    const firstWrite = deferred<void>();
    let setCalls = 0;
    const storage: NavigationStateStorage = {
      getItem: jest.fn(async key => values.get(key) ?? null),
      setItem: jest.fn(async (key, value) => {
        setCalls += 1;
        if (setCalls === 1) await firstWrite.promise;
        operations.push(`set:${JSON.parse(value).authScope}`);
        values.set(key, value);
      }),
      removeItem: jest.fn(async key => {
        operations.push('remove');
        values.delete(key);
      }),
    };
    const writer = new NavigationStateWriter({ storage, debounceMs: 1 });
    writer.activateInitialScope('user:A');
    writer.schedule('user:A', stateAt('EventDetail', 'event-a'));
    const oldWrite = writer.flush();
    await flushMicrotasks();

    const switchScope = writer.switchScope('user:B');
    writer.schedule('user:A', stateAt('EventDetail', 'must-be-ignored'));
    writer.schedule('user:B', stateAt('Transcription', 'meeting-b'));
    const newWrite = writer.flush();
    firstWrite.resolve();
    await Promise.all([oldWrite, switchScope, newWrite]);

    expect(operations).toEqual(['set:user:A', 'remove', 'set:user:B']);
    const record = JSON.parse(values.get(NAVIGATION_STATE_STORAGE_KEY)!);
    expect(record.authScope).toBe('user:B');
    expect(record.state.routes[1].params.meetingId).toBe('meeting-b');
  });

  it('continues with a newer write after an earlier storage failure', async () => {
    const { storage, values } = memoryStorage();
    (storage.setItem as jest.Mock)
      .mockRejectedValueOnce(new Error('disk unavailable'))
      .mockImplementationOnce(async (key: string, value: string) => { values.set(key, value); });
    const writer = new NavigationStateWriter({ storage, debounceMs: 1 });
    writer.activateInitialScope('guest');
    writer.schedule('guest', stateAt('EventDetail', 'first'));
    await expect(writer.flush()).rejects.toThrow('disk unavailable');
    writer.schedule('guest', stateAt('Transcription', 'second'));
    await expect(writer.flush()).resolves.toBeUndefined();
    expect(JSON.parse(values.get(NAVIGATION_STATE_STORAGE_KEY)!).state.routes[1].params.meetingId)
      .toBe('second');
  });
});

describe('navigation state storage reads', () => {
  it('removes a bad record and returns the current scope default', async () => {
    const { storage, values } = memoryStorage();
    values.set(NAVIGATION_STATE_STORAGE_KEY, '{broken-json');
    const result = await readPersistedNavigationState(storage, 'guest', 100);
    expect(result).toEqual({
      state: defaultNavigationState('guest'),
      restored: false,
      failure: 'corrupt',
    });
    expect(storage.removeItem).toHaveBeenCalledWith(NAVIGATION_STATE_STORAGE_KEY);
  });

  it('accepts only a matching unexpired scope record', async () => {
    const { storage, values } = memoryStorage();
    values.set(NAVIGATION_STATE_STORAGE_KEY, JSON.stringify(
      createPersistedNavigationState('guest', stateAt('EventDetail', 'guest-event'), 100),
    ));
    const result = await readPersistedNavigationState(storage, 'guest', 101);
    expect(result.restored).toBe(true);
    expect(result.state.routes[1].name).toBe('EventDetail');
    expect(storage.removeItem).not.toHaveBeenCalled();
  });
});
