import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  LaojiCalendarView,
  addNativeWindowOverlayActionListener,
  createNativeOverlayOwnerId,
  dismissNativeWindowOverlay,
  presentNativeWindowOverlay,
  type NativeCalendarCreateEvent,
  type NativeCalendarMutationRequest,
  type NativeCalendarMutationResolution,
  type NativeProjectionEnvelope,
  type NativeCalendarSemanticEvent,
  type NativeCalendarVisibleRangeEvent,
  type NativeCalendarSearchAction,
  type NativeTabPressEvent,
  type NativeWindowOverlayEvent,
} from 'laoji-native-platform';
import { AppActionSheet } from '../components/AppActionSheet';
import { VoiceInputModal } from '../components/VoiceInputModal';
import { useAppDialog } from '../components/AppDialog';
import { useEvents } from '../store/EventsStore';
import type { CalEvent, EventRecurrenceScope, RootStackParamList } from '../types';
import {
  buildNativeCalendarRangeSnapshot,
  calendarDateFromEpochDay,
  calendarEpochDay,
  localCalendarDate,
  calendarTimeFromMinutes,
  nativeCalendarMutationChanges,
} from '../native/calendarSnapshot';
import { eventRefForEvent, sameEventRef } from '../utils/eventIdentity';
import { recurrenceEditDialog } from '../services/recurrenceActions';
import { readableErrorMessage } from '../services/errors';
import { buildNativeCalendarSearchSnapshot } from '../native/nativeCalendarPages';
import { useCurrentDate } from '../hooks/useCurrentDate';
import { useLocalProfile } from '../store/LocalProfileStore';
import { buildNativeProfileEntrySnapshot } from '../native/profileEntrySnapshot';
import { Colors as C } from '../theme/colors';
import { useNativeProjection } from '../native/useNativeProjection';
import { fenceNativeProjectionAction } from '../native/projectionActionFence';
import { diagnosticAudit } from '../services/diagnostics';

type ScheduleNavigationProp = NativeStackNavigationProp<RootStackParamList>;
type Props = {
  navigation: ScheduleNavigationProp;
  onTabPress: (event: { nativeEvent: NativeTabPressEvent }) => void;
  // UI-SHELL-BOTTOM-MAIN-001: destination-change motion for the active native root.
  bottomBarSelectionCommand: number;
};

type EpochRange = { start: number; endExclusive: number };

function initialCalendarRange(today: number): EpochRange {
  const date = new Date(today * 86_400_000);
  const monthStart = calendarEpochDay(
    `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-01`,
  );
  const gridStart = monthStart - new Date(monthStart * 86_400_000).getUTCDay();
  return { start: gridStart - 42, endExclusive: gridStart + 84 };
}

function monthsInRange(range: EpochRange): Array<{ year: number; month: number }> {
  const values: Array<{ year: number; month: number }> = [];
  const seen = new Set<string>();
  for (let day = range.start; day < range.endExclusive;) {
    const value = new Date(day * 86_400_000);
    const year = value.getUTCFullYear();
    const month = value.getUTCMonth() + 1;
    const key = `${year}-${month}`;
    if (!seen.has(key)) {
      seen.add(key);
      values.push({ year, month });
    }
    day = calendarEpochDay(
      `${month === 12 ? year + 1 : year}-${String(month === 12 ? 1 : month + 1).padStart(2, '0')}-01`,
    );
  }
  return values.slice(0, 6);
}

/** CAL-ROOT-001: Android calendar is a native surface fed only with repository snapshots. */
export function ScheduleScreen({
  navigation,
  onTabPress,
  bottomBarSelectionCommand,
}: Props) {
  const {
    events,
    searchableEvents,
    refreshEvents,
    updateEvent,
  } = useEvents();
  const { profile } = useLocalProfile();
  const { showDialog } = useAppDialog();
  const currentDate = useCurrentDate();
  const today = useMemo(() => calendarEpochDay(localCalendarDate(currentDate)), [currentDate]);
  const [selectedEpochDay, setSelectedEpochDay] = useState(today);
  const [visibleRange, setVisibleRange] = useState<EpochRange>(() => initialCalendarRange(today));
  const [mode, setMode] = useState<'month' | 'day'>('month');
  const [mutationResolution, setMutationResolution] = useState<NativeCalendarMutationResolution | null>(null);
  const [createMenuVisible, setCreateMenuVisible] = useState(false);
  const [voiceVisible, setVoiceVisible] = useState(false);
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const generationRef = useRef(0);
  const currentProjectionRef = useRef<NativeProjectionEnvelope | null>(null);
  const searchOwnerId = useMemo(() => createNativeOverlayOwnerId('calendar-search'), []);
  const profileEntry = useMemo(
    () => buildNativeProfileEntrySnapshot(profile, true),
    [profile.avatarLocalUri, profile.avatarUrl, profile.nickname],
  );

  useEffect(() => {
    let active = true;
    void (async () => {
      for (const { year, month } of monthsInRange(visibleRange)) {
        if (!active) return;
        await refreshEvents(year, month);
      }
    })();
    return () => { active = false; };
  }, [refreshEvents, visibleRange.endExclusive, visibleRange.start]);

  const snapshotBody = useMemo(() => {
    generationRef.current += 1;
    return buildNativeCalendarRangeSnapshot({
      generation: generationRef.current,
      rangeStart: calendarDateFromEpochDay(visibleRange.start),
      rangeEndExclusive: calendarDateFromEpochDay(visibleRange.endExclusive),
      selectedDate: calendarDateFromEpochDay(selectedEpochDay),
      today: calendarDateFromEpochDay(today),
      events,
    });
  }, [events, selectedEpochDay, today, visibleRange.endExclusive, visibleRange.start]);
  const snapshot = useNativeProjection(snapshotBody, {
    entityId: 'calendar',
    surfaceKey: 'calendar',
  });
  currentProjectionRef.current = snapshot.projection ?? null;

  const chooseEditScope = useCallback((event: CalEvent): Promise<EventRecurrenceScope | null> => {
    if (!event.repeat || event.repeat === 'once') return Promise.resolve('series');
    return new Promise(resolve => {
      let settled = false;
      const finish = (scope: EventRecurrenceScope | null) => {
        if (settled) return;
        settled = true;
        resolve(scope);
      };
      showDialog(recurrenceEditDialog(event, finish, () => finish(null)));
    });
  }, [showDialog]);

  const handleMutation = useCallback(async (mutation: NativeCalendarMutationRequest) => {
    const projectionFence = fenceNativeProjectionAction(
      currentProjectionRef.current,
      mutation.projection,
    );
    if (!projectionFence.accepted) {
      diagnosticAudit('native_projection_action_rejected', {
        surface: 'calendar',
        action_type: 'mutation',
        reason: projectionFence.reason,
      });
      setMutationResolution({
        operationId: mutation.operationId,
        accepted: false,
        message: '日程页面已更新，请重新操作。',
      });
      return;
    }
    const targetRef = {
      sourceEventId: mutation.sourceEventId,
      occurrenceDate: mutation.occurrenceDate,
    };
    const target = events.find(event => sameEventRef(eventRefForEvent(event), targetRef));
    if (!target) {
      setMutationResolution({ operationId: mutation.operationId, accepted: false, message: '日程已变化，请刷新后重试。' });
      return;
    }
    try {
      const scope = await chooseEditScope(target);
      if (!scope) {
        setMutationResolution({ operationId: mutation.operationId, accepted: false, message: '已取消修改。' });
        return;
      }
      const changes = nativeCalendarMutationChanges(mutation);
      await updateEvent(targetRef, changes, scope);
      setMutationResolution({ operationId: mutation.operationId, accepted: true });
    } catch (error) {
      setMutationResolution({
        operationId: mutation.operationId,
        accepted: false,
        message: readableErrorMessage(error, '修改失败，原日程时间已保留。'),
      });
    }
  }, [chooseEditScope, events, updateEvent]);

  const openCreate = useCallback((draft?: NativeCalendarCreateEvent, epochDay = selectedEpochDay) => {
    navigation.navigate('AddEvent', draft ? {
      date: calendarDateFromEpochDay(draft.startEpochDay),
      endDate: calendarDateFromEpochDay(draft.endEpochDay + (draft.endMinutes === 1440 ? 1 : 0)),
      startTime: calendarTimeFromMinutes(draft.startMinutes),
      endTime: calendarTimeFromMinutes(draft.endMinutes),
    } : { date: calendarDateFromEpochDay(epochDay) });
  }, [navigation, selectedEpochDay]);

  const handleSemantic = useCallback((event: NativeCalendarSemanticEvent) => {
    switch (event.type) {
      case 'settings-open':
        navigation.navigate('Privacy');
        break;
      case 'search-open':
        setSearchVisible(true);
        break;
      case 'create-menu':
        setCreateMenuVisible(true);
        break;
      case 'create-voice':
        setVoiceVisible(true);
        break;
      case 'create-manual':
        openCreate(undefined, typeof event.epochDay === 'number' ? event.epochDay : selectedEpochDay);
        break;
      default:
        break;
    }
  }, [navigation, openCreate, selectedEpochDay]);

  const handleVisibleRange = (event: NativeCalendarVisibleRangeEvent) => {
    setSelectedEpochDay(event.selectedEpochDay);
    setVisibleRange({
      start: event.rangeStartEpochDay - 42,
      endExclusive: event.rangeEndEpochDayExclusive + 42,
    });
  };

  const searchSnapshot = useMemo(
    () => buildNativeCalendarSearchSnapshot(searchableEvents, searchQuery),
    [searchQuery, searchableEvents],
  );

  const handleSearchAction = useCallback((action: NativeCalendarSearchAction) => {
    switch (action.type) {
      case 'close':
        setSearchQuery('');
        setSearchVisible(false);
        break;
      case 'queryChange':
        setSearchQuery(action.query);
        break;
      case 'openEvent':
        setSearchQuery('');
        setSearchVisible(false);
        navigation.navigate('EventDetail', {
          eventRef: { sourceEventId: action.sourceEventId, occurrenceDate: action.occurrenceDate },
        });
        break;
      default:
        break;
    }
  }, [navigation]);

  useEffect(() => {
    const subscription = addNativeWindowOverlayActionListener((event: NativeWindowOverlayEvent) => {
      if (event.kind !== 'calendar-search' || event.ownerId !== searchOwnerId || !event.type) return;
      handleSearchAction(event as unknown as NativeCalendarSearchAction);
    });
    return () => subscription.remove();
  }, [handleSearchAction, searchOwnerId]);

  useEffect(() => {
    if (searchVisible) {
      void presentNativeWindowOverlay(searchOwnerId, 'calendar-search', searchSnapshot);
    } else {
      void dismissNativeWindowOverlay(searchOwnerId, 'calendar-search', 'closed');
    }
  }, [searchOwnerId, searchSnapshot, searchVisible]);

  useEffect(() => () => {
    void dismissNativeWindowOverlay(searchOwnerId, 'calendar-search', 'screen-unmounted');
  }, [searchOwnerId]);

  return (
    <>
      <LaojiCalendarView
        style={styles.surface}
        mode={mode}
        snapshot={snapshot}
        profileEntry={profileEntry}
        selectedEpochDay={selectedEpochDay}
        bottomBarSelectionCommand={bottomBarSelectionCommand}
        mutationResolution={mutationResolution}
        onModeChange={event => setMode(event.nativeEvent.mode)}
        onVisibleRangeChange={event => handleVisibleRange(event.nativeEvent)}
        onDateSelect={event => setSelectedEpochDay(event.nativeEvent.epochDay)}
        onEventOpen={event => navigation.navigate('EventDetail', {
          eventRef: {
            sourceEventId: event.nativeEvent.sourceEventId,
            occurrenceDate: event.nativeEvent.occurrenceDate,
          },
        })}
        onCreateEvent={event => openCreate(event.nativeEvent)}
        onMutationCommit={event => { void handleMutation(event.nativeEvent); }}
        onSemanticEvent={event => handleSemantic(event.nativeEvent)}
        onTabPress={onTabPress}
        testID="schedule-native-calendar"
      />
      <AppActionSheet
        visible={createMenuVisible}
        title="新建日程"
        onClose={() => setCreateMenuVisible(false)}
        items={[
          { key: 'voice', label: '语音输入', onPress: () => setVoiceVisible(true) },
          { key: 'manual', label: '手动新建', onPress: () => openCreate() },
        ]}
      />
      <VoiceInputModal
        visible={voiceVisible}
        onClose={() => setVoiceVisible(false)}
        onSaved={() => setVoiceVisible(false)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  surface: { flex: 1, backgroundColor: C.appBg },
});
