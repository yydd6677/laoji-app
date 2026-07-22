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
import { useEvents } from '../store/EventsStore';
import { useMeetings } from '../store/MeetingsStore';
import { useAuth } from '../store/AuthStore';
import type { EventRecurrenceScope, RootStackParamList } from '../types';
import { resolveEventReference } from '../utils/eventRecurrence';
import { eventRefForEvent } from '../utils/eventIdentity';
import {
  recurrenceDeleteChoices,
  recurrenceDeleteDialog,
  recurrenceEditChoices,
} from '../services/recurrenceActions';
import { buildNativeCalendarDetailSnapshot } from '../native/nativeCalendarPages';
import { isScopeKey, type ScopeKey } from '../domain/meeting';
import {
  bindLegacyMeetingToOccurrence,
  calendarMeetingContext,
  resolveOccurrenceMeeting,
  type OccurrenceMeetingProjection,
} from '../services/occurrenceMeeting';

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
  const { mode, session } = useAuth();
  const { showDialog } = useAppDialog();
  const [deleting, setDeleting] = useState(false);
  const [scopeRequest, setScopeRequest] = useState<ScopeRequest | null>(null);
  const [meetingProjection, setMeetingProjection] = useState<OccurrenceMeetingProjection | null>(null);
  const [meetingActionPhase, setMeetingActionPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const meetingActionBusyRef = useRef(false);
  const event = useMemo(() => resolveEventReference(
    [...events, ...(searchableEvents ?? [])],
    route.params.eventRef,
  ) ?? undefined, [events, route.params.eventRef, searchableEvents]);
  const scopeKey = useMemo<ScopeKey | null>(() => {
    const candidate = mode === 'guest'
      ? 'guest'
      : mode === 'authenticated' && session
        ? `user:${session.user.id}`
        : '';
    return isScopeKey(candidate) ? candidate : null;
  }, [mode, session?.user.id]);

  const refreshMeetingProjection = useCallback(async () => {
    if (!event || !scopeKey) {
      setMeetingProjection(null);
      setMeetingActionPhase('ready');
      return;
    }
    setMeetingActionPhase('loading');
    try {
      const projection = await resolveOccurrenceMeeting(scopeKey, eventRefForEvent(event));
      setMeetingProjection(projection);
      setMeetingActionPhase('ready');
    } catch {
      setMeetingActionPhase('error');
    }
  }, [event, scopeKey]);

  useFocusEffect(useCallback(() => {
    let active = true;
    meetingActionBusyRef.current = false;
    void refreshMeetingProjection().catch(() => {
      if (active) setMeetingActionPhase('error');
    });
    return () => { active = false; };
  }, [refreshMeetingProjection]));

  const meetingAction = useMemo(() => {
    if (!event || !scopeKey) return undefined;
    if (meetingActionPhase === 'loading') {
      return { kind: 'loading' as const, label: '正在准备', statusLabel: '', enabled: false };
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
  const snapshot = useMemo(
    () => buildNativeCalendarDetailSnapshot(event, deleting, meetingAction),
    [deleting, event, meetingAction],
  );

  const openOccurrenceMeeting = useCallback(async () => {
    if (!event || !scopeKey || meetingActionBusyRef.current) return;
    if (meetingActionPhase === 'error') {
      await refreshMeetingProjection();
      return;
    }
    const current = meetingProjection;
    if (current?.action === 'view') {
      meetingActionBusyRef.current = true;
      navigation.navigate('Transcription', { meetingId: current.meetingId });
      return;
    }
    if (current?.action === 'continue') {
      meetingActionBusyRef.current = true;
      navigation.navigate('MeetingLive', { meetingId: current.meetingId, startRequested: false });
      return;
    }
    if (current?.action === 'start') {
      meetingActionBusyRef.current = true;
      navigation.navigate('MeetingLive', { meetingId: current.meetingId, startRequested: true });
      return;
    }

    meetingActionBusyRef.current = true;
    setMeetingActionPhase('loading');
    try {
      const context = calendarMeetingContext(event);
      const created = await createMeeting(event.title ?? '', {
        description: event.description ?? event.detail ?? null,
        location: event.location ?? null,
        mode: 'realtime',
        clientRequestId: `calendar:${context.occurrence.sourceEventId}:${context.occurrence.occurrenceDate}`,
        calendarContext: context,
      });
      const projection = await bindLegacyMeetingToOccurrence(scopeKey, created, context);
      setMeetingProjection(projection);
      setMeetingActionPhase('ready');
      navigation.navigate('MeetingLive', { meetingId: projection.meetingId, startRequested: true });
    } catch {
      setMeetingActionPhase('error');
      showDialog({
        title: '暂时无法开始记录',
        message: '会议记录或日程关联尚未准备好，请稍后重试。',
        tone: 'error',
      });
    } finally {
      meetingActionBusyRef.current = false;
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
      default:
        break;
    }
  }, [editEvent, navigation, openOccurrenceMeeting, refreshEvents, removeEvent, route.params.eventRef.occurrenceDate]);

  return (
    <ScreenContainer edges={['top', 'bottom']} bg="#FFFFFF">
      <View
        style={styles.root}
        testID="event-detail-native-root"
        collapsable={false}
        collapsableChildren={false}
      >
        <LaojiCalendarDetailView
          nativeID="feishu:CAL-REPEAT-RRULE-001:calendar-detail-recurrence-action-surface"
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
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  surface: { flex: 1 },
});
