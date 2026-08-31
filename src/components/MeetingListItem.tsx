import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Meeting } from '../types';
import { Appearance, Colors as C } from '../theme/colors';
import { displayMeetingTitle } from '../utils/meetingTitle';
import { MotionPressable } from './MotionPressable';

export const MEETING_LIST_ITEM_GEOMETRY = Object.freeze({
  minHeight: 72,
  paddingHorizontal: 16,
  paddingTop: 13,
  paddingBottom: 13,
  titleLineHeight: 22,
  metaHeight: 22,
});

function meetingDateTime(meeting: Meeting): string {
  return [meeting.date, meeting.time].filter(Boolean).join(' ');
}

function meetingMeta(meeting: Meeting): {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  text: string;
  color: string;
} {
  const status = meeting.status?.toLowerCase();
  if (status === 'recording') {
    return { icon: 'radio-button-on', text: '录音中', color: C.red };
  }
  if (status === 'processing' || status === 'saving' || status === 'summarizing') {
    return { icon: 'sync-circle', text: '处理中', color: C.primary };
  }
  if (status === 'failed' || meeting.audioSyncBlocked) {
    return { icon: 'close-circle', text: meeting.audioSyncBlocked ? '上传失败' : '失败', color: C.red };
  }
  if (meeting.audioSyncPending) {
    return { icon: 'cloud-upload', text: '等待上传', color: C.orange };
  }
  return { icon: 'mic', text: meetingDateTime(meeting), color: C.faint };
}

export function MeetingListItem({
  meeting,
  onPress,
  onLongPress,
}: {
  meeting: Meeting;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const meta = meetingMeta(meeting);
  const displayTitle = displayMeetingTitle(meeting.title);

  return (
    <MotionPressable
      testID={`meeting-list-item-${meeting.id}`}
      style={[
        s.row,
        Appearance.surfaceMode !== 'flat' && {
          marginHorizontal: 8,
          marginVertical: 4,
          backgroundColor: C.card,
          borderRadius: Appearance.cardRadius,
          borderWidth: Appearance.borderWidth,
          borderColor: C.border,
          shadowColor: C.purpleDark,
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: Appearance.shadowOpacity,
          shadowRadius: Appearance.shadowRadius,
          elevation: Appearance.elevation,
        },
      ]}
      pressedStyle={{ backgroundColor: C.inputBg }}
      feedback="quiet"
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={320}
      accessibilityRole="button"
      accessibilityLabel={displayTitle}
      accessibilityHint="打开会议详情，长按显示更多操作"
    >
      <Text style={s.title} numberOfLines={2}>{displayTitle}</Text>
      <View style={s.metaRow} testID={`meeting-list-meta-${meeting.id}`}>
        <Ionicons name={meta.icon} size={14} color={meta.color} />
        <Text style={[s.metaText, { color: meta.color }]} numberOfLines={1}>{meta.text}</Text>
      </View>
    </MotionPressable>
  );
}

const s = StyleSheet.create({
  row: {
    minHeight: MEETING_LIST_ITEM_GEOMETRY.minHeight,
    paddingTop: MEETING_LIST_ITEM_GEOMETRY.paddingTop,
    paddingHorizontal: MEETING_LIST_ITEM_GEOMETRY.paddingHorizontal,
    paddingBottom: MEETING_LIST_ITEM_GEOMETRY.paddingBottom,
  },
  title: {
    fontSize: 16,
    lineHeight: MEETING_LIST_ITEM_GEOMETRY.titleLineHeight,
    fontWeight: '600',
    color: C.text,
  },
  metaRow: {
    height: MEETING_LIST_ITEM_GEOMETRY.metaHeight,
    marginTop: 2,
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0,
  },
  metaText: {
    flexShrink: 1,
    minWidth: 0,
    marginLeft: 4,
    fontSize: 14,
    lineHeight: 20,
    color: C.faint,
  },
});
