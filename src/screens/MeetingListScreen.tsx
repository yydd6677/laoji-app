import React, { useState, useMemo } from 'react';
import { ActivityIndicator, View, Text, TextInput, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { Colors as C } from '../theme/colors';
import { ScreenContainer } from '../components/ScreenContainer';

import { RootStackParamList } from '../types';
import { MeetingDeletionCleanupError, useMeetings } from '../store/MeetingsStore';
import { Avatar, Tag, Waveform } from '../components/Common';
import { BottomTabBar, BOTTOM_TAB_BAR_GEOMETRY } from '../components/BottomTabBar';
import { useAppDialog } from '../components/AppDialog';
import { useAuth } from '../store/AuthStore';
import { openScheduleTab } from '../navigation/tabTargets';
import { readableErrorMessage } from '../services/errors';
import { canResumeMeetingRecording } from '../utils/meetingMedia';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'MainTabs'> };

function groupMeetings(meetings: ReturnType<typeof import('../store/MeetingsStore').useMeetings>['meetings']) {
  const today = new Date();
  const todayStr = today.getFullYear() + '年' + (today.getMonth() + 1) + '月' + today.getDate() + '日';
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const yesterdayStr = yesterday.getFullYear() + '年' + (yesterday.getMonth() + 1) + '月' + yesterday.getDate() + '日';

  const groups: { label: string; items: (typeof meetings) }[] = [];
  const labelMap: Record<string, number> = {};

  for (const m of meetings) {
    const prefix = m.date ? m.date.slice(0, 11) : '';
    let label: string;
    if ((prefix && todayStr.startsWith(prefix)) || m.date?.startsWith(todayStr)) {
      label = '今天';
    } else if ((prefix && yesterdayStr.startsWith(prefix)) || m.date?.startsWith(yesterdayStr)) {
      label = '昨日';
    } else {
      label = prefix || m.date || '';
    }

    if (labelMap[label] === undefined) {
      labelMap[label] = groups.length;
      groups.push({ label, items: [] });
    }
    groups[labelMap[label]].items.push(m);
  }

  return groups;
}

export function MeetingListScreen({ navigation }: Props) {
  const { meetings, loading, error, deleteMeeting, refreshMeetings } = useMeetings();
  const [searchQuery, setSearchQuery] = useState('');
  const { showDialog } = useAppDialog();
  const { profile } = useAuth();
  const hasCachedMeetings = meetings.length > 0;

  const startMeeting = () => {
    navigation.navigate('MeetingLive');
  };

  const confirmDelete = (id: string) => {
    showDialog({
      title: '删除会议',
      message: '确定删除此会议记录？',
      tone: 'danger',
      actions: [
        {
          text: '删除',
          role: 'destructive',
          onPress: async () => {
            try {
              await deleteMeeting(id);
            } catch (error) {
              if (error instanceof MeetingDeletionCleanupError) {
                showDialog({
                  title: '会议已删除，清理未完成',
                  message: error.message,
                  tone: 'warning',
                });
              } else {
                showDialog({
                  title: '删除失败',
                  message: readableErrorMessage(error, '请检查网络后重试。'),
                  tone: 'error',
                });
              }
            }
          },
        },
        { text: '取消', role: 'cancel' },
      ],
    });
  };

  const openMeetingMenu = (id: string) => {
    const meeting = meetings.find(item => item.id === id);
    showDialog({
      title: '会议操作',
      message: '选择要对这条会议记录执行的操作。',
      tone: 'info',
      actions: [
        ...(meeting && canResumeMeetingRecording(meeting)
          ? [{ text: '继续录音', role: 'primary' as const, onPress: () => navigation.navigate('MeetingLive', { meetingId: id }) }]
          : []),
        { text: '查看详情', role: 'primary', onPress: () => navigation.navigate('Recording', { meetingId: id }) },
        { text: '删除', role: 'destructive', onPress: () => confirmDelete(id) },
        { text: '取消', role: 'cancel' },
      ],
    });
  };

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return meetings;
    return meetings.filter(m =>
      m.title.toLowerCase().includes(q) ||
      m.tags.some(t => t.label.toLowerCase().includes(q))
    );
  }, [meetings, searchQuery]);

  const grouped = useMemo(() => {
    return groupMeetings(filtered);
  }, [filtered]);

  return (
    <ScreenContainer edges={['top']}>
      <View style={s.header}>
        <Text style={s.title}>会议记录</Text>
        <View style={s.headerActions}>
          <TouchableOpacity
            style={s.speakerButton}
            onPress={() => navigation.navigate('SpeakerManager')}
            accessibilityRole="button"
            accessibilityLabel="管理讲话人"
            testID="meetings-open-speakers"
          >
            <Ionicons name="people-outline" size={20} color={C.purple} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => navigation.navigate('Profile')}
            accessibilityRole="button"
            accessibilityLabel="打开个人资料"
            testID="meetings-open-profile"
          >
            <Avatar size={36} profile={profile} />
          </TouchableOpacity>
        </View>
      </View>

      <View style={s.searchBar}>
        <Ionicons name="search-outline" size={14} color={C.sub} />
        <TextInput
          style={s.searchInput}
          value={searchQuery}
          onChangeText={setSearchQuery}
          placeholder="搜索会议、主题、标签"
          placeholderTextColor={C.faint}
        />
      </View>

      <View style={s.listArea}>
        <ScrollView style={s.scroll} showsVerticalScrollIndicator={false} contentContainerStyle={s.content}>
          {loading && meetings.length === 0 ? (
            <View style={s.stateBox}>
              <ActivityIndicator color={C.purple} />
              <Text style={s.stateText}>正在加载会议记录…</Text>
            </View>
          ) : null}
          {error && !hasCachedMeetings ? (
            <View style={s.stateBox}>
              <Text style={s.stateTitle}>会议服务暂时不可用</Text>
              <Text style={s.stateText}>请稍后重试，或确认手机网络能访问会议服务。</Text>
              <TouchableOpacity style={s.retryBtn} onPress={refreshMeetings}>
                <Text style={s.retryText}>重试</Text>
              </TouchableOpacity>
            </View>
          ) : null}
          {!loading && !error && grouped.length === 0 ? (
            <View style={s.stateBox}>
              <Text style={s.stateTitle}>暂无会议记录</Text>
              <Text style={s.stateText}>点击底部“记录会议”开始录音，转写和总结会保存在这里。</Text>
            </View>
          ) : null}
          {grouped.map(group => (
            <View key={group.label}>
              <Text style={s.groupLabel}>{group.label}</Text>
              {group.items.map(m => (
                <TouchableOpacity
                  key={m.id}
                  style={s.card}
                  onPress={() => navigation.navigate('Recording', { meetingId: m.id })}
                  onLongPress={() => confirmDelete(m.id)}
                  activeOpacity={0.85}
                >
                  <View style={s.cardTop}>
                    <View style={{ flex: 1 }}>
                      <Text style={s.cardTitle}>{m.title}</Text>
                      <Text style={s.cardMeta}>{m.time}　{m.duration}</Text>
                    </View>
                    <TouchableOpacity
                      onPress={() => openMeetingMenu(m.id)}
                      hitSlop={{ top:8,bottom:8,left:8,right:8 }}
                      accessibilityRole="button"
                      accessibilityLabel={`打开${m.title}的更多操作`}
                    >
                      <Ionicons name="ellipsis-horizontal" size={18} color={C.faint} />
                    </TouchableOpacity>
                  </View>
                  <View style={s.waveWrap}>
                    <Waveform bars={m.audioBars ?? m.bars ?? []} color={C.purple} height={30} />
                  </View>
                  <View style={s.tags}>
                    {m.tags.map(t => <Tag key={t.label} label={t.label} color={t.color} />)}
                  </View>
                </TouchableOpacity>
              ))}
            </View>
          ))}
        </ScrollView>

        {error && hasCachedMeetings ? (
          <View style={s.cachedError} accessibilityRole="alert" testID="meeting-cache-error">
            <Ionicons name="cloud-offline-outline" size={16} color={C.red} />
            <Text style={s.cachedErrorText} numberOfLines={1}>同步失败，正在显示本机缓存</Text>
            <TouchableOpacity
              style={s.cachedRetry}
              onPress={refreshMeetings}
              accessibilityRole="button"
              accessibilityLabel="重新同步会议记录"
            >
              <Ionicons name="refresh" size={17} color={C.purple} />
            </TouchableOpacity>
          </View>
        ) : null}
      </View>

      <BottomTabBar
        active="meetings"
        onSchedule={() => openScheduleTab(navigation)}
        onMeetings={() => {}}
        onMic={startMeeting}
      />
    </ScreenContainer>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.appBg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10 },
  title: { fontSize: 22, fontWeight: '800', color: C.text },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  speakerButton: { width: 36, height: 36, borderRadius: 18, backgroundColor: C.purpleLight, alignItems: 'center', justifyContent: 'center' },
  searchBar: { marginHorizontal: 14, marginBottom: 12, height: 38, backgroundColor: C.inputBg, borderRadius: 19, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 8 },
  searchPlaceholder: { fontSize: 13, color: C.faint },
  searchInput: { flex: 1, fontSize: 13, color: C.text, padding: 0 },
  listArea: { flex: 1, minHeight: 0 },
  scroll: { flex: 1 },
  content: { paddingBottom: BOTTOM_TAB_BAR_GEOMETRY.scrollContentClearance },
  groupLabel: { fontSize: 12, color: C.sub, fontWeight: '600', paddingHorizontal: 18, paddingVertical: 6, letterSpacing: 0.5 },
  card: {
    marginHorizontal: 14, marginBottom: 10, backgroundColor: C.card, borderRadius: 16, padding: 14,
    shadowColor: '#5028A0', shadowOffset: { width:0,height:1 }, shadowOpacity:0.06, shadowRadius:10, elevation:2,
  },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 6 },
  cardTitle: { fontSize: 15, fontWeight: '700', color: C.text, marginBottom: 4 },
  cardMeta: { fontSize: 12, color: C.sub },
  waveWrap: { marginVertical: 10 },
  tags: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  stateBox: { marginHorizontal: 14, marginTop: 16, backgroundColor: C.card, borderRadius: 16, padding: 18, alignItems: 'center', gap: 10 },
  stateTitle: { fontSize: 15, fontWeight: '700', color: C.text },
  stateText: { fontSize: 12, color: C.sub, textAlign: 'center', lineHeight: 18 },
  retryBtn: { marginTop: 4, backgroundColor: C.purple, borderRadius: 18, paddingHorizontal: 18, paddingVertical: 9 },
  retryText: { fontSize: 13, color: '#fff', fontWeight: '700' },
  cachedError: {
    position: 'absolute',
    top: 4,
    left: 14,
    right: 14,
    height: 38,
    zIndex: 20,
    elevation: 8,
    borderRadius: 8,
    paddingLeft: 12,
    paddingRight: 5,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#FFF7F7',
    borderWidth: 1,
    borderColor: '#F3C7CA',
  },
  cachedErrorText: { flex: 1, minWidth: 0, fontSize: 12, color: C.red, fontWeight: '600' },
  cachedRetry: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
});
