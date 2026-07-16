import React, { useRef, useState } from 'react';
import {
  Animated,
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { Colors as C } from '../theme/colors';
import { ScreenContainer } from '../components/ScreenContainer';
import {
  ResponsiveContentFrame,
  resolveResponsiveContentLayout,
} from '../components/ResponsiveContentFrame';
import { CalendarDetailTitleBar } from '../components/CalendarTitleBar';
import { RootStackParamList } from '../types';
import { useEvents } from '../store/EventsStore';
import { useAppDialog } from '../components/AppDialog';
import { labelForReminder } from '../services/notifications';
import { eventRefForEvent } from '../utils/eventIdentity';
import { resolveEventReference } from '../utils/eventRecurrence';
import { recurrenceDeleteDialog } from '../services/recurrenceActions';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'EventDetail'>;
  route: RouteProp<RootStackParamList, 'EventDetail'>;
};

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const DEFAULT_CALENDAR_TITLE_COLOR = '#0442D2';
const DETAIL_TITLE_BAR_HEIGHT = 44;
const HEADER_BG_MIN_HEIGHT_WIDTH_RATIO = 0.30113637;
const SUMMARY_FADE_RANGE = 40;
const TITLE_FADE_RANGE = 30;
const HEADER_SNAP_MIN_FLING_VELOCITY = 0.2;
const HEADER_SNAP_EPSILON = 0.5;

type HeaderSnapMetrics = {
  offsetY: number;
  releaseVelocityY: number;
  headerHeight: number;
  contentHeight: number;
  viewportHeight: number;
};

export function resolveHeaderSnapTarget({
  offsetY,
  releaseVelocityY,
  headerHeight,
  contentHeight,
  viewportHeight,
}: HeaderSnapMetrics): number | null {
  if (![offsetY, releaseVelocityY, headerHeight, contentHeight, viewportHeight].every(Number.isFinite)) {
    return null;
  }
  if (headerHeight <= HEADER_SNAP_EPSILON) return null;

  const maxScrollOffset = Math.max(0, contentHeight - viewportHeight);
  if (maxScrollOffset + HEADER_SNAP_EPSILON < headerHeight) return null;
  if (offsetY <= HEADER_SNAP_EPSILON || offsetY >= headerHeight - HEADER_SNAP_EPSILON) return null;

  if (Math.abs(releaseVelocityY) > HEADER_SNAP_MIN_FLING_VELOCITY) {
    // React Native reports the finger velocity, opposite to the content offset direction.
    return releaseVelocityY < 0 ? headerHeight : 0;
  }
  return offsetY >= headerHeight / 2 ? headerHeight : 0;
}

function parseLocalDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function conciseDate(value: string): string {
  const date = parseLocalDate(value);
  const includeYear = date.getFullYear() !== new Date().getFullYear();
  return `${includeYear ? `${date.getFullYear()}年` : ''}${date.getMonth() + 1}月${date.getDate()}日 周${WEEKDAYS[date.getDay()]}`;
}

function detailTimeRange({
  startDate,
  endDate,
  startTime,
  endTime,
  isAllDay,
}: {
  startDate: string;
  endDate?: string;
  startTime?: string;
  endTime?: string;
  isAllDay?: boolean;
}): string {
  const start = conciseDate(startDate);
  const end = endDate && endDate !== startDate ? conciseDate(endDate) : undefined;

  if (isAllDay || (!startTime && !endTime)) {
    return end ? `${start} - ${end}` : start;
  }

  const startWithTime = startTime ? `${start} ${startTime}` : start;
  if (end) {
    return `${startWithTime} - ${end}${endTime ? ` ${endTime}` : ''}`;
  }
  if (startTime && endTime) return `${startWithTime} - ${endTime}`;
  return startTime ? startWithTime : `${start} ${endTime}`;
}

function DetailInfoRow({ icon, children, testID }: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  children: React.ReactNode;
  testID: string;
}) {
  return (
    <View style={s.infoRow} testID={testID}>
      <View style={s.iconLane}>
        <Ionicons name={icon} size={16} color={C.faint} />
      </View>
      <View style={s.infoContent}>{children}</View>
    </View>
  );
}

export function EventDetailScreen({ navigation, route }: Props) {
  const { events, searchableEvents, deleteEvent } = useEvents();
  const { showDialog } = useAppDialog();
  const scrollY = useRef(new Animated.Value(0)).current;
  const scrollRef = useRef<ScrollView>(null);
  const contentHeightRef = useRef(0);
  const viewportHeightRef = useRef(0);
  const releaseHandledRef = useRef(false);
  const { width, height } = useWindowDimensions();
  const responsiveLayout = resolveResponsiveContentLayout(width, height);
  const [eventHeaderHeight, setEventHeaderHeight] = useState(0);
  const ev = resolveEventReference(
    [...events, ...(searchableEvents ?? [])],
    route.params.eventRef,
  );

  if (!ev) {
    return (
      <ScreenContainer edges={['top']} bg={C.body}>
        <ResponsiveContentFrame testID="event-detail-content-frame">
          <CalendarDetailTitleBar title="" onBack={() => navigation.goBack()} />
          <View style={s.emptyWrap}>
            <Text style={s.emptyTitle}>日程不存在</Text>
            <Text style={s.emptyText}>请返回日历后重新打开。</Text>
          </View>
        </ResponsiveContentFrame>
      </ScreenContainer>
    );
  }

  const timeRangeText = detailTimeRange(ev);
  const detailText = ev.detail ?? ev.description;
  const repeatLabels: Record<string, string> = {
    daily: '每天重复',
    weekly: '每周重复',
    monthly: '每月重复',
    yearly: '每年重复',
  };
  const repeatText = ev.repeat && ev.repeat !== 'once' ? repeatLabels[ev.repeat] ?? ev.repeat : undefined;
  const titleOpacity = scrollY.interpolate({
    inputRange: [SUMMARY_FADE_RANGE, SUMMARY_FADE_RANGE + TITLE_FADE_RANGE],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });
  const summaryOpacity = scrollY.interpolate({
    inputRange: [0, SUMMARY_FADE_RANGE],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });
  const headerMetaOpacity = scrollY.interpolate({
    inputRange: [0, Math.max(1, eventHeaderHeight)],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });
  const headerWashHeight = Math.max(
    DETAIL_TITLE_BAR_HEIGHT + eventHeaderHeight,
    responsiveLayout.contentWidth * HEADER_BG_MIN_HEIGHT_WIDTH_RATIO,
  );

  const handleEdit = () => {
    navigation.navigate('AddEvent', {
      date: ev.seriesStartDate ?? ev.startDate,
      eventRef: eventRefForEvent(ev),
    });
  };

  const handleDelete = () => {
    showDialog(recurrenceDeleteDialog(ev, async recurrenceScope => {
      try {
        await deleteEvent(eventRefForEvent(ev), recurrenceScope);
        navigation.goBack();
      } catch {
        showDialog({ title: '删除失败', message: '请检查网络后重试', tone: 'error' });
      }
    }));
  };

  const settleHeader = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (releaseHandledRef.current) return;
    releaseHandledRef.current = true;

    const { contentOffset, contentSize, layoutMeasurement, velocity } = event.nativeEvent;
    const target = resolveHeaderSnapTarget({
      offsetY: contentOffset.y,
      releaseVelocityY: velocity?.y ?? 0,
      headerHeight: eventHeaderHeight,
      contentHeight: contentSize.height > 0 ? contentSize.height : contentHeightRef.current,
      viewportHeight: layoutMeasurement.height > 0 ? layoutMeasurement.height : viewportHeightRef.current,
    });
    if (target == null) return;
    scrollRef.current?.scrollTo({ x: 0, y: target, animated: true });
  };

  return (
    <ScreenContainer edges={['top']} bg={C.body}>
      <LinearGradient
        testID="event-detail-header-wash"
        pointerEvents="none"
        colors={[
          'rgba(122, 162, 255, 0.18)',
          'rgba(194, 212, 255, 0.10)',
          'rgba(255, 255, 255, 0)',
        ]}
        locations={[0, 0.55, 1]}
        style={[s.headerWash, { height: headerWashHeight }]}
      />
      <ResponsiveContentFrame testID="event-detail-content-frame">
        <CalendarDetailTitleBar
          title={ev.title}
          titleOpacity={titleOpacity}
          titleAlignment="leading"
          titleColor={DEFAULT_CALENDAR_TITLE_COLOR}
          onBack={() => navigation.goBack()}
          actions={[
            { key: 'edit', icon: 'pencil-outline', label: '编辑日程', onPress: handleEdit },
            { key: 'delete', icon: 'trash-outline', label: '删除日程', onPress: handleDelete },
          ]}
        />
        <Animated.ScrollView
          ref={scrollRef}
          testID="event-detail-scroll"
          style={s.scroll}
          contentContainerStyle={s.content}
          showsVerticalScrollIndicator={false}
          nestedScrollEnabled
          scrollEventThrottle={16}
          onLayout={event => {
            viewportHeightRef.current = event.nativeEvent.layout.height;
          }}
          onContentSizeChange={(_contentWidth, contentHeight) => {
            contentHeightRef.current = contentHeight;
          }}
          onScrollBeginDrag={() => {
            releaseHandledRef.current = false;
          }}
          onScrollEndDrag={settleHeader}
          onMomentumScrollEnd={settleHeader}
          onScroll={Animated.event(
            [{ nativeEvent: { contentOffset: { y: scrollY } } }],
            { useNativeDriver: true },
          )}
        >
          <View
            style={s.eventHeader}
            testID="event-detail-header"
            onLayout={event => {
              const nextHeight = event.nativeEvent.layout.height;
              setEventHeaderHeight(current => Math.abs(current - nextHeight) < 0.5 ? current : nextHeight);
            }}
          >
            <Animated.View
              style={[s.summaryRow, { opacity: summaryOpacity }]}
              testID="event-detail-summary-row"
            >
              <View testID="event-detail-color" style={s.colorSymbol} />
              <Text style={s.summary} numberOfLines={2}>{ev.title}</Text>
            </Animated.View>
            <Animated.Text
              testID="event-detail-time"
              style={[s.headerMeta, { opacity: headerMetaOpacity }]}
            >
              {timeRangeText}
            </Animated.Text>
            {repeatText ? (
              <Animated.Text
                style={[s.headerRule, { opacity: headerMetaOpacity }]}
                numberOfLines={2}
              >
                {repeatText}
              </Animated.Text>
            ) : null}
          </View>

          <View testID="event-detail-body">
            {ev.location ? (
              <DetailInfoRow icon="location-outline" testID="event-detail-location-row">
                <Text style={s.infoText}>{ev.location}</Text>
              </DetailInfoRow>
            ) : null}

            {detailText ? (
              <DetailInfoRow icon="reorder-three-outline" testID="event-detail-description-row">
                <Text style={s.description}>{detailText}</Text>
              </DetailInfoRow>
            ) : null}

            {ev.reminderMinutes != null ? (
              <DetailInfoRow icon="notifications-outline" testID="event-detail-reminder-row">
                <Text style={s.infoText}>{labelForReminder(ev.reminderMinutes)}</Text>
              </DetailInfoRow>
            ) : null}
          </View>
        </Animated.ScrollView>
      </ResponsiveContentFrame>
    </ScreenContainer>
  );
}

const s = StyleSheet.create({
  headerWash: { position: 'absolute', top: 0, left: 0, right: 0 },
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: C.body },
  emptyTitle: { fontSize: 17, lineHeight: 24, fontWeight: '600', color: C.text, marginBottom: 8 },
  emptyText: { fontSize: 14, lineHeight: 22, color: C.sub },
  scroll: { flex: 1, backgroundColor: 'transparent' },
  content: { paddingBottom: 80 },
  eventHeader: { paddingHorizontal: 16, paddingBottom: 30 },
  summaryRow: { marginTop: 10, minHeight: 28, flexDirection: 'row', alignItems: 'flex-start' },
  colorSymbol: { width: 14, height: 14, marginTop: 7, marginRight: 18, borderRadius: 4, backgroundColor: DEFAULT_CALENDAR_TITLE_COLOR },
  summary: { flex: 1, fontSize: 20, lineHeight: 28, fontWeight: '600', color: DEFAULT_CALENDAR_TITLE_COLOR, paddingRight: 8 },
  headerMeta: { marginLeft: 32, marginTop: 4, minHeight: 22, fontSize: 14, lineHeight: 22, color: DEFAULT_CALENDAR_TITLE_COLOR },
  headerRule: { marginLeft: 32, minHeight: 22, fontSize: 14, lineHeight: 22, color: '#94B4FF' },
  infoRow: { minHeight: 44, paddingVertical: 10, flexDirection: 'row', alignItems: 'flex-start' },
  iconLane: { width: 48, height: 22, alignItems: 'center', justifyContent: 'center' },
  infoContent: { flex: 1, minHeight: 22, justifyContent: 'center', paddingRight: 16 },
  infoText: { fontSize: 16, lineHeight: 22, color: C.text },
  description: { fontSize: 16, lineHeight: 24, color: C.text },
});
