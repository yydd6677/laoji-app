import { useEffect } from 'react';
import { useEvents } from '../store/EventsStore';
import { useMeetings } from '../store/MeetingsStore';
import {
  flushPendingNotificationNavigation,
  installNotificationNavigationListener,
  installSemanticLinkNavigationListener,
  setNotificationNavigationScope,
  setNotificationEventResolver,
  setNotificationMeetingResolver,
  setNotificationOccurrenceMeetingResolver,
  setQuickTileMeetingResolver,
} from '../navigation/notificationNavigation';
import { openOccurrenceMeeting } from '../application/meeting';
import { isScopeKey } from '../domain/meeting';
import { diagnosticWarn } from '../services/diagnostics';
import { getNativeRecorderState } from 'laoji-native-platform';
import { setOccurrenceMeetingLinkState } from '../services/meetingOccurrenceLifecycle';

export function NotificationNavigationHandler() {
  const { hydratedScope, resolveEventRef } = useEvents();
  const {
    createMeeting,
    meetings,
    loading: meetingsLoading,
  } = useMeetings();
  const scope = 'guest';

  useEffect(() => {
    const removeNotificationListener = installNotificationNavigationListener();
    const removeSemanticLinkListener = installSemanticLinkNavigationListener();
    return () => {
      removeSemanticLinkListener();
      removeNotificationListener();
    };
  }, []);

  useEffect(() => {
    setNotificationEventResolver(async ref => (await resolveEventRef(ref)).status);
    return () => setNotificationEventResolver(null);
  }, [resolveEventRef]);

  useEffect(() => {
    setNotificationMeetingResolver(async meetingId => {
      if (meetings.some(meeting => meeting.id === meetingId)) return 'found';
      return meetingsLoading ? 'retryable' : 'not-found';
    });
    return () => setNotificationMeetingResolver(null);
  }, [meetings, meetingsLoading]);

  useEffect(() => {
    if (!scope || !isScopeKey(scope)) {
      setNotificationOccurrenceMeetingResolver(null);
      return;
    }
    setNotificationOccurrenceMeetingResolver(async (ref, entryPoint) => {
      const resolution = await resolveEventRef(ref);
      if (resolution.status !== 'found') return { status: resolution.status };
      try {
        await setOccurrenceMeetingLinkState({
          scopeKey: scope,
          occurrence: ref,
          selection: 'occurrence',
          state: 'active',
        });
        const target = await openOccurrenceMeeting({
          scopeKey: scope,
          event: resolution.event,
          entryPoint,
          createMeeting,
        });
        return { status: 'found', target };
      } catch (error) {
        diagnosticWarn('open occurrence meeting from notification failed', error);
        return { status: 'retryable' };
      }
    });
    return () => setNotificationOccurrenceMeetingResolver(null);
  }, [createMeeting, resolveEventRef, scope]);

  useEffect(() => {
    setQuickTileMeetingResolver(async () => {
      const recorder = await getNativeRecorderState().catch(() => null);
      if (
        recorder?.purpose === 'meeting'
        && ['preparing', 'recording', 'paused'].includes(recorder.state)
      ) {
        if (!meetings.some(meeting => meeting.id === recorder.sessionId)) {
          return { status: meetingsLoading ? 'retryable' : 'not-found' };
        }
        return {
          status: 'found',
          params: {
            meetingId: recorder.sessionId,
            startRequested: false,
            entryPoint: 'quick_tile',
          },
        };
      }
      return {
        status: 'found',
        params: { startRequested: true, entryPoint: 'quick_tile' },
      };
    });
    return () => setQuickTileMeetingResolver(null);
  }, [meetings, meetingsLoading]);

  useEffect(() => {
    setNotificationNavigationScope(scope);
    if (hydratedScope !== scope) return;
    const timer = setTimeout(() => {
      void flushPendingNotificationNavigation();
    }, 0);
    return () => clearTimeout(timer);
  }, [hydratedScope, scope]);

  return null;
}
