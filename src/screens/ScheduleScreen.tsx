import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  NativeScrollEvent, NativeSyntheticEvent, View, Text, TouchableOpacity, StyleSheet, ScrollView, TextInput,
} from 'react-native';
import { VoiceInputModal } from '../components/VoiceInputModal';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Colors as C } from '../theme/colors';
import { ScreenContainer } from '../components/ScreenContainer';
import { RootStackParamList, CalEvent } from '../types';
import { Avatar } from '../components/Common';
import { useEvents } from '../store/EventsStore';
import { CalGrid } from '../components/CalGrid';
import { BottomTabBar } from '../components/BottomTabBar';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../store/AuthStore';
import { useMeetings } from '../store/MeetingsStore';
import { selectTasksForDate } from '../utils/taskOrdering';
import { sortEventsForSearch } from '../utils/eventOrdering';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'MainTabs'> };
const TASK_VISIBLE_ROWS = 4;
const TASK_ROW_HEIGHT = 38;
const TASK_LIST_MAX_HEIGHT = TASK_VISIBLE_ROWS * TASK_ROW_HEIGHT;

function dateKey(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function relativeDayLabel(selectedDate: Date, today: Date): string {
  const msPerDay = 24 * 60 * 60 * 1000;
  const diff = Math.round((startOfLocalDay(selectedDate).getTime() - startOfLocalDay(today).getTime()) / msPerDay);
  if (diff === 0) return '';
  return diff > 0 ? `${diff}天后` : `${Math.abs(diff)}天前`;
}

export function ScheduleScreen({ navigation }: Props) {
  const { events, refreshEvents } = useEvents();
  const { meetings } = useMeetings();
  const { profile } = useAuth();
  const initialDate = useMemo(() => new Date(), []);
  const [year, setYear]   = useState(() => initialDate.getFullYear());
  const [month, setMonth] = useState(() => initialDate.getMonth() + 1);
  const [selDay, setSelDay] = useState(() => initialDate.getDate());
  const [searchQuery, setSearchQuery] = useState('');
  const [voiceVisible, setVoiceVisible] = useState(false);
  const taskScrollRef = useRef<ScrollView | null>(null);
  const [taskScrollY, setTaskScrollY] = useState(0);
  const [taskViewportHeight, setTaskViewportHeight] = useState(TASK_LIST_MAX_HEIGHT);
  const [taskContentHeight, setTaskContentHeight] = useState(TASK_LIST_MAX_HEIGHT);

  const today = new Date();
  const todayStr = dateKey(today.getFullYear(), today.getMonth() + 1, today.getDate());
  const WDN = ['周日','周一','周二','周三','周四','周五','周六'];
  const daysInSelectedMonth = new Date(year, month, 0).getDate();
  const selectedDay = Math.min(selDay, daysInSelectedMonth);
  const selectedDate = useMemo(() => new Date(year, month - 1, selectedDay), [year, month, selectedDay]);
  const selectedDateStr = dateKey(year, month, selectedDay);
  const isTodaySelected = selectedDateStr === todayStr;
  const selectedDateLabel = `${year}年${month}月${selectedDay}日 ${WDN[selectedDate.getDay()]}`;
  const selectedRelativeLabel = relativeDayLabel(selectedDate, today);

  const selectedTasks = useMemo(
    () => selectTasksForDate(events, selectedDateStr),
    [events, selectedDateStr],
  );
  const hasTaskOverflow = selectedTasks.length > TASK_VISIBLE_ROWS;
  const taskViewportForThumb = Math.max(1, taskViewportHeight || TASK_LIST_MAX_HEIGHT);
  const taskContentForThumb = Math.max(taskContentHeight, selectedTasks.length * TASK_ROW_HEIGHT);
  const taskThumbHeight = hasTaskOverflow
    ? Math.max(24, (taskViewportForThumb * taskViewportForThumb) / taskContentForThumb)
    : 0;
  const taskMaxScrollY = Math.max(1, taskContentForThumb - taskViewportForThumb);
  const taskThumbTop = hasTaskOverflow
    ? Math.min(
      taskViewportForThumb - taskThumbHeight,
      (Math.max(0, taskScrollY) / taskMaxScrollY) * (taskViewportForThumb - taskThumbHeight),
    )
    : 0;
  const taskPlaceholderCount = hasTaskOverflow
    ? 0
    : Math.max(0, TASK_VISIBLE_ROWS - selectedTasks.length);

  const eventSearchResults = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const q = searchQuery.toLowerCase();
    const matches = events.filter(e => [
      e.title,
      e.startDate,
      e.startTime,
      e.endTime,
      e.location,
      e.description,
      e.detail,
      e.category,
    ].filter(Boolean).some(value => String(value).toLowerCase().includes(q)));
    return sortEventsForSearch(matches, today);
  }, [events, searchQuery, todayStr]);

  const meetingSearchResults = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const q = searchQuery.toLowerCase();
    return meetings.filter(m => [
      m.title,
      m.date,
      m.time,
      m.duration,
      ...(m.tags ?? []).map(t => t.label),
    ].filter(Boolean).some(value => String(value).toLowerCase().includes(q)));
  }, [meetings, searchQuery]);

  const prev = () => month === 1 ? (setMonth(12), setYear(y => y - 1)) : setMonth(m => m - 1);
  const next = () => month === 12 ? (setMonth(1), setYear(y => y + 1)) : setMonth(m => m + 1);

  useEffect(() => {
    const daysInMonth = new Date(year, month, 0).getDate();
    setSelDay(day => Math.min(day, daysInMonth));
    refreshEvents(year, month);
  }, [year, month, refreshEvents]);

  useEffect(() => {
    taskScrollRef.current?.scrollTo({ y: 0, animated: false });
    setTaskScrollY(0);
    setTaskViewportHeight(TASK_LIST_MAX_HEIGHT);
    setTaskContentHeight(Math.max(TASK_LIST_MAX_HEIGHT, selectedTasks.length * TASK_ROW_HEIGHT));
  }, [selectedDateStr, selectedTasks.length]);

  const handleTaskScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    setTaskScrollY(event.nativeEvent.contentOffset.y);
  };

  const fmtTime = (e: CalEvent) => {
    if (e.startTime && e.endTime) return `${e.startTime} – ${e.endTime}`;
    if (e.startTime) return e.startTime;
    if (e.spanning && e.endDate)
      return `${e.startDate.slice(5).replace('-','月')}日 – ${e.endDate.slice(5).replace('-','月')}日`;
    return '全天';
  };

  const renderTaskRow = (task: CalEvent, index: number) => (
    <TouchableOpacity
      key={task.id}
      style={[s.taskRow, index > 0 && s.taskBorder]}
      onPress={() => navigation.navigate('EventDetail', { eventId: task.id })}
      activeOpacity={0.82}
    >
      <View style={[s.taskDot, { backgroundColor: task.color }]} />
      <Text style={s.taskTitle} numberOfLines={1}>{task.title}</Text>
      <Text style={s.taskTime}>{fmtTime(task)}</Text>
    </TouchableOpacity>
  );

  const renderTaskPlaceholder = (index: number) => (
    <View
      key={`task-placeholder-${index}`}
      pointerEvents="none"
      style={[
        s.taskRow,
        (selectedTasks.length > 0 || index > 0) && s.taskBorder,
        s.taskPlaceholder,
      ]}
    />
  );

  return (
    <ScreenContainer edges={['top']}>
      {/* Header */}
      <View style={s.header}>
        <Text style={s.title}>日程</Text>
        <View style={s.searchBar}>
          <Ionicons name="search-outline" size={13} color={C.sub} />
          <TextInput
            style={s.searchInput}
            placeholder="搜索日程、会议、时间"
            placeholderTextColor={C.faint}
            value={searchQuery}
            onChangeText={setSearchQuery}
            returnKeyType="search"
            clearButtonMode="never"
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={() => setSearchQuery('')} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
              <Ionicons name="close-circle" size={15} color={C.sub} />
            </TouchableOpacity>
          )}
        </View>
        <TouchableOpacity onPress={() => navigation.navigate('Profile')}>
          <Avatar size={36} profile={profile} />
        </TouchableOpacity>
      </View>

      {searchQuery.trim().length > 0 ? (
        /* Search results view */
        <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent} showsVerticalScrollIndicator={false}>
          {(() => {
            const total = eventSearchResults.length + meetingSearchResults.length;
            return (
              <Text style={s.searchResultLabel}>
                {total > 0 ? `找到 ${total} 条结果` : '无匹配结果'}
              </Text>
            );
          })()}
          {eventSearchResults.length > 0 && <Text style={s.searchSectionLabel}>日程</Text>}
          <View style={s.eventList}>
            {eventSearchResults.map(e => (
              <TouchableOpacity
                key={e.id}
                style={s.eventCard}
                onPress={() => navigation.navigate('EventDetail', { eventId: e.id })}
                activeOpacity={0.8}
              >
                <View style={[s.evDot, { backgroundColor: e.color }]} />
                <View style={s.evBody}>
                  <Text style={s.evTitle} numberOfLines={1}>{e.title}</Text>
                  <Text style={s.evTime}>{e.startDate}  {fmtTime(e)}</Text>
                </View>
                <Ionicons name="chevron-forward" size={15} color={C.faint} />
              </TouchableOpacity>
            ))}
          </View>

          {meetingSearchResults.length > 0 && <Text style={s.searchSectionLabel}>会议</Text>}
          <View style={s.eventList}>
            {meetingSearchResults.map(m => (
              <TouchableOpacity
                key={m.id}
                style={s.eventCard}
                onPress={() => navigation.navigate('Recording', { meetingId: m.id })}
                activeOpacity={0.8}
              >
                <View style={[s.evDot, { backgroundColor: C.teal }]} />
                <View style={s.evBody}>
                  <Text style={s.evTitle} numberOfLines={1}>{m.title}</Text>
                  <Text style={s.evTime}>{[m.date, m.time].filter(Boolean).join('  ')}</Text>
                </View>
                <Ionicons name="chevron-forward" size={15} color={C.faint} />
              </TouchableOpacity>
            ))}
          </View>
          <View style={{ height: 16 }} />
        </ScrollView>
      ) : (
        /* Normal calendar + today's tasks view */
        <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent} showsVerticalScrollIndicator={false}>
          {/* 今日待办 */}
          <View style={s.todayCard}>
            <View style={s.todayHeader}>
              <View style={s.todayTitleWrap}>
                <Text style={s.todayTitle}>{isTodaySelected ? '今日待办' : '当日待办'}</Text>
                {selectedRelativeLabel ? <Text style={s.relativePill}>{selectedRelativeLabel}</Text> : null}
              </View>
              <Text style={s.todayDate}>{selectedDateLabel}</Text>
            </View>
            <View style={s.taskListShell}>
              <View style={[s.taskScrollTrack, !hasTaskOverflow && s.taskScrollTrackHidden]} pointerEvents="none">
                {hasTaskOverflow ? (
                  <View
                    style={[
                      s.taskScrollThumb,
                      { height: taskThumbHeight, transform: [{ translateY: taskThumbTop }] },
                    ]}
                  />
                ) : null}
              </View>
              {hasTaskOverflow ? (
                <ScrollView
                  ref={taskScrollRef}
                  style={s.taskScroll}
                  nestedScrollEnabled
                  showsVerticalScrollIndicator={false}
                  scrollEventThrottle={16}
                  onLayout={event => setTaskViewportHeight(event.nativeEvent.layout.height)}
                  onContentSizeChange={(_, height) => setTaskContentHeight(height)}
                  onScroll={handleTaskScroll}
                >
                  {selectedTasks.map(renderTaskRow)}
                </ScrollView>
              ) : (
                <View style={s.taskStaticList}>
                  {selectedTasks.map(renderTaskRow)}
                  {Array.from({ length: taskPlaceholderCount }, (_, index) => renderTaskPlaceholder(index))}
                </View>
              )}
              {selectedTasks.length === 0 ? (
                <View pointerEvents="none" style={s.noTaskOverlay}>
                  <Text style={s.noTask}>{isTodaySelected ? '今日暂无待办' : '当日暂无待办'}</Text>
                </View>
              ) : null}
            </View>
          </View>

          {/* Calendar */}
          <CalGrid
            year={year} month={month} selDay={selectedDay}
            onDay={setSelDay} onPrev={prev} onNext={next}
            onTitle={() => navigation.navigate('Calendar')}
            events={events}
          />
          <View style={{ height: 16 }} />
        </ScrollView>
      )}

      <BottomTabBar
        active="schedule"
        onSchedule={() => {}}
        onMeetings={() => (navigation as any).navigate('Meetings')}
        onMic={() => setVoiceVisible(true)}
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
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10 },
  title: { fontSize: 22, fontWeight: '800', color: C.text },
  searchBar: { flex: 1, height: 34, backgroundColor: C.inputBg, borderRadius: 17, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, gap: 8 },
  searchInput: { flex: 1, fontSize: 12, color: C.text, paddingVertical: 0 },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 8 },
  /* Today card */
  todayCard: { margin: 14, marginBottom: 16, backgroundColor: C.tasksBg, borderRadius: 18, padding: 14, paddingHorizontal: 16 },
  todayHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  todayTitleWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  todayTitle: { fontSize: 14, fontWeight: '700', color: C.text },
  todayDate: { fontSize: 12, color: C.sub },
  relativePill: { fontSize: 11, lineHeight: 16, color: C.purple, fontWeight: '800', backgroundColor: C.purpleLight, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 2, overflow: 'hidden' },
  taskListShell: { position: 'relative', height: TASK_LIST_MAX_HEIGHT, paddingLeft: 10 },
  taskStaticList: { height: TASK_LIST_MAX_HEIGHT },
  taskScroll: { height: TASK_LIST_MAX_HEIGHT },
  taskScrollTrack: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, borderRadius: 2, backgroundColor: 'rgba(123,92,184,0.14)' },
  taskScrollTrackHidden: { opacity: 0 },
  taskScrollThumb: { width: 3, borderRadius: 2, backgroundColor: C.purple },
  taskRow: { height: TASK_ROW_HEIGHT, flexDirection: 'row', alignItems: 'center', gap: 10 },
  taskPlaceholder: { opacity: 0 },
  taskBorder: { borderTopWidth: 1, borderTopColor: 'rgba(255,150,200,0.2)' },
  taskDot: { width: 10, height: 10, borderRadius: 5 },
  taskTitle: { flex: 1, fontSize: 14, fontWeight: '500', color: C.text },
  noTaskOverlay: { position: 'absolute', left: 10, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  noTask: { fontSize: 13, color: C.faint, textAlign: 'center' },
  taskTime: { fontSize: 13, color: C.sub, fontWeight: '500' },
  /* Search results */
  searchResultLabel: { fontSize: 13, color: C.sub, paddingHorizontal: 18, paddingTop: 14, paddingBottom: 10 },
  searchSectionLabel: { fontSize: 12, color: C.sub, fontWeight: '700', paddingHorizontal: 18, paddingBottom: 8 },
  eventList: { paddingHorizontal: 14, gap: 10 },
  eventCard: {
    backgroundColor: C.card, borderRadius: 14, padding: 12, paddingHorizontal: 14,
    flexDirection: 'row', alignItems: 'center', gap: 10,
    shadowColor: '#5028A0', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 10, elevation: 2,
    borderWidth: 1.5, borderColor: 'transparent',
  },
  evDot: { width: 9, height: 9, borderRadius: 5 },
  evBody: { flex: 1 },
  evTitle: { fontSize: 14, fontWeight: '600', color: C.text, marginBottom: 3 },
  evTime: { fontSize: 12, color: '#A09CC0' },
});
