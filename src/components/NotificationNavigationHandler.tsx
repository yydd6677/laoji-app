import { useEffect } from 'react';
import { useAuth } from '../store/AuthStore';
import { useEvents } from '../store/EventsStore';
import {
  flushPendingNotificationNavigation,
  installNotificationNavigationListener,
  setNotificationNavigationScope,
  setNotificationEventResolver,
} from '../navigation/notificationNavigation';

export function NotificationNavigationHandler() {
  const { initializing, mode, session } = useAuth();
  const { hydratedScope, resolveEventRef } = useEvents();
  const scope = mode === 'guest'
    ? 'guest'
    : mode === 'authenticated' && session ? `user:${session.user.id}` : null;

  useEffect(() => installNotificationNavigationListener(), []);

  useEffect(() => {
    setNotificationEventResolver(async ref => (await resolveEventRef(ref)).status);
    return () => setNotificationEventResolver(null);
  }, [resolveEventRef]);

  useEffect(() => {
    if (initializing) return;
    setNotificationNavigationScope(scope);
    if (!scope || hydratedScope !== scope) return;
    const timer = setTimeout(() => {
      void flushPendingNotificationNavigation();
    }, 0);
    return () => clearTimeout(timer);
  }, [hydratedScope, initializing, scope]);

  return null;
}
