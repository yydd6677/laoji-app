import React, { useEffect } from 'react';
import * as SplashScreen from 'expo-splash-screen';
import { useAuth } from '../store/AuthStore';
import { useNavigationStateRestoration } from '../navigation/NavigationStateCoordinator';

void SplashScreen.preventAutoHideAsync().catch(() => {});

export function AppReadinessGate({ children }: { children: React.ReactNode }) {
  const { initializing } = useAuth();
  const { ready: navigationReady } = useNavigationStateRestoration();

  useEffect(() => {
    if (!initializing && navigationReady) void SplashScreen.hideAsync().catch(() => {});
  }, [initializing, navigationReady]);

  if (initializing || !navigationReady) return null;
  return <>{children}</>;
}
