import type { EventDeleteTransaction } from './eventDeleteTransactions';

export interface EventStateCommandResult {
  observedState: 'present' | 'absent';
  revision?: number;
}

export interface EventDeleteCoordinatorAdapter {
  persist: (transactions: EventDeleteTransaction[]) => Promise<void>;
  applyAbsent: (transaction: EventDeleteTransaction) => Promise<void> | void;
  applyPresent: (transaction: EventDeleteTransaction) => Promise<void> | void;
  cancelReminders: (transaction: EventDeleteTransaction) => Promise<void>;
  restoreReminders: (transaction: EventDeleteTransaction) => Promise<void>;
  finalizeAbsent?: (transaction: EventDeleteTransaction) => Promise<void>;
  executeDelete: (transaction: EventDeleteTransaction) => Promise<EventStateCommandResult>;
  executeRestore: (transaction: EventDeleteTransaction) => Promise<EventStateCommandResult>;
  isKnownFailure: (error: unknown) => boolean;
  onUndoTarget: (transaction: EventDeleteTransaction | null) => void;
  retryDelayMs?: number;
}

export class EventDeleteCoordinator {
  private readonly transactions = new Map<string, EventDeleteTransaction>();
  private readonly sourceQueues = new Map<string, Promise<void>>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;

  constructor(private readonly adapter: EventDeleteCoordinatorAdapter) {}

  list(): EventDeleteTransaction[] {
    return [...this.transactions.values()];
  }

  async hydrate(transactions: EventDeleteTransaction[]): Promise<void> {
    this.transactions.clear();
    for (const transaction of transactions) this.transactions.set(transaction.id, transaction);
    const undoTarget = transactions
      .filter(transaction => transaction.desiredState === 'absent' && transaction.undoUntil > Date.now())
      .sort((left, right) => right.createdAt - left.createdAt)[0] ?? null;
    this.adapter.onUndoTarget(undoTarget);
  }

  async begin(transaction: EventDeleteTransaction): Promise<void> {
    this.transactions.set(transaction.id, transaction);
    try {
      await this.persist();
    } catch (error) {
      this.transactions.delete(transaction.id);
      throw error;
    }
    await this.adapter.applyAbsent(transaction);
    this.adapter.onUndoTarget(transaction);
    try {
      await this.adapter.cancelReminders(transaction);
    } catch {
      await this.update(transaction.id, current => ({ ...current, reminderDirty: true }));
    }
    await this.converge(transaction.id);
  }

  async undo(transactionId: string): Promise<void> {
    const transaction = this.transactions.get(transactionId);
    if (!transaction) return;
    await this.update(transactionId, current => ({
      ...current,
      desiredState: 'present',
      phase: current.observedState === 'absent' ? 'pending-restore' : current.phase,
      lastError: undefined,
    }));
    await this.converge(transactionId);
  }

  async resumeAll(): Promise<void> {
    await Promise.all(this.list().map(transaction => this.converge(transaction.id)));
  }

  async expire(now = Date.now()): Promise<void> {
    let changed = false;
    for (const transaction of this.list()) {
      if (transaction.desiredState === 'absent'
        && transaction.observedState === 'absent'
        && transaction.undoUntil <= now) {
        await this.adapter.finalizeAbsent?.(transaction);
        this.transactions.delete(transaction.id);
        this.clearRetry(transaction.id);
        changed = true;
      }
    }
    if (changed) await this.persist();
    const latest = this.list()
      .filter(transaction => transaction.desiredState === 'absent' && transaction.undoUntil > now)
      .sort((left, right) => right.createdAt - left.createdAt)[0] ?? null;
    this.adapter.onUndoTarget(latest);
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
  }

  private converge(transactionId: string): Promise<void> {
    const transaction = this.transactions.get(transactionId);
    if (!transaction || this.disposed) return Promise.resolve();
    const sourceKey = transaction.ref.sourceEventId;
    const previous = this.sourceQueues.get(sourceKey) ?? Promise.resolve();
    const result = previous.then(
      () => this.convergeNow(transactionId),
      () => this.convergeNow(transactionId),
    );
    const tail = result.catch(() => undefined);
    this.sourceQueues.set(sourceKey, tail);
    return result.finally(() => {
      if (this.sourceQueues.get(sourceKey) === tail) this.sourceQueues.delete(sourceKey);
    });
  }

  private async convergeNow(transactionId: string): Promise<void> {
    let transaction = this.transactions.get(transactionId);
    if (!transaction || this.disposed) return;

    if (transaction.observedState !== 'absent') {
      await this.update(transactionId, current => ({ ...current, phase: 'deleting' }));
      try {
        const response = await this.adapter.executeDelete(this.transactions.get(transactionId)!);
        await this.update(transactionId, current => ({
          ...current,
          observedState: response.observedState,
          revision: response.revision ?? current.revision,
          restoreExpectedRevision: response.revision ?? current.restoreExpectedRevision,
          phase: 'deleted',
          lastError: undefined,
        }));
      } catch (error) {
        if (this.adapter.isKnownFailure(error)) {
          transaction = this.transactions.get(transactionId);
          if (!transaction) return;
          await this.adapter.applyPresent(transaction);
          this.transactions.delete(transactionId);
          await this.persist();
          this.adapter.onUndoTarget(null);
          throw error;
        }
        await this.update(transactionId, current => ({
          ...current,
          observedState: 'unknown',
          phase: 'retryable',
          lastError: error instanceof Error ? error.message : String(error),
        }));
        this.scheduleRetry(transactionId);
        return;
      }
    }

    transaction = this.transactions.get(transactionId);
    if (!transaction || transaction.desiredState === 'absent') return;
    await this.update(transactionId, current => ({ ...current, phase: 'restoring' }));
    try {
      const response = await this.adapter.executeRestore(this.transactions.get(transactionId)!);
      transaction = this.transactions.get(transactionId);
      if (!transaction) return;
      const restored = {
        ...transaction,
        observedState: response.observedState,
        revision: response.revision ?? transaction.revision,
        phase: 'restored' as const,
        lastError: undefined,
      };
      await this.adapter.applyPresent(restored);
      try {
        await this.adapter.restoreReminders(restored);
      } catch {
        restored.reminderDirty = true;
      }
      this.transactions.delete(transactionId);
      this.clearRetry(transactionId);
      await this.persist();
      this.adapter.onUndoTarget(null);
    } catch (error) {
      await this.update(transactionId, current => ({
        ...current,
        observedState: current.observedState === 'absent' ? 'absent' : 'unknown',
        phase: this.adapter.isKnownFailure(error) ? 'failed' : 'retryable',
        lastError: error instanceof Error ? error.message : String(error),
      }));
      if (!this.adapter.isKnownFailure(error)) this.scheduleRetry(transactionId);
      throw error;
    }
  }

  private async update(
    transactionId: string,
    updater: (current: EventDeleteTransaction) => EventDeleteTransaction,
  ): Promise<void> {
    const current = this.transactions.get(transactionId);
    if (!current) return;
    this.transactions.set(transactionId, updater(current));
    await this.persist();
  }

  private persist(): Promise<void> {
    return this.adapter.persist(this.list());
  }

  private scheduleRetry(transactionId: string): void {
    if (this.disposed || this.retryTimers.has(transactionId)) return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(transactionId);
      void this.converge(transactionId).catch(() => undefined);
    }, this.adapter.retryDelayMs ?? 3_000);
    this.retryTimers.set(transactionId, timer);
  }

  private clearRetry(transactionId: string): void {
    const timer = this.retryTimers.get(transactionId);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(transactionId);
  }
}
