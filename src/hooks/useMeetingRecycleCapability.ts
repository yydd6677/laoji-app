import { useCallback } from 'react';

export interface MeetingRecycleCapabilityState {
  retentionDays: number | null;
  loading: boolean;
  refresh: () => Promise<number | null>;
}

export function useMeetingRecycleCapability(): MeetingRecycleCapabilityState {
  const refresh = useCallback(async () => {
    return 30;
  }, []);

  return { retentionDays: 30, loading: false, refresh };
}
