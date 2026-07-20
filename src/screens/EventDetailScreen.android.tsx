import React, { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import {
  LaojiCalendarDetailView,
  type NativeCalendarDetailAction,
} from 'laoji-native-platform';
import { ScreenContainer } from '../components/ScreenContainer';
import { AppActionSheet, type AppActionSheetItem } from '../components/AppActionSheet';
import { useAppDialog } from '../components/AppDialog';
import { useEvents } from '../store/EventsStore';
import type { EventRecurrenceScope, RootStackParamList } from '../types';
import { resolveEventReference } from '../utils/eventRecurrence';
import { eventRefForEvent } from '../utils/eventIdentity';
import {
  recurrenceDeleteChoices,
  recurrenceDeleteDialog,
  recurrenceEditChoices,
} from '../services/recurrenceActions';
import { buildNativeCalendarDetailSnapshot } from '../native/nativeCalendarPages';

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
  const { showDialog } = useAppDialog();
  const [deleting, setDeleting] = useState(false);
  const [scopeRequest, setScopeRequest] = useState<ScopeRequest | null>(null);
  const event = useMemo(() => resolveEventReference(
    [...events, ...(searchableEvents ?? [])],
    route.params.eventRef,
  ) ?? undefined, [events, route.params.eventRef, searchableEvents]);
  const snapshot = useMemo(
    () => buildNativeCalendarDetailSnapshot(event, deleting),
    [deleting, event],
  );

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
      default:
        break;
    }
  }, [editEvent, navigation, refreshEvents, removeEvent, route.params.eventRef.occurrenceDate]);

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
