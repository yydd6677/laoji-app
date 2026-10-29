import React, { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { NativeCalendarEditAction, NativeCalendarEditDraftSnapshot, NativeCalendarEditSnapshot } from 'laoji-native-platform';
import { useTheme } from '../theme/ThemeProvider';
import { MotionPressable } from './MotionPressable';
import { CalendarEditTitleBar } from './CalendarTitleBar';
import { EventTimeEditor } from './EventTimeEditor';
import { eventTimeLabel } from '../utils/scheduleEventTime';
import { labelForReminder } from '../services/notifications';

export type ScheduleEditorSurfaceProps = {
  snapshot: NativeCalendarEditSnapshot;
  onAction: (action: NativeCalendarEditAction) => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

const repeatLabels = { once: '不重复', daily: '每天', weekly: '每周', monthly: '每月', yearly: '每年' };

/** Presentation only: the route owns the same durable draft, input,
 * recovery and commit as Android. No second parser, draft or save path. */
export function ScheduleEditorSurface({ snapshot, onAction, style, testID }: ScheduleEditorSurfaceProps) {
  const { colors: C } = useTheme();
  const [picker, setPicker] = useState<'date' | 'time' | null>(null);
  const { draft, input } = snapshot;
  const recording = input?.phase === 'recording', parsing = input?.phase === 'parsing';
  const ready = snapshot.state === 'ready', disabled = !ready || snapshot.saving;
  const change = (values: Partial<NativeCalendarEditDraftSnapshot>) => onAction({ type: 'draftChange', draft: { ...draft, ...values } });
  const icon = (name: React.ComponentProps<typeof Ionicons>['name'], label: string, action: NativeCalendarEditAction,
    danger = false, blocked = disabled) => <MotionPressable style={s.icon} disabled={blocked} feedback="quiet"
      accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: blocked }} onPress={() => onAction(action)}>
      <Ionicons name={name} size={23} color={danger ? C.red : blocked ? C.faint : C.primary} />
    </MotionPressable>;
  const row = (label: string, content: string, action: () => void, id: string) => <MotionPressable testID={id}
    style={[s.row, { borderBottomColor: C.divider }]} onPress={action} disabled={disabled} feedback="quiet"
    accessibilityRole="button" accessibilityLabel={label} accessibilityValue={{ text: content }}>
    <Text style={[s.label, { color: C.sub }]}>{label}</Text>
    <Text style={[s.value, { color: C.text }]}>{content}</Text>
    <Ionicons name="chevron-forward" size={16} color={C.faint} />
  </MotionPressable>;
  return <KeyboardAvoidingView style={[s.root, { backgroundColor: C.body }, style]} testID={testID}
    behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <CalendarEditTitleBar onCancel={() => onAction({ type: 'cancel' })}
      onSave={() => onAction({ type: 'save', draft })} saving={snapshot.saving}
      saveEnabled={ready && !snapshot.saving && !recording && !parsing} saveAccessibilityLabel="保存日程" />
    {!ready ? <View style={s.unavailable}>{snapshot.state === 'loading' ? <ActivityIndicator color={C.primary} />
      : <Text style={{ color: C.sub }}>{snapshot.message}</Text>}</View> : <>
      <ScrollView style={s.root} contentContainerStyle={s.form} keyboardShouldPersistTaps="handled">
        <TextInput value={draft.title} onChangeText={title => change({ title })} placeholder="主题"
          placeholderTextColor={C.faint} editable={!snapshot.saving} accessibilityLabel="主题" testID="event-editor-title"
          style={[s.title, { color: C.text }]} />
        {row('日期', draft.startDate || '选择日期', () => setPicker('date'), 'event-editor-date')}
        {row('时间', eventTimeLabel({ ...draft, startTime: draft.startTime ?? undefined, endTime: draft.endTime ?? undefined }),
          () => setPicker('time'), 'event-editor-time')}
        <View style={[s.row, { borderBottomColor: C.divider }]}>
          <Text style={[s.label, { color: C.sub }]}>地点</Text>
          <TextInput style={[s.value, { color: C.text }]} value={draft.location} onChangeText={location => change({ location })}
            placeholder="未设置" placeholderTextColor={C.faint} accessibilityLabel="地点" testID="event-editor-location" editable={!snapshot.saving} />
          {icon('location-outline', '使用当前位置', { type: 'requestCurrentLocation', draft }, false, disabled || snapshot.locating)}
        </View>
        {row('提醒', labelForReminder(draft.reminderMinutes), () => onAction({ type: 'openReminder', draft }), 'event-editor-reminder')}
        {row('重复', repeatLabels[draft.repeat], () => onAction({ type: 'openRepeat', draft }), 'event-editor-repeat')}
        <TextInput style={[s.notes, { color: C.text }]} value={draft.notes} onChangeText={notes => change({ notes })}
          placeholder="备注" placeholderTextColor={C.faint} accessibilityLabel="备注" testID="event-editor-notes" multiline editable={!snapshot.saving} />
        {snapshot.editing ? <MotionPressable style={s.delete} onPress={() => onAction({ type: 'delete' })} disabled={disabled}
          accessibilityRole="button" accessibilityLabel="删除日程"><Text style={{ color: C.red }}>删除日程</Text></MotionPressable> : null}
      </ScrollView>
      <View style={[s.dock, { backgroundColor: C.body, borderTopColor: C.divider }]} testID="schedule-editor-input-dock">
        {input?.error ? <Text style={[s.error, { color: C.red }]} accessibilityLiveRegion="polite">{input.error}</Text> : null}
        <View style={s.inputRow}>
          {icon(recording ? 'stop-circle' : 'mic', recording ? '结束录音' : '语音输入',
            { type: recording ? 'inputStop' : 'inputStart' }, recording, disabled || Boolean(parsing))}
          <TextInput value={input?.text ?? ''} onChangeText={text => onAction({ type: 'inputTextChange', text })}
            style={[s.input, { color: C.text, borderColor: C.divider }]} placeholder="输入日程" placeholderTextColor={C.faint}
            accessibilityLabel="日程输入" testID="schedule-editor-text" editable={!recording && !parsing && !snapshot.saving}
            multiline />
          {parsing ? <View style={s.icon} accessibilityLabel="正在解析"><ActivityIndicator color={C.primary} /></View>
            : icon('arrow-up', '应用输入', { type: 'inputSubmit', text: input?.text ?? '' }, false,
              disabled || Boolean(recording) || !input?.text.trim())}
          {recording || parsing ? icon('close', '取消本次输入', { type: 'inputCancel' }, false, false)
            : icon('ellipsis-horizontal', '输入选项', { type: 'inputOptions' })}
        </View>
        {recording ? <View style={s.levelRow} accessibilityLabel="录音中" accessibilityValue={{ text: `${Math.floor((input?.durationMs ?? 0) / 1000)}秒` }}>
          <View style={[s.level, { backgroundColor: C.red, opacity: .25 + Math.max(0, Math.min(1, input?.level ?? 0)) * .75 }]} />
          <Text style={{ color: C.red }}>{Math.floor((input?.durationMs ?? 0) / 1000)}秒</Text>
        </View> : null}
        {input?.canUndo && !recording && !parsing ? <MotionPressable style={s.undo} onPress={() => onAction({ type: 'inputUndo' })}
          accessibilityRole="button" accessibilityLabel="撤销输入"><Text style={{ color: C.primary }}>撤销</Text></MotionPressable> : null}
      </View>
    </>}
    <EventTimeEditor visible={picker !== null} dateOnly={picker === 'date'} value={draft}
      onCancel={() => setPicker(null)} onDone={(value, baseline) => {
        // A sub-editor only owns the fields it actually changed, never an
        // old full snapshot that could erase a newer transcript/title edit.
        const keys = picker === 'date' ? ['startDate', 'endDate'] as const
          : ['startDate', 'endDate', 'startTime', 'endTime', 'timePrecision', 'timePeriod', 'isAllDay'] as const;
        const changes = Object.fromEntries(keys.filter(key => value[key] !== baseline[key]).map(key => [key, value[key]]));
        change(changes); setPicker(null);
      }}
      onInvalid={() => onAction({ type: 'feedback', message: '结束时间须晚于开始时间' })} />
  </KeyboardAvoidingView>;
}

const s = StyleSheet.create({
  root: { flex: 1 }, unavailable: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  form: { paddingHorizontal: 20, paddingBottom: 24 }, title: { fontSize: 24, minHeight: 72, paddingVertical: 14 },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 52, borderBottomWidth: StyleSheet.hairlineWidth, gap: 8 },
  label: { fontSize: 15, width: 52 }, value: { flex: 1, fontSize: 16, paddingVertical: 12 },
  notes: { fontSize: 16, minHeight: 80, paddingVertical: 16, textAlignVertical: 'top' },
  delete: { minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  dock: { paddingHorizontal: 8, paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth },
  inputRow: { flexDirection: 'row', alignItems: 'center' }, icon: { width: 44, height: 48, alignItems: 'center', justifyContent: 'center' },
  input: { flex: 1, minHeight: 44, maxHeight: 100, fontSize: 16, paddingHorizontal: 10, paddingVertical: 10, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8 },
  error: { paddingHorizontal: 12, fontSize: 14, paddingVertical: 4 }, levelRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16 },
  level: { width: 8, height: 8, borderRadius: 4 }, undo: { alignSelf: 'flex-end', minHeight: 44, justifyContent: 'center', paddingHorizontal: 14 },
});
