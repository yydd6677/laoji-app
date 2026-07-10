import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, RefreshControl } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { Colors as C } from '../theme/colors';
import { ScreenContainer } from '../components/ScreenContainer';

import { RootStackParamList, CalEvent } from '../types';
import { useEvents } from '../store/EventsStore';
import { BackHeader } from '../components/Common';
import { CalGrid } from '../components/CalGrid';
import { BottomTabBar } from '../components/BottomTabBar';
import { openMeetingsTab, openScheduleTab } from '../navigation/tabTargets';
import { useAppDialog } from '../components/AppDialog';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Calendar'> };

const WDN = ['周日','周一','周二','周三','周四','周五','周六'];

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function relativeDayLabel(selectedDate: Date, today: Date): string {
  const msPerDay = 24 * 60 * 60 * 1000;
  const diff = Math.round((startOfLocalDay(selectedDate).getTime() - startOfLocalDay(today).getTime()) / msPerDay);
  if (diff === 0) return '';
  return diff > 0 ? `${diff}天后` : `${Math.abs(diff)}天前`;
}

export function CalendarScreen({ navigation }: Props) {
  const initialDate = useMemo(() => new Date(), []);
  const [year, setYear]     = useState(() => initialDate.getFullYear());
  const [month, setMonth]   = useState(() => initialDate.getMonth() + 1);
  const [selDay, setSelDay] = useState(() => initialDate.getDate());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const { events, deleteEvent, refreshEvents } = useEvents();
  const { showDialog } = useAppDialog();

  const prev = () => month === 1 ? (setMonth(12), setYear(y => y - 1)) : setMonth(m => m - 1);
  const next = () => month === 12 ? (setMonth(1), setYear(y => y + 1)) : setMonth(m => m + 1);

  const ds = `${year}-${String(month).padStart(2,'0')}-${String(selDay).padStart(2,'0')}`;
  const selectedDate = new Date(year, month - 1, selDay);
  const wday = WDN[selectedDate.getDay()];
  const selectedRelativeLabel = relativeDayLabel(selectedDate, new Date());
  const dayEvts = events.filter(e =>
    e.spanning && e.endDate ? ds >= e.startDate && ds <= e.endDate : e.startDate === ds
  );

  const fmtTime = (e: CalEvent) => {
    if (e.startTime && e.endTime) return `${e.startTime} – ${e.endTime}`;
    if (e.spanning && e.endDate)
      return `${e.startDate.slice(5).replace('-','月')}日 – ${e.endDate.slice(5).replace('-','月')}日`;
    return '全天';
  };

  const handleCardPress = (id: string) => {
    setSelectedId(prev => prev === id ? null : id);
  };

  const handleDelete = () => {
    if (!selectedId) {
      showDialog({ title: '提示', message: '请先点击选择一个日程再删除', tone: 'info' });
      return;
    }
    const id = selectedId;
    showDialog({
      title: '确认删除',
      message: '确定要删除这条日程吗？',
      tone: 'danger',
      actions: [
        {
          text: '删除',
          role: 'destructive',
          onPress: async () => {
            try {
              await deleteEvent(id);
              setSelectedId(null);
            } catch {
              showDialog({ title: '删除失败', message: '请检查网络后重试', tone: 'error' });
            }
          },
        },
        { text: '取消', role: 'cancel' },
      ],
    });
  };

  useEffect(() => {
    const daysInMonth = new Date(year, month, 0).getDate();
    setSelDay(day => Math.min(day, daysInMonth));
    setSelectedId(null);
    refreshEvents(year, month);
  }, [year, month, refreshEvents]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshEvents(year, month);
    } finally {
      setRefreshing(false);
    }
  }, [year, month, refreshEvents]);

  return (
    <ScreenContainer edges={['top']}>
      <BackHeader
        title={`日历 · ${year}年${month}月`}
        onBack={() => navigation.goBack()}
      />
      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.content}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.purple} />
        }
      >
        <View style={{ height: 14 }} />
        <CalGrid year={year} month={month} selDay={selDay} onDay={setSelDay} onPrev={prev} onNext={next} events={events} />

        <View style={s.divider} />

        <View style={s.dayHeader}>
          <Text style={s.dayLabel}>{month}月{selDay}日（{wday}）</Text>
          {selectedRelativeLabel ? <Text style={s.relativePill}>{selectedRelativeLabel}</Text> : null}
        </View>

        <View style={s.eventList}>
          {dayEvts.length === 0
            ? <Text style={s.empty}>{selectedRelativeLabel ? '当日暂无日程' : '今日暂无日程'}</Text>
            : dayEvts.map(e => {
                const isSelected = selectedId === e.id;
                return (
                  <TouchableOpacity
                    key={e.id}
                    style={[s.eventCard, isSelected && s.eventCardSelected]}
                    onPress={() => handleCardPress(e.id)}
                    activeOpacity={0.8}
                  >
                    <View style={[s.evDot, { backgroundColor: e.color }]} />
                    <View style={s.evBody}>
                      <Text style={s.evTitle} numberOfLines={1}>
                        {e.title}
                        {e.status && <Text style={s.evStatus}>（{e.status}）</Text>}
                      </Text>
                      <Text style={s.evTime}>{fmtTime(e)}</Text>
                    </View>
                    <TouchableOpacity
                      onPress={() => navigation.navigate('EventDetail', { eventId: e.id })}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <Ionicons name="chevron-forward" size={16} color={C.faint} />
                    </TouchableOpacity>
                  </TouchableOpacity>
                );
              })
          }
        </View>

        <View style={s.btnRow}>
          <TouchableOpacity
            style={[s.btn, { borderColor: C.purple }]}
            onPress={() => navigation.navigate('AddEvent', { date: ds })}
          >
            <Ionicons name="add" size={14} color={C.purple} />
            <Text style={[s.btnText, { color: C.purple }]}>新增事件</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.btn, { borderColor: C.red }]} onPress={handleDelete}>
            <Ionicons name="trash-outline" size={14} color={C.red} />
            <Text style={[s.btnText, { color: C.red }]}>删除事件</Text>
          </TouchableOpacity>
        </View>
        <View style={{ height: 16 }} />
      </ScrollView>
      <BottomTabBar active="schedule" onSchedule={() => openScheduleTab(navigation)} onMeetings={() => openMeetingsTab(navigation)} />
    </ScreenContainer>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.appBg },
  scroll: { flex: 1 },
  content: { paddingBottom: 8 },
  divider: { height: 1, backgroundColor: C.border, marginHorizontal: 14, marginTop: 14 },
  dayHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 18, paddingTop: 14, paddingBottom: 12 },
  dayLabel: { fontSize: 14, fontWeight: '700', color: C.text },
  relativePill: { fontSize: 11, lineHeight: 16, color: C.purple, fontWeight: '800', backgroundColor: C.purpleLight, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 2, overflow: 'hidden' },
  eventList: { paddingHorizontal: 14, gap: 10 },
  empty: { textAlign: 'center', paddingVertical: 28, color: C.faint, fontSize: 13 },
  eventCard: {
    backgroundColor: C.card, borderRadius: 14, padding: 12, paddingHorizontal: 14,
    flexDirection: 'row', alignItems: 'center', gap: 10,
    shadowColor: '#5028A0', shadowOffset: { width:0, height:1 }, shadowOpacity:0.06, shadowRadius:10, elevation:2,
    borderWidth: 1.5, borderColor: 'transparent',
  },
  eventCardSelected: {
    borderColor: '#7C3AED',
    backgroundColor: '#F5F0FF',
  },
  evDot: { width: 9, height: 9, borderRadius: 5 },
  evBody: { flex: 1 },
  evTitle: { fontSize: 14, fontWeight: '600', color: C.text, marginBottom: 3 },
  evStatus: { fontWeight: '400', color: C.sub, fontSize: 12 },
  evTime: { fontSize: 12, color: '#A09CC0' },
  btnRow: { flexDirection: 'row', gap: 12, marginHorizontal: 14, marginTop: 18, marginBottom: 4 },
  btn: { flex: 1, height: 42, borderRadius: 21, borderWidth: 1.5, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 },
  btnText: { fontSize: 13, fontWeight: '600' },
});
