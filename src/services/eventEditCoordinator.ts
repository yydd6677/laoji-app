import type { ApiEventEditCommandResponse } from './api';
import type { EventEditTransaction } from './eventEditTransactions';

export type EventEditFailureKind = 'command-missing' | 'permanent' | 'retryable';

export type EventEditCoordinatorResult<TResult> =
  | { status: 'applied'; value: TResult }
  | { status: 'pending' };

export interface EventEditCoordinatorAdapter<TResult> {
  persist: (transactions: EventEditTransaction[]) => Promise<void>;
  execute: (transaction: EventEditTransaction) => Promise<ApiEventEditCommandResponse>;
  recover: (transaction: EventEditTransaction) => Promise<ApiEventEditCommandResponse>;
  apply: (
    transaction: EventEditTransaction,
    response: ApiEventEditCommandResponse,
  ) => Promise<TResult>;
  classifyFailure: (error: unknown, operation: 'execute' | 'recover') => EventEditFailureKind;
  retryDelayMs?: number;
}

export class EventEditCoordinator<TResult> {
  private readonly transactions = new Map<string, EventEditTransaction>();
  private readonly sourceQueues = new Map<string, Promise<void>>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;

  constructor(private readonly adapter: EventEditCoordinatorAdapter<TResult>) {}

  list(): EventEditTransaction[] {
    return [...this.transactions.values()].sort((left, right) => left.createdAt - right.createdAt);
  }

  hydrate(transactions: EventEditTransaction[]): void {
    this.transactions.clear();
    for (const transaction of transactions) this.transactions.set(transaction.id, transaction);
  }

  async begin(transaction: EventEditTransaction): Promise<EventEditCoordinatorResult<TResult>> {
    this.transactions.set(transaction.id, transaction);
    try {
      await this.persist();
    } catch (error) {
      this.transactions.delete(transaction.id);
      throw error;
    }
    return this.converge(transaction.id);
  }

  async resumeAll(): Promise<void> {
    await Promise.all(this.list().map(transaction => (
      this.converge(transaction.id).then(() => undefined).catch(() => undefined)
    )));
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
  }

  private converge(transactionId: string): Promise<EventEditCoordinatorResult<TResult>> {
    const transaction = this.transactions.get(transactionId);
    if (!transaction || this.disposed) return Promise.resolve({ status: 'pending' });
    const sourceKey = transaction.ref.sourceEventId;
    const previous = this.sourceQueues.get(sourceKey) ?? Promise.resolve();
    const result = previous.then(
      () => this.convergeNow(transactionId),
      () => this.convergeNow(transactionId),
    );
    const tail = result.then(() => undefined, () => undefined);
    this.sourceQueues.set(sourceKey, tail);
    return result.finally(() => {
      if (this.sourceQueues.get(sourceKey) === tail) this.sourceQueues.delete(sourceKey);
    });
  }

  private async convergeNow(transactionId: string): Promise<EventEditCoordinatorResult<TResult>> {
    let transaction = this.transactions.get(transactionId);
    if (!transaction || this.disposed) return { status: 'pending' };

    let response: ApiEventEditCommandResponse | null = null;
    if (transaction.phase !== 'pending') {
      try {
        response = await this.adapter.recover(transaction);
      } catch (error) {
        const kind = this.adapter.classifyFailure(error, 'recover');
        if (kind === 'permanent') {
          await this.remove(transactionId);
          throw error;
        }
        if (kind === 'retryable') {
          await this.markRetryable(transactionId, error);
          return { status: 'pending' };
        }
      }
    }

    if (!response) {
      try {
        await this.update(transactionId, current => ({
          ...current,
          phase: 'submitting',
          lastAttemptAt: Date.now(),
          lastError: undefined,
        }));
        transaction = this.transactions.get(transactionId);
        if (!transaction) return { status: 'pending' };
        response = await this.adapter.execute(transaction);
      } catch (error) {
        const kind = this.adapter.classifyFailure(error, 'execute');
        if (kind === 'permanent') {
          await this.remove(transactionId);
          throw error;
        }
        await this.markRetryable(transactionId, error);
        return { status: 'pending' };
      }
    }

    transaction = this.transactions.get(transactionId);
    if (!transaction) return { status: 'pending' };
    try {
      const value = await this.adapter.apply(transaction, response);
      await this.remove(transactionId);
      return { status: 'applied', value };
    } catch (error) {
      await this.markRetryable(transactionId, error);
      return { status: 'pending' };
    }
  }

  private async markRetryable(transactionId: string, error: unknown): Promise<void> {
    await this.update(transactionId, current => ({
      ...current,
      phase: 'retryable',
      lastError: error instanceof Error ? error.message : String(error),
    })).catch(() => undefined);
    this.scheduleRetry(transactionId);
  }

  private async update(
    transactionId: string,
    updater: (current: EventEditTransaction) => EventEditTransaction,
  ): Promise<void> {
    const current = this.transactions.get(transactionId);
    if (!current) return;
    const next = updater(current);
    this.transactions.set(transactionId, next);
    try {
      await this.persist();
    } catch (error) {
      this.transactions.set(transactionId, current);
      throw error;
    }
  }

  private async remove(transactionId: string): Promise<void> {
    const current = this.transactions.get(transactionId);
    if (!current) return;
    this.transactions.delete(transactionId);
    try {
      await this.persist();
      this.clearRetry(transactionId);
    } catch (error) {
      this.transactions.set(transactionId, current);
      this.scheduleRetry(transactionId);
      throw error;
    }
  }

  private persist(): Promise<void> {
    return this.adapter.persist(this.list());
  }

  private scheduleRetry(transactionId: string): void {
    if (this.disposed || this.retryTimers.has(transactionId)) return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(transactionId);
      void this.converge(transactionId).catch(() => undefined);
    }, this.adapter.retryDelayMs ?? 5_000);
    this.retryTimers.set(transactionId, timer);
  }

  private clearRetry(transactionId: string): void {
    const timer = this.retryTimers.get(transactionId);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(transactionId);
  }
}
