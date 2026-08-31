import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import {
  clearNativeUpcomingEventsProjection,
  writeNativeUpcomingEventsProjection,
} from 'laoji-native-platform';
import { useEvents } from '../store/EventsStore';
import { useMeetings } from '../store/MeetingsStore';
import type { PrivacyPrefs } from '../services/privacy';
import {
  loadPrivacyPrefs,
  subscribePrivacyPrefs,
} from '../services/privacy';
import { resolveOccurrenceMeeting } from '../services/occurrenceMeeting';
import { buildUpcomingEventsProjection } from '../services/upcomingEventsProjection';
import type { ScopeKey } from '../domain/meeting';
import { diagnosticWarn } from '../services/diagnostics';

export function UpcomingEventsProjectionCoordinator() {
  const { events, searchableEvents, hydratedScope } = useEvents();
  const { meetings } = useMeetings();
  const scopeKey: ScopeKey = 'guest';
  const [privacy, setPrivacy] = useState<{ scope: ScopeKey; value: PrivacyPrefs } | null>(null);
  const [foregroundRevision, setForegroundRevision] = useState(0);

  useEffect(() => {
    let active = true;
    const unsubscribe = subscribePrivacyPrefs(scopeKey, value => {
      if (active) setPrivacy({ scope: scopeKey, value });
    });
    void loadPrivacyPrefs(scopeKey)
      .then(value => {
        if (active) setPrivacy({ scope: scopeKey, value });
      })
      .catch(error => diagnosticWarn('load widget privacy projection failed', error));
    return () => {
      active = false;
      unsubscribe();
    };
  }, [scopeKey]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') setForegroundRevision(value => value + 1);
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (hydratedScope !== scopeKey || privacy?.scope !== scopeKey) {
      void clearNativeUpcomingEventsProjection().catch(() => undefined);
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      void buildUpcomingEventsProjection({
        scopeKey,
        events,
        searchableEvents,
        hideTitles: privacy.value.appLockEnabled && privacy.value.hideWidgetTitles,
        resolveMeetingAction: async ref => (
          (await resolveOccurrenceMeeting(scopeKey, ref))?.action ?? 'start'
        ),
      })
        .then(projection => {
          if (active) return writeNativeUpcomingEventsProjection(projection);
          return undefined;
        })
        .catch(error => diagnosticWarn('write upcoming event projection failed', error));
    }, 60);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [
    events,
    foregroundRevision,
    hydratedScope,
    meetings,
    privacy,
    scopeKey,
    searchableEvents,
  ]);

  return null;
}
