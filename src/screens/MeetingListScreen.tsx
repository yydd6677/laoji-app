import React, { useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import type { CompositeNavigationProp } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { Colors as C } from '../theme/colors';
import { ScreenContainer } from '../components/ScreenContainer';
import type { MainTabsParamList, RootStackParamList } from '../types';
import { MeetingDeletionCleanupError, useMeetings } from '../store/MeetingsStore';
import { BOTTOM_TAB_BAR_GEOMETRY } from '../components/BottomTabBar';
import { useAppDialog } from '../components/AppDialog';
import { AppActionSheet, AppActionSheetItem } from '../components/AppActionSheet';
import { MeetingListItem } from '../components/MeetingListItem';
import { MeetingSearchPage } from '../components/MeetingSearchPage';
import { readableErrorMessage } from '../services/errors';
import { canResumeMeetingRecording } from '../utils/meetingMedia';

type MeetingListNavigationProp = CompositeNavigationProp<
  BottomTabNavigationProp<MainTabsParamList, 'Meetings'>,
  NativeStackNavigationProp<RootStackParamList>
>;
type Props = { navigation: MeetingListNavigationProp };

export function MeetingListScreen({ navigation }: Props) {
  const { meetings, loading, error, deleteMeeting, refreshMeetings } = useMeetings();
  const { showDialog } = useAppDialog();
  const [searchVisible, setSearchVisible] = useState(false);
  const [appMenuVisible, setAppMenuVisible] = useState(false);
  const [meetingMenuId, setMeetingMenuId] = useState<string | null>(null);
  const hasCachedMeetings = meetings.length > 0;
  const menuMeeting = meetings.find(meeting => meeting.id === meetingMenuId);

  const openMeeting = (meetingId: string) => {
    navigation.navigate('Transcription', { meetingId });
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
            } catch (deleteError) {
              if (deleteError instanceof MeetingDeletionCleanupError) {
                showDialog({
                  title: '会议已删除，清理未完成',
                  message: deleteError.message,
                  tone: 'warning',
                });
              } else {
                showDialog({
                  title: '删除失败',
                  message: readableErrorMessage(deleteError, '请检查网络后重试。'),
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

  const appMenuItems: AppActionSheetItem[] = [
    {
      key: 'speakers',
      label: '管理讲话人',
      onPress: () => navigation.navigate('SpeakerManager'),
    },
    {
      key: 'profile',
      label: '个人资料',
      onPress: () => navigation.navigate('Profile'),
    },
  ];

  const meetingMenuItems: AppActionSheetItem[] = menuMeeting ? [
    ...(canResumeMeetingRecording(menuMeeting) ? [{
      key: 'resume',
      label: '继续录音',
      onPress: () => navigation.navigate('MeetingLive', { meetingId: menuMeeting.id }),
    }] : []),
    {
      key: 'rename',
      label: '重命名',
      onPress: () => navigation.navigate('Transcription', { meetingId: menuMeeting.id, focus: 'title' }),
    },
    ...(!canResumeMeetingRecording(menuMeeting) ? [{
      key: 'delete',
      label: '删除',
      destructive: true,
      onPress: () => confirmDelete(menuMeeting.id),
    }] : []),
  ] : [];

  const renderEmptyState = () => {
    if (loading) {
      return (
        <View style={s.state}>
          <ActivityIndicator color={C.primary} />
          <Text style={s.stateText}>正在加载会议记录…</Text>
        </View>
      );
    }
    if (error) {
      return (
        <View style={s.state}>
          <Ionicons name="cloud-offline-outline" size={72} color={C.disabled} />
          <Text style={s.stateText}>会议服务暂时不可用</Text>
          <TouchableOpacity style={s.retryAction} onPress={refreshMeetings} accessibilityRole="button">
            <Text style={s.retryText}>重试</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return (
      <View style={s.state}>
        <Ionicons name="mic-outline" size={72} color={C.disabled} />
        <Text style={s.stateText}>暂无会议记录</Text>
      </View>
    );
  };

  return (
    <ScreenContainer edges={['top']} bg="#F8F9FA">
      <View testID="meeting-home-titlebar" style={s.header}>
        <Text style={s.title}>会议记录</Text>
        <View style={s.headerActions}>
          <TouchableOpacity
            style={s.headerAction}
            onPress={() => setSearchVisible(true)}
            accessibilityRole="button"
            accessibilityLabel="搜索会议记录"
          >
            <Ionicons name="search-outline" size={20} color={C.text} />
          </TouchableOpacity>
          <TouchableOpacity
            style={s.headerAction}
            onPress={() => setAppMenuVisible(true)}
            accessibilityRole="button"
            accessibilityLabel="更多会议操作"
          >
            <Ionicons name="ellipsis-horizontal" size={20} color={C.text} />
          </TouchableOpacity>
        </View>
      </View>

      <FlatList
        testID="meeting-home-list"
        data={meetings}
        keyExtractor={meeting => meeting.id}
        renderItem={({ item }) => (
          <MeetingListItem
            meeting={item}
            onPress={() => openMeeting(item.id)}
            onLongPress={() => setMeetingMenuId(item.id)}
          />
        )}
        style={s.list}
        contentContainerStyle={[
          s.content,
          meetings.length === 0 && s.emptyContent,
        ]}
        showsVerticalScrollIndicator={false}
        refreshing={loading && hasCachedMeetings}
        onRefresh={refreshMeetings}
        ListHeaderComponent={error && hasCachedMeetings ? (
          <View style={s.cachedError} accessibilityRole="alert" testID="meeting-cache-error">
            <Ionicons name="cloud-offline-outline" size={18} color={C.red} />
            <Text style={s.cachedErrorText} numberOfLines={1}>同步失败，正在显示本机缓存</Text>
            <TouchableOpacity
              style={s.cachedRetry}
              onPress={refreshMeetings}
              accessibilityRole="button"
              accessibilityLabel="重新同步会议记录"
            >
              <Ionicons name="refresh" size={18} color={C.primary} />
            </TouchableOpacity>
          </View>
        ) : <View style={s.listTopSpace} />}
        ListEmptyComponent={renderEmptyState}
      />

      <MeetingSearchPage
        visible={searchVisible}
        meetings={meetings}
        onClose={() => setSearchVisible(false)}
        onOpenMeeting={openMeeting}
        onOpenMenu={setMeetingMenuId}
      />
      {appMenuVisible ? (
        <AppActionSheet
          visible
          title="会议记录"
          items={appMenuItems}
          onClose={() => setAppMenuVisible(false)}
        />
      ) : null}
      {menuMeeting ? (
        <AppActionSheet
          visible
          title={menuMeeting.title}
          items={meetingMenuItems}
          onClose={() => setMeetingMenuId(null)}
        />
      ) : null}
    </ScreenContainer>
  );
}

const s = StyleSheet.create({
  header: {
    height: 44,
    paddingHorizontal: 6,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F8F9FA',
  },
  title: {
    position: 'absolute',
    left: 98,
    right: 98,
    textAlign: 'center',
    fontSize: 20,
    lineHeight: 28,
    fontWeight: '700',
    color: C.text,
  },
  headerActions: { marginLeft: 'auto', flexDirection: 'row', alignItems: 'center' },
  headerAction: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  list: { flex: 1, backgroundColor: '#F8F9FA' },
  content: { paddingBottom: BOTTOM_TAB_BAR_GEOMETRY.sceneContentClearance },
  emptyContent: { flexGrow: 1 },
  listTopSpace: { height: 12 },
  state: {
    flex: 1,
    minHeight: 280,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  stateText: { marginTop: 16, fontSize: 14, lineHeight: 20, color: C.sub, textAlign: 'center' },
  retryAction: { minWidth: 76, height: 36, marginTop: 24, alignItems: 'center', justifyContent: 'center' },
  retryText: { fontSize: 16, lineHeight: 22, color: C.primary, fontWeight: '500' },
  cachedError: {
    height: 44,
    marginTop: 12,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#FFF2F2',
  },
  cachedErrorText: { flex: 1, minWidth: 0, fontSize: 14, lineHeight: 20, color: C.red },
  cachedRetry: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
});
