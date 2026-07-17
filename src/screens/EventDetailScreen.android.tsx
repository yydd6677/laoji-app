import React, { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import {
  LaojiCalendarDetailView,
  type NativeCalendarDetailAction,
} from 'laoji-native-platform';
import { ScreenContainer } from '../components/ScreenContainer';
import { useAppDialog } from '../components/AppDialog';
import { useEvents } from '../store/EventsStore';
import type { RootStackParamList } from '../types';
import { resolveEventReference } from '../utils/eventRecurrence';
import { eventRefForEvent } from '../utils/eventIdentity';
import { recurrenceDeleteDialog } from '../services/recurrenceActions';
import { buildNativeCalendarDetailSnapshot } from '../native/nativeCalendarPages';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'EventDetail'>;
  route: RouteProp<RootStackParamList, 'EventDetail'>;
};

// CAL-DETAIL-001 / UI-OVERLAY-001: the route coordinates repository semantics only.
export function EventDetailScreen({ navigation, route }: Props) {
  const { events, searchableEvents, deleteEvent, refreshEvents } = useEvents();
  const { showDialog } = useAppDialog();
  const [deleting, setDeleting] = useState(false);
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
    showDialog(recurrenceDeleteDialog(event, async recurrenceScope => {
      setDeleting(true);
      try {
        await deleteEvent(eventRefForEvent(event), recurrenceScope);
        navigation.navigate('MainTabs', { screen: 'Schedule' });
      } catch {
        setDeleting(false);
        showDialog({ title: '删除失败', message: '请检查网络后重试', tone: 'error' });
      }
    }));
  }, [deleteEvent, deleting, event, navigation, showDialog]);

  const handleAction = useCallback((action: NativeCalendarDetailAction) => {
    switch (action.type) {
      case 'back':
        navigation.goBack();
        break;
      case 'edit':
        if (event) navigation.navigate('AddEvent', {
          date: event.seriesStartDate ?? event.startDate,
          eventRef: eventRefForEvent(event),
        });
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
  }, [event, navigation, refreshEvents, removeEvent, route.params.eventRef.occurrenceDate]);

  return (
    <ScreenContainer edges={['top', 'bottom']} bg="#FFFFFF">
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
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  surface: { flex: 1 },
});
