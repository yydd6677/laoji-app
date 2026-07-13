import AsyncStorage from '@react-native-async-storage/async-storage';

type JsonWriteOptions = {
  removeIfEmpty?: boolean;
  bestEffort?: boolean;
};

let clearBarrier: Promise<void> = Promise.resolve();
const keyWriteTails = new Map<string, Promise<void>>();

function settled(operation: Promise<void>): Promise<void> {
  return operation.then(() => undefined, () => undefined);
}

function enqueueKeyWrite(key: string, write: () => Promise<void>): Promise<void> {
  const barrierAtQueueTime = clearBarrier;
  const previousForKey = keyWriteTails.get(key) ?? Promise.resolve();
  const operation = Promise.all([barrierAtQueueTime, previousForKey]).then(write);
  const tail = settled(operation);
  keyWriteTails.set(key, tail);
  void tail.then(() => {
    if (keyWriteTails.get(key) === tail) keyWriteTails.delete(key);
  });
  return operation;
}

function isEmptyCollection(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  return Boolean(value)
    && typeof value === 'object'
    && Object.keys(value as Record<string, unknown>).length === 0;
}

export async function getAppStorageItem(key: string): Promise<string | null> {
  const barrierAtReadTime = clearBarrier;
  const pendingWrite = keyWriteTails.get(key);
  await barrierAtReadTime;
  if (pendingWrite) await pendingWrite;
  return AsyncStorage.getItem(key);
}

export function setAppStorageItem(key: string, value: string): Promise<void> {
  return enqueueKeyWrite(key, () => AsyncStorage.setItem(key, value));
}

export function removeAppStorageItem(key: string): Promise<void> {
  return enqueueKeyWrite(key, () => AsyncStorage.removeItem(key));
}

export function writeAppStorageJson(
  key: string,
  value: unknown,
  options: JsonWriteOptions = {},
): Promise<void> {
  let operation: Promise<void>;
  if (options.removeIfEmpty && isEmptyCollection(value)) {
    operation = removeAppStorageItem(key);
  } else {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return Promise.reject(new TypeError('value is not JSON serializable'));
    operation = setAppStorageItem(key, serialized);
  }
  return options.bestEffort ? settled(operation) : operation;
}

export function clearAppStorage(): Promise<void> {
  const barrierBeforeClear = clearBarrier;
  const writesBeforeClear = [...new Set(keyWriteTails.values())];
  const operation = Promise.all([barrierBeforeClear, ...writesBeforeClear])
    .then(() => AsyncStorage.clear());
  clearBarrier = settled(operation);
  return operation;
}

export async function flushAppStorageOperations(): Promise<void> {
  while (true) {
    const barrier = clearBarrier;
    const tails = [...new Set(keyWriteTails.values())];
    await Promise.all([barrier, ...tails]);
    if (barrier === clearBarrier && tails.every(tail => ![...keyWriteTails.values()].includes(tail))) return;
  }
}

export function resetAppStorageQueueForTests(): void {
  keyWriteTails.clear();
  clearBarrier = Promise.resolve();
}
