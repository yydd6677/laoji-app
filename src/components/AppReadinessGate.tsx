import React, { useEffect, useRef, useState } from 'react';
import * as SplashScreen from 'expo-splash-screen';
import { useAuth } from '../store/AuthStore';
import { useNavigationStateRestoration } from '../navigation/NavigationStateCoordinator';
import {
  AppStartupStateView,
  releaseNativeSplash,
} from './AppStartupStateView';

export const APP_READINESS_TIMEOUT_MS = 8_000;

function holdNativeSplash(): void {
  try {
    void Promise.resolve(SplashScreen.preventAutoHideAsync()).catch(() => undefined);
  } catch {
    // The React loading surface is the fallback when the native splash API is unavailable.
  }
}

holdNativeSplash();

export function AppReadinessGate({
  children,
  onRetry,
  timeoutMs = APP_READINESS_TIMEOUT_MS,
}: {
  children: React.ReactNode;
  feishuEvidence?: string;
  onRetry?: () => void;
  timeoutMs?: number;
}) {
  // UI-BOOT-READINESS-001 owns one deadline across auth and navigation restoration.
  const { initializing } = useAuth();
  const { ready: navigationReady } = useNavigationStateRestoration();
  const [timedOut, setTimedOut] = useState(false);
  const deadlineRef = useRef<number | null>(null);
  if (deadlineRef.current === null) deadlineRef.current = Date.now() + Math.max(0, timeoutMs);
  const ready = !initializing && navigationReady;

  useEffect(() => {
    void releaseNativeSplash();
  }, []);

  useEffect(() => {
    if (ready) {
      setTimedOut(false);
      return undefined;
    }
    const remaining = Math.max(0, (deadlineRef.current ?? Date.now()) - Date.now());
    const timer = setTimeout(() => setTimedOut(true), remaining);
    return () => clearTimeout(timer);
  }, [ready]);

  if (ready) return <>{children}</>;
  if (timedOut) {
    return (
      <AppStartupStateView
        feishuEvidence="feishu:UI-BOOT-READINESS-001:timeout-error-surface"
        phase="error"
        failureStage={initializing ? 'authentication' : 'navigation'}
        onRetry={onRetry}
      />
    );
  }
  return <AppStartupStateView phase="loading" />;
}
