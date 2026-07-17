import React, { useMemo, useState } from 'react';
import { StyleSheet } from 'react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  LaojiMinutesView,
  MINUTES_SNAPSHOT_SCHEMA_VERSION,
  type MinutesSemanticAction,
  type MinutesViewSnapshot,
  type NativeTabPressEvent,
} from 'laoji-native-platform';
import { AppActionSheet, type AppActionSheetItem } from '../components/AppActionSheet';
import { useAppDialog } from '../components/AppDialog';
import { MeetingDeletionCleanupError, useMeetings } from '../store/MeetingsStore';
import type { RootStackParamList } from '../types';
import { readableErrorMessage } from '../services/errors';
import { canResumeMeetingRecording, preferredMeetingStatusLabel } from '../utils/meetingMedia';

type MeetingListNavigationProp = NativeStackNavigationProp<RootStackParamList>;

type Props = {
  navigation: MeetingListNavigationProp;
  onTabPress: (event: { nativeEvent: NativeTabPressEvent }) => void;
  // UI-SHELL-BOTTOM-MAIN-001: destination-change motion for the active native root.
  bottomBarSelectionCommand: number;
};

function statusTone(label: string): 'neutral' | 'primary' | 'success' | 'warning' | 'danger' {
  if (label.includes('失败') || label.includes('受阻')) return 'danger';
  if (label.includes('处理中') || label.includes('待')) return 'warning';
  if (label.includes('完成')) return 'success';
  if (label.includes('录音')) return 'primary';
  return 'neutral';
}

/** MIN-ROOT-001 / MIN-SEARCH-001: Android renders the Minutes native list surface. */
export function MeetingListScreen({ navigation, onTabPress, bottomBarSelectionCommand }: Props) {
  const { meetings, loading, error, deleteMeeting, refreshMeetings } = useMeetings();
  const { showDialog } = useAppDialog();
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [appMenuVisible, setAppMenuVisible] = useState(false);
  const [meetingMenuId, setMeetingMenuId] = useState<string | null>(null);
  const menuMeeting = meetings.find(meeting => meeting.id === meetingMenuId);

  const snapshot = useMemo<MinutesViewSnapshot>(() => ({
    schemaVersion: MINUTES_SNAPSHOT_SCHEMA_VERSION,
    surface: 'list',
    list: {
      title: '会议记录',
      searching,
      query,
      phase: loading && meetings.length === 0
        ? 'loading'
        : error ? 'error' : meetings.length === 0 ? 'empty' : 'ready',
      message: error ?? '',
      showingCachedData: Boolean(error && meetings.length > 0),
      meetings: meetings.map(meeting => {
        const statusLabel = preferredMeetingStatusLabel(meeting.tags);
        return {
          id: meeting.id,
          title: meeting.title,
          dateTimeLabel: [meeting.date, meeting.time].filter(Boolean).join(' '),
          durationLabel: meeting.duration,
          statusLabel,
          statusTone: statusTone(statusLabel),
          canResume: canResumeMeetingRecording(meeting),
        };
      }),
    },
  }), [error, loading, meetings, query, searching]);

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
              showDialog({
                title: deleteError instanceof MeetingDeletionCleanupError
                  ? '会议已删除，清理未完成'
                  : '删除失败',
                message: deleteError instanceof MeetingDeletionCleanupError
                  ? deleteError.message
                  : readableErrorMessage(deleteError, '请检查网络后重试。'),
                tone: deleteError instanceof MeetingDeletionCleanupError ? 'warning' : 'error',
              });
            }
          },
        },
        { text: '取消', role: 'cancel' },
      ],
    });
  };

  const handleAction = (action: MinutesSemanticAction) => {
    switch (action.type) {
      case 'openMeeting':
        navigation.navigate('Transcription', { meetingId: action.meetingId });
        break;
      case 'openRecording':
        navigation.navigate('MeetingLive', { meetingId: action.meetingId });
        break;
      case 'openMeetingMenu':
        setMeetingMenuId(action.meetingId);
        break;
      case 'startRecording':
        {
          const resumable = meetings.find(canResumeMeetingRecording);
          if (resumable) navigation.navigate('MeetingLive', { meetingId: resumable.id });
          else navigation.navigate('MeetingLive');
        }
        break;
      case 'search':
      case 'beginSearch':
        setSearching(true);
        break;
      case 'endSearch':
        setSearching(false);
        setQuery('');
        break;
      case 'updateSearchQuery':
        setQuery(action.query);
        break;
      case 'refreshMeetings':
        void refreshMeetings();
        break;
      case 'more':
        setAppMenuVisible(true);
        break;
      default:
        break;
    }
  };

  const appMenuItems: AppActionSheetItem[] = [
    { key: 'speakers', label: '管理讲话人', onPress: () => navigation.navigate('SpeakerManager') },
    { key: 'profile', label: '个人资料', onPress: () => navigation.navigate('Profile') },
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
    ...(!canResumeMeetingRecording(menuMeeting)
      ? [{ key: 'delete', label: '删除', destructive: true, onPress: () => confirmDelete(menuMeeting.id) }]
      : []),
  ] : [];

  return (
    <>
      <LaojiMinutesView
        style={styles.surface}
        surface="list"
        snapshot={snapshot}
        bottomBarSelectionCommand={bottomBarSelectionCommand}
        onMinutesAction={event => handleAction(event.nativeEvent)}
        onTabPress={onTabPress}
        testID="meeting-native-list"
      />
      <AppActionSheet
        visible={appMenuVisible}
        title="会议记录"
        items={appMenuItems}
        onClose={() => setAppMenuVisible(false)}
      />
      <AppActionSheet
        visible={Boolean(menuMeeting)}
        title={menuMeeting?.title ?? ''}
        items={meetingMenuItems}
        onClose={() => setMeetingMenuId(null)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  surface: { flex: 1 },
});
