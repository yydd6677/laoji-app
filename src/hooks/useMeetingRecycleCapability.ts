import { useCallback, useEffect, useState } from 'react';
import { getFeatureFlags } from '../config/featureFlags';
import { useAuth } from '../store/AuthStore';
import { probeMeetingRecycleCapability } from '../services/meetingRecycleCapability';

export interface MeetingRecycleCapabilityState {
  retentionDays: number | null;
  loading: boolean;
  refresh: () => Promise<number | null>;
}

export function useMeetingRecycleCapability(): MeetingRecycleCapabilityState {
  const { accessToken, isGuest } = useAuth();
  const [retentionDays, setRetentionDays] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (isGuest) {
      if (!getFeatureFlags().localMeetingDbCanonicalWriteV1) {
        setRetentionDays(null);
        return null;
      }
      setRetentionDays(30);
      return 30;
    }
    if (!accessToken || !getFeatureFlags().localMeetingDbAccountRootWriteV1) {
      setRetentionDays(null);
      return null;
    }
    setLoading(true);
    try {
      const capability = await probeMeetingRecycleCapability(accessToken, { forceRefresh: true });
      setRetentionDays(capability.retentionDays);
      return capability.retentionDays;
    } catch (error) {
      setRetentionDays(null);
      throw error;
    } finally {
      setLoading(false);
    }
  }, [accessToken, isGuest]);

  useEffect(() => {
    let alive = true;
    if (isGuest && getFeatureFlags().localMeetingDbCanonicalWriteV1) {
      setRetentionDays(30);
      setLoading(false);
      return () => { alive = false; };
    }
    if (!accessToken || !getFeatureFlags().localMeetingDbAccountRootWriteV1) {
      setRetentionDays(null);
      setLoading(false);
      return () => { alive = false; };
    }
    setLoading(true);
    void probeMeetingRecycleCapability(accessToken, { forceRefresh: true })
      .then(capability => {
        if (alive) setRetentionDays(capability.retentionDays);
      })
      .catch(() => {
        if (alive) setRetentionDays(null);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => { alive = false; };
  }, [accessToken, isGuest]);

  return { retentionDays, loading, refresh };
}
