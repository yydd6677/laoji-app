import React, { useEffect } from 'react';
import * as SplashScreen from 'expo-splash-screen';
import { useAuth } from '../store/AuthStore';

void SplashScreen.preventAutoHideAsync().catch(() => {});

export function AppReadinessGate({ children }: { children: React.ReactNode }) {
  const { initializing } = useAuth();

  useEffect(() => {
    if (!initializing) void SplashScreen.hideAsync().catch(() => {});
  }, [initializing]);

  if (initializing) return null;
  return <>{children}</>;
}
