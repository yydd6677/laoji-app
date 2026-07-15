import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { ScreenContainer } from '../components/ScreenContainer';
import { Avatar } from '../components/Common';
import { BottomTabBar, getBottomTabBarFloatingTopInset } from '../components/BottomTabBar';
import { VoiceInputModal } from '../components/VoiceInputModal';
import { AppActionSheet } from '../components/AppActionSheet';
import { ScheduleCreateButton } from '../components/ScheduleCreateButton';
import { MonthCalendarView } from '../components/MonthCalendarView';
import { DayTimelineView } from '../components/DayTimelineView';
import { QuickDatePanel } from '../components/QuickDatePanel';
import { CalendarSearchPage } from '../components/CalendarSearchPage';
import { useEvents } from '../store/EventsStore';
import { useAuth } from '../store/AuthStore';
import {
  addMonths,
  dateKey,
  formatMonthTitle,
  isSameMonth,
  startOfMonth,
} from '../utils/calendarDate';
import { openMeetingsTab } from '../navigation/tabTargets';
import { Colors as C } from '../theme/colors';
import type { CalEvent, RootStackParamList } from '../types';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'MainTabs'> };
type CalendarViewMode = 'month' | 'day';

const TITLE_BAR_HEIGHT = 60;

export function ScheduleScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const { events, searchableEvents, error: eventsError, refreshEvents } = useEvents();
  const { profile } = useAuth();
  const initialDate = useMemo(() => new Date(), []);
  const [selectedDate, setSelectedDate] = useState(initialDate);
  const [visibleMonth, setVisibleMonth] = useState(() => startOfMonth(initialDate));
  const [viewMode, setViewMode] = useState<CalendarViewMode>('month');
  const [searching, setSearching] = useState(false);
  const [createSheetVisible, setCreateSheetVisible] = useState(false);
  const [quickDateVisible, setQuickDateVisible] = useState(false);
  const [voiceVisible, setVoiceVisible] = useState(false);
  const quickDateProgress = useRef(new Animated.Value(0)).current;

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
    navigation.navigate('EventDetail', { eventId: event.id });
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
  };

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

  const selectViewMode = (mode: CalendarViewMode) => {
    setViewMode(mode);
    setQuickDateVisible(false);
    setVisibleMonth(startOfMonth(selectedDate));
  };

  const closeSearch = () => {
    setSearching(false);
  };

  return (
    <ScreenContainer edges={['top']} bg={C.body}>
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
          onPress={() => setQuickDateVisible(visible => !visible)}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={quickDateVisible
            ? viewMode === 'month' ? '收起年月选择' : '收起日期选择'
            : viewMode === 'month' ? '选择年月' : '展开日期选择'}
          accessibilityState={{ expanded: quickDateVisible }}
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
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={`切换到${viewMode === 'month' ? '单日视图' : '月视图'}`}
          testID="calendar-toggle-view"
        >
          <Ionicons
            name={viewMode === 'month' ? 'list-outline' : 'calendar-outline'}
            size={20}
            color={C.sub}
            testID="calendar-toggle-view-icon"
          />
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
        ) : (
          <DayTimelineView
            date={selectedDate}
            events={events}
            onDateChange={chooseDate}
            onOpenEvent={openEvent}
            onCreate={openManualCreateForSlot}
          />
        )}
      </View>

      {eventsError ? (
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

      <ScheduleCreateButton
        bottom={getBottomTabBarFloatingTopInset(insets.bottom)}
        onPress={() => setCreateSheetVisible(true)}
        onVoice={() => setVoiceVisible(true)}
        onManual={openManualCreate}
      />

      <BottomTabBar
        active="schedule"
        onSchedule={backToday}
        onMeetings={() => openMeetingsTab(navigation)}
      />

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
        visible={!searching && quickDateVisible}
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
        visible={searching}
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
    backgroundColor: 'rgba(100,106,115,0.10)',
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
  syncToastLayer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 128,
    zIndex: 24,
    alignItems: 'center',
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
  syncToastText: { flexShrink: 1, fontSize: 14, lineHeight: 20, color: '#FFFFFF' },
});
