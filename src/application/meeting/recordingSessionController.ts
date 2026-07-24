export interface RecordingSessionHandle<Result> {
  meetingId: string;
  sessionId: string;
  finalize: () => Promise<Result>;
}

export interface RecordingSessionFinalization<Session, Result> {
  session: Session;
  result: Result;
  navigateAfter: boolean;
}

/**
 * ANDR-01: owns only JS orchestration identity and idempotency. Android remains
 * the source of truth for capture state, audio bytes, journal and recovery.
 */
export class RecordingSessionController<
  Result,
  Session extends RecordingSessionHandle<Result> = RecordingSessionHandle<Result>,
> {
  private active: Session | null = null;
  private startToken: number | null = null;
  private startSequence = 0;
  private finalization: Promise<RecordingSessionFinalization<Session, Result>> | null = null;
  private navigateAfterFinalization = false;

  current(): Session | null {
    return this.active;
  }

  isStarting(): boolean {
    return this.startToken !== null;
  }

  isFinalizing(): boolean {
    return this.finalization !== null;
  }

  beginStart(): number | null {
    if (this.startToken !== null || this.active || this.finalization) return null;
    this.startSequence = Math.min(Number.MAX_SAFE_INTEGER, this.startSequence + 1);
    this.startToken = this.startSequence;
    return this.startToken;
  }

  completeStart(token: number, session: Session): boolean {
    if (this.startToken !== token || this.active || this.finalization) return false;
    this.startToken = null;
    this.active = session;
    return true;
  }

  abandonStart(token: number): void {
    if (this.startToken === token) this.startToken = null;
  }

  attachRecovered(session: Session): boolean {
    if (this.startToken !== null || this.finalization) return false;
    if (this.active && this.active.sessionId !== session.sessionId) return false;
    this.active = session;
    return true;
  }

  finalizeActive(
    navigateAfter: boolean,
  ): Promise<RecordingSessionFinalization<Session, Result>> | null {
    this.navigateAfterFinalization ||= navigateAfter;
    if (this.finalization) return this.finalization;
    const session = this.active;
    if (!session) {
      this.navigateAfterFinalization = false;
      return null;
    }

    let operation: Promise<RecordingSessionFinalization<Session, Result>>;
    operation = Promise.resolve()
      .then(() => session.finalize())
      .then(result => {
        if (this.active === session) this.active = null;
        const shouldNavigate = this.navigateAfterFinalization;
        this.navigateAfterFinalization = false;
        return { session, result, navigateAfter: shouldNavigate };
      })
      .finally(() => {
        if (this.finalization === operation) this.finalization = null;
      });
    this.finalization = operation;
    return operation;
  }
}
