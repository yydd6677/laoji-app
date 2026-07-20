import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  clearAppStorage,
  getAppStorageItem,
  resetAppStorageQueueForTests,
  setAppStorageItem,
} from '../src/services/appStorage';

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
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

describe('appStorage operation ordering', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetAppStorageQueueForTests();
  });

  it('serializes writes to the same key in invocation order', async () => {
    const firstWrite = deferred<void>();
    (AsyncStorage.setItem as jest.Mock)
      .mockImplementationOnce(() => firstWrite.promise)
      .mockResolvedValueOnce(undefined);

    const first = setAppStorageItem('meeting-cache', 'old');
    const second = setAppStorageItem('meeting-cache', 'new');
    await flushMicrotasks();

    expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);
    expect(AsyncStorage.setItem).toHaveBeenNthCalledWith(1, 'meeting-cache', 'old');

    firstWrite.resolve();
    await first;
    await second;

    expect(AsyncStorage.setItem).toHaveBeenNthCalledWith(2, 'meeting-cache', 'new');
  });

  it('waits for prior writes before clear and delays later writes until clear completes', async () => {
    const firstWrite = deferred<void>();
    const clearing = deferred<void>();
    (AsyncStorage.setItem as jest.Mock)
      .mockImplementationOnce(() => firstWrite.promise)
      .mockResolvedValueOnce(undefined);
    (AsyncStorage.clear as jest.Mock).mockImplementationOnce(() => clearing.promise);

    const beforeClear = setAppStorageItem('guest-events', 'before');
    const clear = clearAppStorage();
    const afterClear = setAppStorageItem('guest-events', 'after');
    await flushMicrotasks();

    expect(AsyncStorage.clear).not.toHaveBeenCalled();
    expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);

    firstWrite.resolve();
    await beforeClear;
    await flushMicrotasks();
    expect(AsyncStorage.clear).toHaveBeenCalledTimes(1);
    expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);

    clearing.resolve();
    await clear;
    await afterClear;
    expect(AsyncStorage.setItem).toHaveBeenNthCalledWith(2, 'guest-events', 'after');
  });

  it('does not read a key before its queued write settles', async () => {
    const writing = deferred<void>();
    (AsyncStorage.setItem as jest.Mock).mockImplementationOnce(() => writing.promise);
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('saved');

    const write = setAppStorageItem('profile', 'saved');
    const read = getAppStorageItem('profile');
    await flushMicrotasks();
    expect(AsyncStorage.getItem).not.toHaveBeenCalled();

    writing.resolve();
    await write;
    await expect(read).resolves.toBe('saved');
  });
});
