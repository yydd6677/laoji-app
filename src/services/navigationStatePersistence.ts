import {
  getAppStorageItem,
  removeAppStorageItem,
  setAppStorageItem,
} from './appStorage';
import {
  createPersistedNavigationState,
  defaultNavigationState,
  parsePersistedNavigationState,
  type NavigationAuthScope,
  type NavigationRestoreResult,
} from './navigationState';

export const NAVIGATION_STATE_STORAGE_KEY = '@laoji:navigationState:v1';
export const NAVIGATION_STATE_WRITE_DEBOUNCE_MS = 200;

export interface NavigationStateStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export const appNavigationStateStorage: NavigationStateStorage = {
  getItem: getAppStorageItem,
  setItem: setAppStorageItem,
  removeItem: removeAppStorageItem,
};

export async function readPersistedNavigationState(
  storage: NavigationStateStorage,
  scope: NavigationAuthScope,
  now = Date.now(),
): Promise<NavigationRestoreResult> {
  let raw: string | null;
  try {
    raw = await storage.getItem(NAVIGATION_STATE_STORAGE_KEY);
  } catch {
    return { state: defaultNavigationState(scope), restored: false, failure: 'corrupt' };
  }

  const result = parsePersistedNavigationState(raw, scope, now);
  if (result.failure && result.failure !== 'missing') {
    await storage.removeItem(NAVIGATION_STATE_STORAGE_KEY).catch(() => undefined);
  }
  return result;
}

type PendingWrite = {
  generation: number;
  scope: NavigationAuthScope;
  serialized: string;
};

type WriterOptions = {
  storage?: NavigationStateStorage;
  debounceMs?: number;
  now?: () => number;
};

/** Serializes navigation writes so a prior route or auth generation cannot win a race. */
export class NavigationStateWriter {
  private readonly storage: NavigationStateStorage;
  private readonly debounceMs: number;
  private readonly now: () => number;
  private activeScope: NavigationAuthScope | null = null;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: PendingWrite | null = null;
  private tail: Promise<void> = Promise.resolve();

  constructor(options: WriterOptions = {}) {
    this.storage = options.storage ?? appNavigationStateStorage;
    this.debounceMs = options.debounceMs ?? NAVIGATION_STATE_WRITE_DEBOUNCE_MS;
    this.now = options.now ?? Date.now;
  }

  activateInitialScope(scope: NavigationAuthScope): void {
    if (this.activeScope === scope) return;
    this.beginGeneration(scope);
  }

  switchScope(scope: NavigationAuthScope): Promise<void> {
    if (this.activeScope === scope) return this.tail;
    this.beginGeneration(scope);
    return this.enqueue(() => this.storage.removeItem(NAVIGATION_STATE_STORAGE_KEY));
  }

  restore(scope: NavigationAuthScope): Promise<NavigationRestoreResult> {
    if (this.activeScope !== scope) this.activateInitialScope(scope);
    const generation = this.generation;
    return this.enqueueResult(async () => {
      if (generation !== this.generation || scope !== this.activeScope) {
        return { state: defaultNavigationState(scope), restored: false, failure: 'scope' };
      }
      return readPersistedNavigationState(this.storage, scope, this.now());
    });
  }

  schedule(scope: NavigationAuthScope, state: unknown): void {
    if (scope !== this.activeScope) return;
    const record = createPersistedNavigationState(scope, state, this.now());
    this.pending = {
      generation: this.generation,
      scope,
      serialized: JSON.stringify(record),
    };
    this.cancelTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush().catch(() => undefined);
    }, this.debounceMs);
  }

  flush(): Promise<void> {
    this.cancelTimer();
    const pending = this.pending;
    this.pending = null;
    if (!pending) return this.tail;
    return this.enqueue(async () => {
      if (pending.generation !== this.generation || pending.scope !== this.activeScope) return;
      await this.storage.setItem(NAVIGATION_STATE_STORAGE_KEY, pending.serialized);
    });
  }

  waitForIdle(): Promise<void> {
    return this.tail;
  }

  private beginGeneration(scope: NavigationAuthScope): void {
    this.generation += 1;
    this.activeScope = scope;
    this.pending = null;
    this.cancelTimer();
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private enqueueResult<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
