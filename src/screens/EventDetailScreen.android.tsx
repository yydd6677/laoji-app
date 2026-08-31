import React, { useCallback, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import { useFocusEffect } from '@react-navigation/native';
import {
  LaojiCalendarDetailView,
  type NativeCalendarDetailAction,
} from 'laoji-native-platform';
import { ScreenContainer } from '../components/ScreenContainer';
import { AppActionSheet, type AppActionSheetItem } from '../components/AppActionSheet';
import { useAppDialog } from '../components/AppDialog';
import {
  MeetingSeriesCarryForwardSheet,
  type MeetingSeriesCarryForwardSelection,
} from '../components/MeetingSeriesCarryForwardSheet';
import { useEvents } from '../store/EventsStore';
import { useMeetings } from '../store/MeetingsStore';
import type { EventRecurrenceScope, RootStackParamList } from '../types';
import { resolveEventReference } from '../utils/eventRecurrence';
import { eventRefForEvent } from '../utils/eventIdentity';
import {
  recurrenceDeleteChoices,
  recurrenceDeleteDialog,
  recurrenceEditChoices,
} from '../services/recurrenceActions';
import {
  buildNativeCalendarDetailSnapshot,
  buildNativeCalendarSeriesMemorySnapshot,
} from '../native/nativeCalendarPages';
import type { ScopeKey } from '../domain/meeting';
import {
  resolveOccurrenceMeeting,
  type OccurrenceMeetingProjection,
} from '../services/occurrenceMeeting';
import {
  carrySeriesMemoryToManualNote,
  openOccurrenceMeeting as openOccurrenceMeetingUseCase,
} from '../application/meeting';
import {
  isFutureMeetingSeriesOccurrence,
  resolveMeetingSeriesMemory,
  type MeetingSeriesMemoryProjection,
} from '../services/meetingSeriesMemory';
import { setOccurrenceMeetingLinkState } from '../services/meetingOccurrenceLifecycle';
import { diagnosticWarn } from '../services/diagnostics';
import { Colors as C } from '../theme/colors';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'EventDetail'>;
  route: RouteProp<RootStackParamList, 'EventDetail'>;
};

type ScopeRequest = {
  kind: 'edit' | 'delete';
  onSelect: (scope: EventRecurrenceScope) => void;
};

// CAL-DETAIL-001 / CAL-REPEAT-RRULE-001 / UI-OVERLAY-001: the route coordinates repository semantics only.
export function EventDetailScreen({ navigation, route }: Props) {
  const { events, searchableEvents, deleteEvent, refreshEvents } = useEvents();
  const { createMeeting } = useMeetings();
  const { showDialog } = useAppDialog();
  const [deleting, setDeleting] = useState(false);
  const [scopeRequest, setScopeRequest] = useState<ScopeRequest | null>(null);
  const [meetingProjection, setMeetingProjection] = useState<OccurrenceMeetingProjection | null>(null);
  const [meetingActionPhase, setMeetingActionPhase] = useState<'loading' | 'preparing' | 'ready' | 'error'>('loading');
  const [seriesMemory, setSeriesMemory] = useState<MeetingSeriesMemoryProjection | null>(null);
  const [seriesMemoryPhase, setSeriesMemoryPhase] = useState<'loading' | 'ready' | 'error'>('ready');
  const [carrySheetVisible, setCarrySheetVisible] = useState(false);
  const meetingActionBusyRef = useRef(false);
  const meetingProjectionRequestRef = useRef(0);
  const seriesMemoryRequestRef = useRef(0);
  const event = useMemo(() => resolveEventReference(
    [...events, ...(searchableEvents ?? [])],
    route.params.eventRef,
  ) ?? undefined, [events, route.params.eventRef, searchableEvents]);
  const scopeKey: ScopeKey = 'guest';

  const refreshMeetingProjection = useCallback(async () => {
    const request = ++meetingProjectionRequestRef.current;
    if (!event || !scopeKey) {
      setMeetingProjection(null);
      setMeetingActionPhase('ready');
      return;
    }
    setMeetingActionPhase('loading');
    try {
      await setOccurrenceMeetingLinkState({
        scopeKey,
        occurrence: eventRefForEvent(event),
        selection: 'occurrence',
        state: 'active',
      });
      const localProjection = await resolveOccurrenceMeeting(scopeKey, eventRefForEvent(event));
      if (meetingProjectionRequestRef.current !== request) return;
      setMeetingProjection(localProjection);
      setMeetingActionPhase('ready');
    } catch {
      if (meetingProjectionRequestRef.current !== request) return;
      setMeetingActionPhase('error');
      return;
    }
  }, [event, scopeKey]);

  const refreshSeriesMemory = useCallback(async () => {
    const request = ++seriesMemoryRequestRef.current;
    if (!event || !scopeKey || !isFutureMeetingSeriesOccurrence(event)) {
      setSeriesMemory(null);
      setSeriesMemoryPhase('ready');
      return;
    }
    setSeriesMemoryPhase('loading');
    try {
      const projection = await resolveMeetingSeriesMemory(scopeKey, event);
      if (seriesMemoryRequestRef.current !== request) return;
      setSeriesMemory(projection);
      setSeriesMemoryPhase('ready');
    } catch {
      if (seriesMemoryRequestRef.current !== request) return;
      setSeriesMemory(null);
      setSeriesMemoryPhase('error');
    }
  }, [event, scopeKey]);

  useFocusEffect(useCallback(() => {
    let active = true;
    meetingActionBusyRef.current = false;
    void refreshMeetingProjection().catch(() => {
      if (active) setMeetingActionPhase('error');
    });
    void refreshSeriesMemory();
    return () => {
      active = false;
      meetingProjectionRequestRef.current += 1;
      seriesMemoryRequestRef.current += 1;
    };
  }, [refreshMeetingProjection, refreshSeriesMemory]));

  const meetingAction = useMemo(() => {
    if (!event || !scopeKey) return undefined;
    if (meetingActionPhase === 'loading') {
      return { kind: 'loading' as const, label: '正在准备', statusLabel: '', enabled: false };
    }
    if (meetingActionPhase === 'preparing') {
      return {
        kind: 'loading' as const,
        label: '正在准备',
        statusLabel: '会议记录正在同步',
        enabled: false,
      };
    }
    if (meetingActionPhase === 'error') {
      return { kind: 'retry' as const, label: '重试', statusLabel: '会议状态暂时无法读取', enabled: true };
    }
    if (meetingProjection) {
      return {
        kind: meetingProjection.action,
        label: meetingProjection.label,
        statusLabel: meetingProjection.statusLabel,
        enabled: true,
      };
    }
    return { kind: 'start' as const, label: '开始记录', statusLabel: '尚未建立会议记录', enabled: true };
  }, [event, meetingActionPhase, meetingProjection, scopeKey]);
  const seriesMemorySnapshot = useMemo(() => (
    event && isFutureMeetingSeriesOccurrence(event)
      ? buildNativeCalendarSeriesMemorySnapshot(seriesMemoryPhase, seriesMemory)
      : undefined
  ), [event, seriesMemory, seriesMemoryPhase]);
  const snapshot = useMemo(
    () => buildNativeCalendarDetailSnapshot(event, deleting, meetingAction, seriesMemorySnapshot),
    [deleting, event, meetingAction, seriesMemorySnapshot],
  );

  const openOccurrenceMeeting = useCallback(async () => {
    if (!event || !scopeKey || meetingActionBusyRef.current) return;
    if (meetingActionPhase === 'loading' || meetingActionPhase === 'preparing') return;
    if (meetingActionPhase === 'error') {
      await refreshMeetingProjection();
      return;
    }
    meetingActionBusyRef.current = true;
    setMeetingActionPhase('loading');
    try {
      const target = await openOccurrenceMeetingUseCase({
        scopeKey,
        event,
        entryPoint: 'calendar_detail',
        createMeeting,
      });
      setMeetingProjection(target.projection);
      setMeetingActionPhase('ready');
      if (target.route === 'Transcription') navigation.navigate('Transcription', target.params);
      else navigation.navigate('MeetingLive', target.params);
    } catch (error) {
      meetingActionBusyRef.current = false;
      setMeetingActionPhase('error');
      diagnosticWarn('[calendar-meeting] open occurrence failed', error);
      showDialog({
        title: '暂时无法开始记录',
        message: '会议记录或日程关联尚未准备好，请稍后重试。',
        tone: 'error',
      });
    }
  }, [
    createMeeting,
    event,
    meetingActionPhase,
    meetingProjection,
    navigation,
    refreshMeetingProjection,
    scopeKey,
    showDialog,
  ]);

  const removeEvent = useCallback(() => {
    if (!event || deleting) return;
    const remove = async (recurrenceScope: EventRecurrenceScope) => {
      setDeleting(true);
      try {
        await deleteEvent(eventRefForEvent(event), recurrenceScope);
        navigation.popTo('MainTabs', { screen: 'Schedule' });
      } catch {
        setDeleting(false);
        showDialog({ title: '删除失败', message: '请检查网络后重试', tone: 'error' });
      }
    };
    if (event.repeat && event.repeat !== 'once') {
      setScopeRequest({ kind: 'delete', onSelect: scope => { void remove(scope); } });
    } else {
      showDialog(recurrenceDeleteDialog(event, scope => remove(scope)));
    }
  }, [deleteEvent, deleting, event, navigation, showDialog]);

  const editEvent = useCallback(() => {
    if (!event) return;
    const navigateToEditor = (recurrenceScope: 'occurrence' | 'following' | 'series') => {
      navigation.navigate('AddEvent', {
        date: event.seriesStartDate ?? event.startDate,
        eventRef: eventRefForEvent(event),
        recurrenceScope,
      });
    };
    if (event.repeat && event.repeat !== 'once') {
      setScopeRequest({ kind: 'edit', onSelect: navigateToEditor });
    } else {
      navigateToEditor('series');
    }
  }, [event, navigation, showDialog]);

  const scopeItems = useMemo<AppActionSheetItem[]>(() => {
    if (!event || !scopeRequest) return [];
    const choices = scopeRequest.kind === 'edit'
      ? recurrenceEditChoices(event)
      : recurrenceDeleteChoices(event);
    return choices.map(item => ({
      key: `scope-${item.scope}`,
      label: item.label,
      destructive: item.destructive,
      disabled: item.disabled,
      onPress: () => scopeRequest.onSelect(item.scope),
    }));
  }, [event, scopeRequest]);

  const carrySelectionToNote = useCallback((
    selection: MeetingSeriesCarryForwardSelection,
  ) => {
    if (!event || !scopeKey) return Promise.reject(new Error('series memory is unavailable'));
    return carrySeriesMemoryToManualNote({
      scopeKey,
      event,
      decisionIds: selection.decisionIds,
      actionIds: selection.actionIds,
      createMeeting,
    });
  }, [createMeeting, event, scopeKey]);

  const handleAction = useCallback((action: NativeCalendarDetailAction) => {
    switch (action.type) {
      case 'back':
        navigation.goBack();
        break;
      case 'edit':
        editEvent();
        break;
      case 'delete':
        removeEvent();
        break;
      case 'retry': {
        const [year, month] = route.params.eventRef.occurrenceDate.split('-').map(Number);
        if (Number.isFinite(year) && Number.isFinite(month)) void refreshEvents(year, month);
        break;
      }
      case 'meetingAction':
        void openOccurrenceMeeting();
        break;
      case 'retrySeriesMemory':
        void refreshSeriesMemory();
        break;
      case 'carrySeriesMemory':
        if (seriesMemory && (seriesMemory.decisions.length > 0 || seriesMemory.pendingActions.length > 0)) {
          setCarrySheetVisible(true);
        }
        break;
      case 'openSeriesMeeting': {
        const segmentId = action.segmentId?.trim();
        const positionMs = typeof action.positionMs === 'number'
          && Number.isSafeInteger(action.positionMs)
          && action.positionMs >= 0
          ? action.positionMs
          : undefined;
        navigation.navigate('Transcription', segmentId || positionMs !== undefined ? {
          meetingId: action.meetingId,
          focus: 'transcript',
          segmentId,
          positionMs,
          transcriptFocusRequestId: Date.now(),
        } : {
          meetingId: action.meetingId,
          focus: 'summary',
        });
        break;
      }
      case 'openSeriesAction':
        navigation.navigate('Transcription', {
          meetingId: action.meetingId,
          focus: 'summary',
          actionId: action.actionId,
          actionFocusRequestId: Date.now(),
        });
        break;
      default:
        break;
    }
  }, [
    editEvent,
    navigation,
    openOccurrenceMeeting,
    refreshEvents,
    refreshSeriesMemory,
    removeEvent,
    route.params.eventRef.occurrenceDate,
    seriesMemory,
  ]);

  return (
    <ScreenContainer edges={['top', 'bottom']} bg={C.body}>
      <View
        style={styles.root}
        testID="event-detail-native-root"
        collapsable={false}
        collapsableChildren={false}
      >
        <LaojiCalendarDetailView
          style={styles.surface}
          snapshot={snapshot}
          onAction={value => handleAction(value.nativeEvent)}
          testID="event-detail-native-surface"
        />
      </View>
      <AppActionSheet
        visible={scopeRequest !== null}
        items={scopeItems}
        onClose={() => setScopeRequest(null)}
      />
      <MeetingSeriesCarryForwardSheet
        visible={carrySheetVisible}
        memory={seriesMemory}
        onClose={() => setCarrySheetVisible(false)}
        onCarry={carrySelectionToNote}
        onCompleted={result => {
          navigation.navigate('Transcription', { meetingId: result.meetingId, focus: 'notes' });
        }}
      />
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  surface: { flex: 1 },
});
