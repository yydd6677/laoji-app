import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, TextInput,
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

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'MainTabs'> };

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

  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  const WDN = ['周日','周一','周二','周三','周四','周五','周六'];
  const todayLabel = `${today.getFullYear()}年${today.getMonth()+1}月${today.getDate()}日 ${WDN[today.getDay()]}`;

  const todayEvents = useMemo(() =>
    events.filter(e => e.startDate === todayStr && e.startTime).slice(0, 5),
    [events, todayStr]
  );

  const eventSearchResults = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const q = searchQuery.toLowerCase();
    return events.filter(e => [
      e.title,
      e.startDate,
      e.startTime,
      e.endTime,
      e.location,
      e.description,
      e.detail,
      e.category,
    ].filter(Boolean).some(value => String(value).toLowerCase().includes(q)));
  }, [events, searchQuery]);

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

  const fmtTime = (e: CalEvent) => {
    if (e.startTime && e.endTime) return `${e.startTime} – ${e.endTime}`;
    if (e.startTime) return e.startTime;
    if (e.spanning && e.endDate)
      return `${e.startDate.slice(5).replace('-','月')}日 – ${e.endDate.slice(5).replace('-','月')}日`;
    return '全天';
  };

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
              <Text style={s.todayTitle}>今日待办</Text>
              <Text style={s.todayDate}>{todayLabel}</Text>
            </View>
            {todayEvents.length === 0
              ? <Text style={s.noTask}>今日暂无待办</Text>
              : todayEvents.map((t, i) => (
                <TouchableOpacity
                  key={t.id}
                  style={[s.taskRow, i > 0 && s.taskBorder]}
                  onPress={() => navigation.navigate('EventDetail', { eventId: t.id })}
                >
                  <View style={[s.taskDot, { backgroundColor: t.color }]} />
                  <Text style={s.taskTitle}>{t.title}</Text>
                  <Text style={s.taskTime}>{t.startTime}</Text>
                </TouchableOpacity>
              ))
            }
          </View>

          {/* Calendar */}
          <CalGrid
            year={year} month={month} selDay={selDay}
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
  todayTitle: { fontSize: 14, fontWeight: '700', color: C.text },
  todayDate: { fontSize: 12, color: C.sub },
  taskRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9 },
  taskBorder: { borderTopWidth: 1, borderTopColor: 'rgba(255,150,200,0.2)' },
  taskDot: { width: 10, height: 10, borderRadius: 5 },
  taskTitle: { flex: 1, fontSize: 14, fontWeight: '500', color: C.text },
  noTask: { fontSize: 13, color: C.faint, paddingVertical: 8, textAlign: 'center' },
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
