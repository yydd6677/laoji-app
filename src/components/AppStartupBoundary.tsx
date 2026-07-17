import React from 'react';
import {
  AppStartupStateView,
  releaseNativeSplash,
  type AppStartupFailureStage,
} from './AppStartupStateView';
import { diagnosticWarn } from '../services/diagnostics';

export class AppStartupError extends Error {
  readonly stage: AppStartupFailureStage;
  readonly originalCause: unknown;

  constructor(stage: AppStartupFailureStage, message: string, originalCause?: unknown) {
    super(message);
    this.name = 'AppStartupError';
    this.stage = stage;
    this.originalCause = originalCause;
  }
}

type BoundaryProps = {
  children: React.ReactNode;
  feishuEvidence?: string;
  resetKey: number;
  onRetry: () => void;
};

type BoundaryState = {
  error: Error | null;
};

export class AppStartupBoundary extends React.Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error): void {
    diagnosticWarn('app startup failed', error);
    void releaseNativeSplash();
  }

  componentDidUpdate(previousProps: BoundaryProps): void {
    if (previousProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    const { error } = this.state;
    if (error) {
      return (
        <AppStartupStateView
          feishuEvidence="feishu:UI-BOOT-READINESS-001:boundary-error-surface"
          phase="error"
          failureStage={error instanceof AppStartupError ? error.stage : 'runtime'}
          onRetry={this.props.onRetry}
        />
      );
    }
    return this.props.children;
  }
}
