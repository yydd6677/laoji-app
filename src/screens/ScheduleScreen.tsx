import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useIsFocused, type CompositeNavigationProp } from '@react-navigation/native';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { ScreenContainer } from '../components/ScreenContainer';
import { Avatar } from '../components/Common';
import { BOTTOM_TAB_BAR_GEOMETRY } from '../components/BottomTabBar';
import { VoiceInputModal } from '../components/VoiceInputModal';
import { AppActionSheet } from '../components/AppActionSheet';
import { useAppDialog } from '../components/AppDialog';
import { ScheduleCreateButton } from '../components/ScheduleCreateButton';
import { MonthCalendarView } from '../components/MonthCalendarView';
import { DayTimelineView } from '../components/DayTimelineView';
import { QuickDatePanel } from '../components/QuickDatePanel';
import { CalendarSearchPage } from '../components/CalendarSearchPage';
import { getAppStorageItem, setAppStorageItem } from '../services/appStorage';
import { useEvents } from '../store/EventsStore';
import { useAuth } from '../store/AuthStore';
import {
  addMonths,
  dateKey,
  formatMonthTitle,
  isSameMonth,
  startOfMonth,
} from '../utils/calendarDate';
import { Colors as C, withAlpha } from '../theme/colors';
import type { CalEvent, MainTabsParamList, RootStackParamList } from '../types';
import { eventRefForEvent } from '../utils/eventIdentity';
import { eventOverlapsDateRange } from '../utils/eventDateSemantics';
import { recurrenceEditDialog } from '../services/recurrenceActions';
import { readableErrorMessage } from '../services/errors';
import type { EventRecurrenceScope } from '../types';

type ScheduleNavigationProp = CompositeNavigationProp<
  BottomTabNavigationProp<MainTabsParamList, 'Schedule'>,
  NativeStackNavigationProp<RootStackParamList>
>;
type Props = { navigation: ScheduleNavigationProp };
type CalendarViewMode = 'month' | 'day';
type RestoredCalendarViewMode = { scope: string; mode: CalendarViewMode };

const TITLE_BAR_HEIGHT = 60;
const VIEW_MODE_STORAGE_KEY = '@laoji:scheduleViewMode:v1';

function isCalendarViewMode(value: string | null): value is CalendarViewMode {
  return value === 'month' || value === 'day';
}

export function ScheduleScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();
  const {
    events,
    searchableEvents,
    monthStates = {},
    cacheRecoveryNotice,
    dismissCacheRecoveryNotice,
    updateEvent,
    refreshEvents,
  } = useEvents();
  const { showDialog } = useAppDialog();
  const { initializing, mode: authMode, session, profile } = useAuth();
  const initialDate = useMemo(() => new Date(), []);
  const [selectedDate, setSelectedDate] = useState(initialDate);
  const [visibleMonth, setVisibleMonth] = useState(() => startOfMonth(initialDate));
  const [restoredViewMode, setRestoredViewMode] = useState<RestoredCalendarViewMode | null>(null);
  const [searching, setSearching] = useState(false);
  const [createSheetVisible, setCreateSheetVisible] = useState(false);
  const [quickDateVisible, setQuickDateVisible] = useState(false);
  const [voiceVisible, setVoiceVisible] = useState(false);
  const quickDateProgress = useRef(new Animated.Value(0)).current;
  const dataScope = initializing
    ? null
    : authMode === 'authenticated'
      ? session ? `user:${session.user.id}` : null
      : authMode === 'guest' ? 'guest' : 'signed_out';
  const viewMode = dataScope && restoredViewMode?.scope === dataScope
    ? restoredViewMode.mode
    : null;
  const searchPageVisible = isFocused && searching;
  const quickDatePanelVisible = isFocused && Boolean(viewMode) && !searchPageVisible && quickDateVisible;
  const mainContentHidden = !isFocused || quickDatePanelVisible || searchPageVisible;
  const visibleMonthKey = `${visibleMonth.getFullYear()}-${String(visibleMonth.getMonth() + 1).padStart(2, '0')}`;
  const visibleMonthState = monthStates[visibleMonthKey];
  const visibleMonthError = visibleMonthState?.status === 'error'
    ? visibleMonthState.error
    : null;
  const visibleMonthStart = `${visibleMonthKey}-01`;
  const visibleMonthEnd = `${visibleMonthKey}-${String(
    new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 0).getDate(),
  ).padStart(2, '0')}`;
  const hasVisibleMonthEvents = events.some(event => (
    eventOverlapsDateRange(event, visibleMonthStart, visibleMonthEnd)
  ));
  const showVisibleMonthLoading = visibleMonthState?.status === 'loading'
    && !hasVisibleMonthEvents;

  useEffect(() => {
    if (!dataScope) return undefined;
    let active = true;
    const scope = dataScope;
    setQuickDateVisible(false);
    void getAppStorageItem(`${VIEW_MODE_STORAGE_KEY}:${scope}`)
      .then(savedMode => {
        if (!active) return;
        setRestoredViewMode({
          scope,
          mode: isCalendarViewMode(savedMode) ? savedMode : 'month',
        });
      })
      .catch(() => {
        if (active) setRestoredViewMode({ scope, mode: 'month' });
      });
    return () => {
      active = false;
    };
  }, [dataScope]);

  useEffect(() => {
    if (isFocused) return;
    setQuickDateVisible(false);
    setSearching(false);
  }, [isFocused]);

  useEffect(() => {
    let alive = true;
    const loadVisibleGrid = async () => {
      for (const offset of [0, -1, 1]) {
        if (!alive) return;
        const month = addMonths(visibleMonth, offset);
        await refreshEvents(month.getFullYear(), month.getMonth() + 1);
      }
    };
    void loadVisibleGrid();
    return () => { alive = false; };
  }, [refreshEvents, visibleMonth]);

  const openEvent = (event: CalEvent) => {
    navigation.navigate('EventDetail', { eventRef: eventRefForEvent(event) });
  };

  const chooseDate = (date: Date) => {
    setSelectedDate(date);
    if (!isSameMonth(date, visibleMonth)) setVisibleMonth(startOfMonth(date));
  };

  const changeMonth = (month: Date) => {
    const day = Math.min(
      selectedDate.getDate(),
      new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate(),
    );
    const nextDate = new Date(month.getFullYear(), month.getMonth(), day);
    setVisibleMonth(startOfMonth(month));
    setSelectedDate(nextDate);
  };

  const backToday = () => {
    const today = new Date();
    setSelectedDate(today);
    setVisibleMonth(startOfMonth(today));
    setSearching(false);
    setQuickDateVisible(false);
  };

  useEffect(() => navigation.addListener('tabPress', () => {
    if (isFocused) backToday();
  }), [isFocused, navigation]);

  const openManualCreate = () => {
    navigation.navigate('AddEvent', { date: dateKey(selectedDate) });
  };

  const openManualCreateForDate = (date: Date) => {
    navigation.navigate('AddEvent', { date: dateKey(date) });
  };

  const openManualCreateForSlot = (
    startDate: Date,
    startTime: string,
    endDate: Date,
    endTime: string,
  ) => {
    navigation.navigate('AddEvent', {
      date: dateKey(startDate),
      endDate: dateKey(endDate),
      startTime,
      endTime,
    });
  };

  const chooseTimelineEditScope = (event: CalEvent): Promise<EventRecurrenceScope | null> => {
    if (!event.repeat || event.repeat === 'once') return Promise.resolve('series');
    return new Promise(resolve => {
      let settled = false;
      const finish = (scope: EventRecurrenceScope | null) => {
        if (settled) return;
        settled = true;
        resolve(scope);
      };
      showDialog(recurrenceEditDialog(
        event,
        scope => finish(scope),
        () => finish(null),
      ));
    });
  };

  const changeTimelineEventTime = async (
    event: CalEvent,
    changes: Pick<CalEvent, 'startDate' | 'endDate' | 'startTime' | 'endTime'>,
  ): Promise<boolean> => {
    const scope = await chooseTimelineEditScope(event);
    if (!scope) return false;
    try {
      await updateEvent(eventRefForEvent(event), changes, scope);
      return true;
    } catch (error) {
      showDialog({
        title: '时间修改失败',
        message: readableErrorMessage(error, '原日程时间已保留，请检查网络后重试。'),
        tone: 'error',
      });
      return false;
    }
  };

  const selectViewMode = (mode: CalendarViewMode) => {
    if (!dataScope || !viewMode) return;
    setRestoredViewMode({ scope: dataScope, mode });
    void setAppStorageItem(`${VIEW_MODE_STORAGE_KEY}:${dataScope}`, mode).catch(() => undefined);
    setQuickDateVisible(false);
    setVisibleMonth(startOfMonth(selectedDate));
  };

  const closeSearch = () => {
    setSearching(false);
  };

  return (
    <ScreenContainer edges={['top']} bg={C.body}>
      <View
        style={s.screenContent}
        pointerEvents={mainContentHidden ? 'none' : 'auto'}
        accessibilityElementsHidden={mainContentHidden}
        importantForAccessibility={mainContentHidden ? 'no-hide-descendants' : 'auto'}
        testID="schedule-main-content"
      >
        <View style={s.titleBar}>
        <TouchableOpacity
          style={s.profileButton}
          onPress={() => navigation.navigate('Profile')}
          accessibilityRole="button"
          accessibilityLabel="打开个人资料"
          testID="schedule-open-profile"
        >
          <Avatar size={36} profile={profile} />
        </TouchableOpacity>
        <TouchableOpacity
          style={s.titleButton}
          onPress={() => {
            if (viewMode) setQuickDateVisible(visible => !visible);
          }}
          disabled={!viewMode}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={!viewMode
            ? '正在恢复日历视图'
            : quickDatePanelVisible
            ? viewMode === 'month' ? '收起年月选择' : '收起日期选择'
            : viewMode === 'month' ? '选择年月' : '展开日期选择'}
          accessibilityState={{ disabled: !viewMode, expanded: quickDatePanelVisible }}
        >
          <Text style={s.title} numberOfLines={1}>
            {formatMonthTitle(viewMode === 'month' ? visibleMonth : selectedDate)}
          </Text>
          <Animated.View
            style={[s.titleArrow, {
              transform: [{
                rotate: quickDateProgress.interpolate({
                  inputRange: [0, 1],
                  outputRange: ['0deg', '180deg'],
                }),
              }],
            }]}
            testID="schedule-title-arrow"
          >
            <View style={s.titleArrowTriangle} />
          </Animated.View>
        </TouchableOpacity>
        <View style={s.headerActions} testID="schedule-header-actions">
          <TouchableOpacity
            style={s.iconButton}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            onPress={() => {
              setQuickDateVisible(false);
              setSearching(true);
            }}
            accessibilityRole="button"
            accessibilityLabel="搜索日程"
          >
            <Ionicons name="search-outline" size={24} color={C.text} testID="schedule-search-icon" />
          </TouchableOpacity>
        </View>
      </View>

      <View style={s.viewIndicator} testID="calendar-view-indicator">
        <View style={s.calendarTab} testID="calendar-view-tab">
          <Text style={s.calendarTabText} testID="calendar-view-tab-label">日历</Text>
          <View style={s.calendarTabLine} testID="calendar-view-tab-indicator" />
        </View>
        <TouchableOpacity
          style={s.viewDrawerButton}
          onPress={() => selectViewMode(viewMode === 'month' ? 'day' : 'month')}
          disabled={!viewMode}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={viewMode
            ? `切换到${viewMode === 'month' ? '单日视图' : '月视图'}`
            : '正在恢复日历视图'}
          accessibilityState={{ disabled: !viewMode }}
          testID="calendar-toggle-view"
        >
          {viewMode ? <Ionicons
            name={viewMode === 'month' ? 'list-outline' : 'calendar-outline'}
            size={20}
            color={C.sub}
            testID="calendar-toggle-view-icon"
          /> : null}
        </TouchableOpacity>
      </View>

      <View style={s.content}>
        {viewMode === 'month' ? (
          <MonthCalendarView
            month={visibleMonth}
            selectedDate={selectedDate}
            events={events}
            onSelectDate={chooseDate}
            onMonthChange={changeMonth}
            onOpenEvent={openEvent}
            onCreate={openManualCreateForDate}
          />
        ) : viewMode === 'day' ? (
          <DayTimelineView
            date={selectedDate}
            events={events}
            onDateChange={chooseDate}
            onOpenEvent={openEvent}
            onCreate={openManualCreateForSlot}
            onChangeEventTime={changeTimelineEventTime}
          />
        ) : <View style={s.viewLoading} testID="schedule-view-loading" />}
        {viewMode && showVisibleMonthLoading ? (
          <View
            style={s.monthLoadingLayer}
            pointerEvents="none"
            accessibilityRole="progressbar"
            accessibilityLabel="正在加载当前月份日程"
            testID="calendar-visible-month-loading"
          >
            <ActivityIndicator size="small" color={C.primary} />
          </View>
        ) : null}
      </View>

      {visibleMonthError ? (
        <View style={s.syncToastLayer} pointerEvents="box-none">
          <TouchableOpacity
            style={s.syncToast}
            onPress={() => { void refreshEvents(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1); }}
            activeOpacity={0.72}
            accessibilityRole="button"
            accessibilityLabel="日程同步失败，点击重试"
            accessibilityHint="当前继续显示本机已有日程"
            testID="calendar-sync-error"
          >
            <Ionicons name="cloud-offline-outline" size={20} color="#FFFFFF" />
            <Text style={s.syncToastText} numberOfLines={2}>同步失败，轻触重试</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {cacheRecoveryNotice ? (
        <View style={s.cacheNoticeLayer} pointerEvents="box-none">
          <View
            style={s.cacheNotice}
            accessibilityRole="alert"
            accessibilityLabel="本机日程缓存已修复，正在重新同步"
            testID="calendar-cache-recovery"
          >
            <Ionicons name="information-circle-outline" size={20} color="#FFFFFF" />
            <Text style={s.cacheNoticeText} numberOfLines={2}>本机日程缓存已修复，正在重新同步</Text>
            <TouchableOpacity
              style={s.cacheNoticeDismiss}
              onPress={() => { void dismissCacheRecoveryNotice(); }}
              accessibilityRole="button"
              accessibilityLabel="关闭缓存恢复提示"
            >
              <Ionicons name="close" size={18} color="#FFFFFF" />
            </TouchableOpacity>
          </View>
        </View>
      ) : null}

      <ScheduleCreateButton
        bottom={BOTTOM_TAB_BAR_GEOMETRY.sceneActionBottom}
        onPress={() => setCreateSheetVisible(true)}
        onVoice={() => setVoiceVisible(true)}
        onManual={openManualCreate}
      />
      </View>

      <AppActionSheet
        visible={createSheetVisible}
        title="新建日程"
        onClose={() => setCreateSheetVisible(false)}
        items={[
          {
            key: 'voice',
            label: '语音输入',
            onPress: () => setVoiceVisible(true),
          },
          {
            key: 'manual',
            label: '手动新建',
            onPress: openManualCreate,
          },
        ]}
      />

      <QuickDatePanel
        visible={quickDatePanelVisible}
        expandProgress={quickDateProgress}
        mode={viewMode === 'month' ? 'yearMonthOnly' : 'dateYearMonth'}
        top={insets.top + TITLE_BAR_HEIGHT}
        month={visibleMonth}
        selectedDate={selectedDate}
        events={events}
        onSelectDate={chooseDate}
        onMonthChange={changeMonth}
        onClose={() => setQuickDateVisible(false)}
      />

      <CalendarSearchPage
        visible={searchPageVisible}
        events={searchableEvents}
        onOpenEvent={openEvent}
        onClose={closeSearch}
      />

      <VoiceInputModal
        visible={voiceVisible}
        onClose={() => setVoiceVisible(false)}
        onSaved={() => setVoiceVisible(false)}
      />
    </ScreenContainer>
  );
}

const s = StyleSheet.create({
  screenContent: { flex: 1, minHeight: 0 },
  titleBar: {
    height: TITLE_BAR_HEIGHT,
    paddingLeft: 10,
    paddingRight: 11,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: C.body,
  },
  profileButton: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  titleButton: {
    flex: 1,
    minWidth: 0,
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 4,
  },
  title: { flexShrink: 1, fontSize: 24, lineHeight: 34, fontWeight: '700', color: C.text },
  titleArrow: {
    width: 22,
    height: 22,
    marginLeft: 6,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: withAlpha(C.sub, 0.10),
  },
  titleArrowTriangle: {
    width: 0,
    height: 0,
    borderLeftWidth: 5,
    borderRightWidth: 5,
    borderTopWidth: 6,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderTopColor: C.sub,
  },
  headerActions: { width: 34, height: 48, justifyContent: 'center', alignItems: 'flex-end' },
  iconButton: { width: 34, height: 48, alignItems: 'flex-end', justifyContent: 'center' },
  viewIndicator: {
    height: 50,
    paddingBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: C.body,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.divider,
  },
  calendarTab: {
    width: 60,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  calendarTabText: { fontSize: 14, lineHeight: 20, fontWeight: '400', color: C.primary },
  calendarTabLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 2,
    borderTopLeftRadius: 2,
    borderTopRightRadius: 2,
    backgroundColor: C.primary,
  },
  viewDrawerButton: { width: 32, height: 32, marginRight: 10, alignItems: 'center', justifyContent: 'center' },
  content: { flex: 1, minHeight: 0, backgroundColor: C.body },
  viewLoading: { flex: 1, backgroundColor: C.body },
  monthLoadingLayer: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: withAlpha(C.body, 0.72),
    zIndex: 2,
  },
  syncToastLayer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 128,
    zIndex: 24,
    alignItems: 'center',
  },
  cacheNoticeLayer: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 172,
    zIndex: 21,
    alignItems: 'center',
  },
  cacheNotice: {
    width: '100%',
    maxWidth: 420,
    minHeight: 48,
    paddingLeft: 14,
    paddingRight: 8,
    paddingVertical: 8,
    borderRadius: 4,
    backgroundColor: withAlpha(C.text, 0.92),
    flexDirection: 'row',
    alignItems: 'center',
  },
  cacheNoticeText: {
    flex: 1,
    minWidth: 0,
    marginLeft: 9,
    fontSize: 14,
    lineHeight: 20,
    color: C.body,
  },
  cacheNoticeDismiss: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  syncToast: {
    maxWidth: '88%',
    minHeight: 40,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: C.text,
  },
  syncToastText: { flexShrink: 1, fontSize: 14, lineHeight: 20, color: C.body },
});
