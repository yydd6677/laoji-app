import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';

const systemClock = () => new Date();

export function startOfLocalDate(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

export function millisecondsUntilNextLocalDate(value: Date): number {
  const next = new Date(value.getFullYear(), value.getMonth(), value.getDate() + 1);
  return Math.max(1, next.getTime() - value.getTime() + 50);
}

export function useCurrentDate(clock: () => Date = systemClock): Date {
  const [currentDate, setCurrentDate] = useState(() => startOfLocalDate(clock()));
  const refresh = useCallback(() => {
    const next = startOfLocalDate(clock());
    setCurrentDate(current => current.getTime() === next.getTime() ? current : next);
  }, [clock]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleMidnightRefresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        refresh();
        scheduleMidnightRefresh();
      }, millisecondsUntilNextLocalDate(clock()));
    };
    scheduleMidnightRefresh();
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') return;
      refresh();
      scheduleMidnightRefresh();
    });
    return () => {
      if (timer) clearTimeout(timer);
      subscription.remove();
    };
  }, [clock, refresh]);

  return currentDate;
}
