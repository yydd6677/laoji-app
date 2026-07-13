import React from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { Colors as C } from '../theme/colors';
import { ScreenContainer } from '../components/ScreenContainer';

import { RootStackParamList } from '../types';
import { useEvents } from '../store/EventsStore';
import { BackHeader } from '../components/Common';
import { BottomTabBar, BOTTOM_TAB_BAR_GEOMETRY } from '../components/BottomTabBar';
import { openMeetingsTab, openScheduleTab } from '../navigation/tabTargets';
import { useAppDialog } from '../components/AppDialog';
import { labelForReminder } from '../services/notifications';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'EventDetail'>;
  route: RouteProp<RootStackParamList, 'EventDetail'>;
};

export function EventDetailScreen({ navigation, route }: Props) {
  const { events, deleteEvent } = useEvents();
  const { showDialog } = useAppDialog();
  const ev = events.find(e => e.id === route.params.eventId);

  if (!ev) {
    return (
      <ScreenContainer edges={['top']}>
        <BackHeader title="日程详情" onBack={() => navigation.goBack()} />
        <View style={s.emptyWrap}>
          <Text style={s.emptyTitle}>日程不存在</Text>
          <Text style={s.emptyText}>请返回日程列表后重新打开。</Text>
        </View>
        <BottomTabBar
          active="schedule"
          onSchedule={() => openScheduleTab(navigation)}
          onMeetings={() => openMeetingsTab(navigation)}
        />
      </ScreenContainer>
    );
  }

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    const days = ['日', '一', '二', '三', '四', '五', '六'];
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（周${days[d.getDay()]}）`;
  };
  const dateText = ev.endDate && ev.endDate !== ev.startDate
    ? `${formatDate(ev.startDate)} – ${formatDate(ev.endDate)}`
    : formatDate(ev.startDate);
  const timeText = ev.isAllDay
    ? '全天'
    : ev.startTime && ev.endTime
      ? `${ev.startTime} – ${ev.endTime}`
      : ev.startTime ?? ev.endTime ?? '—';
  const detailText = ev.detail ?? ev.description;

  const infoRows = [
    { icon: 'calendar-outline' as const, text: ev.startDate ? dateText : '—' },
    { icon: 'time-outline' as const,     text: timeText },
    { icon: 'notifications-outline' as const, text: ev.reminderMinutes == null ? '不提醒' : labelForReminder(ev.reminderMinutes) },
    { icon: 'location-outline' as const, text: ev.location ?? '—' },
  ];

  const repeatLabels: Record<string, string> = {
    daily: '每天',
    weekly: '每周',
    monthly: '每月',
    yearly: '每年',
  };

  const handleEdit = () => {
    navigation.navigate('AddEvent', { date: ev.seriesStartDate ?? ev.startDate, eventId: ev.id });
  };

  const handleDelete = () => {
    showDialog({
      title: '确认删除',
      message: ev.repeat && ev.repeat !== 'once'
        ? '这是重复日程。删除后，整个重复系列都会被移除。'
        : '确定要删除这条日程吗？',
      tone: 'danger',
      actions: [
        {
          text: '删除',
          role: 'destructive',
          onPress: async () => {
            try {
              await deleteEvent(ev.id);
              navigation.goBack();
            } catch {
              showDialog({ title: '删除失败', message: '请检查网络后重试', tone: 'error' });
            }
          },
        },
        { text: '取消', role: 'cancel' },
      ],
    });
  };

  return (
    <ScreenContainer edges={['top']}>
      <BackHeader
        title="日程详情"
        onBack={() => navigation.goBack()}
        right={
          <View style={s.headerRight}>
            <TouchableOpacity hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} onPress={handleEdit}>
              <Ionicons name="pencil-outline" size={20} color={C.purple} />
            </TouchableOpacity>
            <TouchableOpacity hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} onPress={handleDelete}>
              <Ionicons name="trash-outline" size={20} color={C.red} />
            </TouchableOpacity>
          </View>
        }
      />
      <ScrollView style={s.scroll} contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
        {/* Title row */}
        <View style={s.titleRow}>
          <View style={[s.colorDot, { backgroundColor: ev.color }]} />
          <Text style={s.titleText}>{ev.title}</Text>
          {ev.category && (
            <View style={[s.catBadge, { backgroundColor: ev.color + '22' }]}>
              <Text style={[s.catText, { color: ev.color }]}>{ev.category}</Text>
            </View>
          )}
        </View>

        {/* Info rows */}
        {infoRows.map(({ icon, text }) => (
          <View key={icon} style={s.infoRow}>
            <View style={s.iconBox}>
              <Ionicons name={icon} size={18} color={C.purple} />
            </View>
            <Text style={s.infoText}>{text}</Text>
          </View>
        ))}

        {ev.repeat && ev.repeat !== 'once' && (
          <View style={s.infoRow}>
            <View style={s.iconBox}>
              <Ionicons name="repeat-outline" size={18} color={C.purple} />
            </View>
            <Text style={s.infoText}>{repeatLabels[ev.repeat] ?? ev.repeat}</Text>
          </View>
        )}

        {detailText && (
          <>
            <Text style={s.detailTitle}>详细内容</Text>
            <Text style={s.detailBody}>{detailText}</Text>
          </>
        )}
      </ScrollView>
      <BottomTabBar
        active="schedule"
        onSchedule={() => openScheduleTab(navigation)}
        onMeetings={() => openMeetingsTab(navigation)}
      />
    </ScreenContainer>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.appBg },
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  emptyTitle: { fontSize: 17, fontWeight: '700', color: C.text, marginBottom: 8 },
  emptyText: { fontSize: 13, color: C.sub, lineHeight: 20 },
  scroll: { flex: 1, backgroundColor: C.card },
  content: { padding: 26, paddingHorizontal: 20, paddingBottom: BOTTOM_TAB_BAR_GEOMETRY.scrollContentClearance },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 28 },
  colorDot: { width: 14, height: 14, borderRadius: 7 },
  titleText: { flex: 1, fontSize: 21, fontWeight: '800', color: C.text },
  catBadge: { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 4 },
  catText: { fontSize: 12, fontWeight: '700' },
  infoRow: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 18 },
  iconBox: { width: 40, height: 40, borderRadius: 12, backgroundColor: C.purpleLight, alignItems: 'center', justifyContent: 'center' },
  infoText: { fontSize: 15, color: '#4A4666', flex: 1 },
  detailTitle: { fontSize: 16, fontWeight: '700', color: C.text, marginTop: 28, marginBottom: 14 },
  detailBody: { fontSize: 14, color: '#4A4666', lineHeight: 26 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 16 },
});
