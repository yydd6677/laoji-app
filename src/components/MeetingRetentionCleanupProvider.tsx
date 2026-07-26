import React, { useEffect } from 'react';
import { AppState } from 'react-native';
import { getFeatureFlags } from '../config/featureFlags';
import type { ScopeKey } from '../domain/meeting';
import { diagnosticWarn } from '../services/diagnostics';
import { requireFreshMeetingRecycleCapability } from '../services/meetingRecycleCapability';
import {
  drainMeetingRetentionCleanup,
  runMeetingRetentionCleanup,
} from '../services/meetingRetentionCleanup';
import { useAuth } from '../store/AuthStore';

const FOREGROUND_RECHECK_MS = 6 * 60 * 60 * 1_000;

export function MeetingRetentionCleanupProvider({ children }: { children: React.ReactNode }) {
  const { mode, session, accessToken } = useAuth();
  const userId = session?.user.id ?? null;

  useEffect(() => {
    if (
      !getFeatureFlags().localMeetingDbAccountRootWriteV1
      || mode !== 'authenticated'
      || !accessToken
      || userId === null
    ) return undefined;
    const scopeKey = `user:${userId}` as ScopeKey;
    let active = true;
    let running = false;
    let requested = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const clearTimer = () => {
      if (!timer) return;
      clearTimeout(timer);
      timer = null;
    };
    const requestRun = () => {
      if (!active) return;
      requested = true;
      clearTimer();
      if (running) return;
      running = true;
      void (async () => {
        try {
          while (active && requested) {
            requested = false;
            await drainMeetingRetentionCleanup(scopeKey);
            if (!active) break;
            const retentionDays = await requireFreshMeetingRecycleCapability(accessToken);
            if (!active) break;
            await runMeetingRetentionCleanup({ scopeKey, retentionDays });
          }
        } catch (reason) {
          if (active) diagnosticWarn('[meeting-retention] cleanup deferred', reason);
        } finally {
          running = false;
          if (active && requested) {
            requestRun();
          } else if (active) {
            timer = setTimeout(requestRun, FOREGROUND_RECHECK_MS);
          }
        }
      })();
    };

    const subscription = AppState.addEventListener('change', nextState => {
      if (nextState === 'active') requestRun();
    });
    requestRun();
    return () => {
      active = false;
      requested = false;
      clearTimer();
      subscription.remove();
    };
  }, [accessToken, mode, userId]);

  return <>{children}</>;
}
