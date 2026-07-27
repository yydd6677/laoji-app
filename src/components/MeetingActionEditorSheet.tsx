import DateTimePicker from '@react-native-community/datetimepicker';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FEISHU_MOTION, getFeishuTokens } from '../theme/feishuTokens';
import { meetingActionReminderAtForDue } from '../services/notifications';

export interface MeetingActionEditorValue {
  mode: 'create' | 'edit';
  id: string;
  content: string;
  assignee: string | null;
  dueAtMs: number | null;
  reminderAtMs: number | null;
  reminderNotificationId: string | null;
  sourceMarkerId: string | null;
  status: 'pending' | 'completed' | 'dismissed';
  expectedUpdatedAtMs: number;
}

export interface MeetingActionEditorSaveValue {
  content: string;
  assignee: string | null;
  dueAtMs: number | null;
  reminderEnabled: boolean;
}

const MOTION_MS = 300;

function dateLabel(value: number | null): string {
  if (value === null) return '未设置';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未设置';
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

function localDateStart(value: Date): number {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
}

function reminderLabel(value: number | null, existingReminderAtMs: number | null): string {
  if (value === null) return '未开启';
  const reminderAtMs = meetingActionReminderAtForDue(value);
  const reminder = new Date(reminderAtMs);
  if (!reminderAtMs || Number.isNaN(reminder.getTime())) return '未开启';
  if (existingReminderAtMs === reminderAtMs && reminderAtMs <= Date.now()) return '已提醒';
  return `${String(reminder.getHours()).padStart(2, '0')}:${String(reminder.getMinutes()).padStart(2, '0')}`;
}

function ReminderToggle({
  enabled,
  disabled,
  onToggle,
}: {
  enabled: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const { colors } = getFeishuTokens();
  const progress = useRef(new Animated.Value(enabled ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(progress, {
      toValue: enabled ? 1 : 0,
      duration: FEISHU_MOTION.fabSegment,
      easing: Easing.inOut(Easing.ease),
      useNativeDriver: true,
    }).start();
  }, [enabled, progress]);

  return (
    <Pressable
      style={styles.toggleTarget}
      onPress={onToggle}
      disabled={disabled}
      accessibilityRole="switch"
      accessibilityLabel="截止时间提醒"
      accessibilityState={{ checked: enabled, disabled }}
    >
      <View
        style={[
          styles.toggleTrack,
          { backgroundColor: disabled ? colors.backgroundBase : enabled ? colors.primary : colors.iconDisabled },
        ]}
      />
      <Animated.View
        style={[
          styles.toggleThumb,
          {
            backgroundColor: colors.backgroundFloat,
            transform: [{
              translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [0, 16] }),
            }],
          },
        ]}
      />
    </Pressable>
  );
}

export function MeetingActionEditorSheet({
  visible,
  action,
  saving,
  error,
  onClose,
  onSave,
  onStatusChange,
}: {
  visible: boolean;
  action: MeetingActionEditorValue | null;
  saving: boolean;
  error: string;
  onClose: () => void;
  onSave: (value: MeetingActionEditorSaveValue) => void;
  onStatusChange: (status: 'pending' | 'dismissed') => void;
}) {
  const { colors } = getFeishuTokens();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const progress = useRef(new Animated.Value(0)).current;
  const mountedRef = useRef(visible);
  const closingRef = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [mounted, setMounted] = useState(visible);
  const [closing, setClosing] = useState(false);
  const [content, setContent] = useState(action?.content ?? '');
  const [assignee, setAssignee] = useState(action?.assignee ?? '');
  const [dueAtMs, setDueAtMs] = useState<number | null>(action?.dueAtMs ?? null);
  const [reminderEnabled, setReminderEnabled] = useState(
    action?.status === 'pending' && action.reminderAtMs !== null,
  );
  const [showDatePicker, setShowDatePicker] = useState(false);

  useEffect(() => {
    if (!visible || !action) return;
    setContent(action.content);
    setAssignee(action.assignee ?? '');
    setDueAtMs(action.dueAtMs);
    setReminderEnabled(action.status === 'pending' && action.reminderAtMs !== null);
    setShowDatePicker(false);
  }, [action?.id, visible]);

  const finishClose = useCallback((notify: boolean) => {
    if (!mountedRef.current || closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    progress.stopAnimation();
    Animated.timing(progress, {
      toValue: 0,
      duration: MOTION_MS,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (!finished) return;
      mountedRef.current = false;
      closingRef.current = false;
      setMounted(false);
      setClosing(false);
      setShowDatePicker(false);
      if (notify) closeRef.current();
    });
  }, [progress]);

  useEffect(() => {
    if (visible) {
      mountedRef.current = true;
      closingRef.current = false;
      setMounted(true);
      setClosing(false);
      progress.stopAnimation();
      progress.setValue(0);
      Animated.timing(progress, {
        toValue: 1,
        duration: MOTION_MS,
        useNativeDriver: true,
      }).start();
      return;
    }
    finishClose(false);
  }, [finishClose, progress, visible]);

  useEffect(() => () => progress.stopAnimation(), [progress]);

  if (!mounted) return null;
  const canSave = content.trim().length > 0 && !saving && !closing;
  const reminderAvailable = dueAtMs !== null && action?.status === 'pending';
  const isCreating = action?.mode === 'create';
  const statusAction = action?.status === 'dismissed' ? '恢复' : '删除';
  const requestClose = () => {
    if (!saving) finishClose(true);
  };

  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={requestClose}
    >
      <View style={styles.root} accessibilityViewIsModal>
        <Animated.View
          style={[styles.backdrop, { backgroundColor: colors.backgroundMask, opacity: progress }]}
        >
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={requestClose}
            accessibilityLabel="关闭待办事项编辑"
          />
        </Animated.View>
        <KeyboardAvoidingView
          style={styles.keyboardHost}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          pointerEvents={closing ? 'none' : 'auto'}
        >
          <Animated.View
            style={[
              styles.sheet,
              {
                backgroundColor: colors.backgroundFloat,
                paddingBottom: Math.max(16, insets.bottom),
                maxHeight: height - Math.max(insets.top, 16),
                transform: [{
                  translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [height, 0] }),
                }],
              },
            ]}
          >
            <View style={styles.titleBar}>
              <Pressable
                style={({ pressed }) => [styles.titleAction, pressed && { backgroundColor: colors.pressedFill }]}
                onPress={requestClose}
                disabled={saving}
                accessibilityRole="button"
                accessibilityLabel="取消编辑待办事项"
              >
                <Text style={[styles.titleActionText, { color: saving ? colors.textDisabled : colors.textCaption }]}>取消</Text>
              </Pressable>
              <Text style={[styles.title, { color: colors.textTitle }]}>
                {isCreating ? '新建待办事项' : '编辑待办事项'}
              </Text>
              {isCreating ? (
                <View style={styles.titleAction} />
              ) : (
                <Pressable
                  style={({ pressed }) => [styles.titleAction, pressed && { backgroundColor: colors.pressedFill }]}
                  onPress={() => onStatusChange(action?.status === 'dismissed' ? 'pending' : 'dismissed')}
                  disabled={saving || closing}
                  accessibilityRole="button"
                  accessibilityLabel={action?.status === 'dismissed' ? '恢复待办事项' : '删除待办事项'}
                  accessibilityState={{ disabled: saving || closing, busy: saving }}
                >
                  <Text
                    style={[
                      styles.titleActionText,
                      {
                        color: saving
                          ? colors.textDisabled
                          : action?.status === 'dismissed' ? colors.primary : colors.danger,
                      },
                    ]}
                  >
                    {statusAction}
                  </Text>
                </Pressable>
              )}
            </View>
            <ScrollView
              contentContainerStyle={styles.form}
              keyboardDismissMode="on-drag"
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              bounces={false}
            >
              <Text style={[styles.label, { color: colors.textCaption }]}>事项</Text>
              <TextInput
                value={content}
                onChangeText={setContent}
                editable={!saving}
                multiline
                maxLength={20_000}
                textAlignVertical="top"
                style={[
                  styles.contentInput,
                  {
                    color: colors.textTitle,
                    backgroundColor: colors.backgroundFloatOverlay,
                    borderColor: error && !content.trim() ? colors.danger : colors.divider,
                  },
                ]}
                accessibilityLabel="待办事项内容"
              />

              <Text style={[styles.label, styles.sectionLabel, { color: colors.textCaption }]}>负责人</Text>
              <TextInput
                value={assignee}
                onChangeText={setAssignee}
                editable={!saving}
                maxLength={200}
                style={[
                  styles.singleInput,
                  {
                    color: colors.textTitle,
                    backgroundColor: colors.backgroundFloatOverlay,
                    borderColor: colors.divider,
                  },
                ]}
                accessibilityLabel="待办事项负责人"
              />

              <Text style={[styles.label, styles.sectionLabel, { color: colors.textCaption }]}>截止日期</Text>
              <Pressable
                style={({ pressed }) => [
                  styles.dateRow,
                  {
                    backgroundColor: pressed ? colors.pressedFill : colors.backgroundFloatOverlay,
                    borderColor: colors.divider,
                  },
                ]}
                onPress={() => setShowDatePicker(true)}
                disabled={saving}
                accessibilityRole="button"
                accessibilityLabel={`截止日期，${dateLabel(dueAtMs)}`}
              >
                <Text style={[styles.dateText, { color: dueAtMs === null ? colors.textPlaceholder : colors.textTitle }]}>
                  {dateLabel(dueAtMs)}
                </Text>
                {dueAtMs !== null ? (
                  <Pressable
                    hitSlop={10}
                    onPress={event => {
                      event.stopPropagation();
                      setDueAtMs(null);
                      setReminderEnabled(false);
                    }}
                    disabled={saving}
                    accessibilityRole="button"
                    accessibilityLabel="清除截止日期"
                  >
                    <Text style={[styles.clearDate, { color: colors.primary }]}>清除</Text>
                  </Pressable>
                ) : null}
              </Pressable>
              {showDatePicker ? (
                <DateTimePicker
                  value={dueAtMs === null ? new Date() : new Date(dueAtMs)}
                  mode="date"
                  display="default"
                  onChange={(event, value) => {
                    if (Platform.OS === 'android') setShowDatePicker(false);
                    if (event.type !== 'dismissed' && value) setDueAtMs(localDateStart(value));
                  }}
                />
              ) : null}

              <View
                style={[
                  styles.reminderRow,
                  {
                    backgroundColor: reminderAvailable ? colors.backgroundFloatOverlay : colors.backgroundBase,
                    borderColor: colors.divider,
                  },
                ]}
              >
                <View style={styles.reminderCopy}>
                  <Text style={[styles.reminderTitle, { color: reminderAvailable ? colors.textTitle : colors.textDisabled }]}>提醒</Text>
                  <Text style={[styles.reminderValue, { color: reminderAvailable ? colors.textCaption : colors.textDisabled }]}>
                    {reminderEnabled ? reminderLabel(dueAtMs, action?.reminderAtMs ?? null) : '未开启'}
                  </Text>
                </View>
                <ReminderToggle
                  enabled={reminderEnabled}
                  disabled={saving || !reminderAvailable}
                  onToggle={() => setReminderEnabled(value => !value)}
                />
              </View>

              <View style={styles.errorSlot}>
                {error ? <Text style={[styles.error, { color: colors.danger }]}>{error}</Text> : null}
              </View>
              <Pressable
                style={({ pressed }) => [
                  styles.save,
                  {
                    backgroundColor: canSave
                      ? pressed ? colors.primaryPressed : colors.primary
                      : colors.backgroundBase,
                  },
                ]}
                onPress={() => onSave({
                  content: content.trim(),
                  assignee: assignee.trim() || null,
                  dueAtMs,
                  reminderEnabled,
                })}
                disabled={!canSave}
                accessibilityRole="button"
                accessibilityLabel={isCreating ? '创建待办事项' : '保存待办事项'}
                accessibilityState={{ disabled: !canSave, busy: saving }}
              >
                {saving ? (
                  <ActivityIndicator color={colors.onPrimary} />
                ) : (
                  <Text style={[styles.saveText, { color: canSave ? colors.onPrimary : colors.textDisabled }]}>
                    {isCreating ? '创建' : '保存'}
                  </Text>
                )}
              </Pressable>
            </ScrollView>
          </Animated.View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject },
  keyboardHost: { flex: 1, justifyContent: 'flex-end' },
  sheet: { flexShrink: 1, borderTopLeftRadius: 12, borderTopRightRadius: 12, overflow: 'hidden' },
  titleBar: { height: 52, flexDirection: 'row', alignItems: 'center' },
  titleAction: { width: 72, height: 44, alignItems: 'center', justifyContent: 'center' },
  titleActionText: { fontSize: 16, lineHeight: 24, fontWeight: '400' },
  title: { flex: 1, textAlign: 'center', fontSize: 17, lineHeight: 24, fontWeight: '500' },
  form: { paddingHorizontal: 16, paddingBottom: 4 },
  label: { fontSize: 13, lineHeight: 20, marginBottom: 6 },
  sectionLabel: { marginTop: 14 },
  contentInput: { minHeight: 88, maxHeight: 160, borderWidth: 1, borderRadius: 6, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, lineHeight: 23 },
  singleInput: { height: 48, borderWidth: 1, borderRadius: 6, paddingHorizontal: 12, fontSize: 16, lineHeight: 23 },
  dateRow: { height: 48, borderWidth: 1, borderRadius: 6, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center' },
  dateText: { flex: 1, fontSize: 16, lineHeight: 23 },
  clearDate: { fontSize: 14, lineHeight: 22, paddingHorizontal: 4 },
  reminderRow: { height: 56, marginTop: 10, borderWidth: 1, borderRadius: 6, paddingLeft: 12, paddingRight: 4, flexDirection: 'row', alignItems: 'center' },
  reminderCopy: { flex: 1 },
  reminderTitle: { fontSize: 16, lineHeight: 22 },
  reminderValue: { marginTop: 1, fontSize: 12, lineHeight: 17 },
  toggleTarget: { width: 48, height: 44, alignItems: 'center', justifyContent: 'center' },
  toggleTrack: { width: 40, height: 24, borderRadius: 12 },
  toggleThumb: { position: 'absolute', left: 6, width: 20, height: 20, borderRadius: 10 },
  errorSlot: { height: 32, justifyContent: 'center' },
  error: { fontSize: 13, lineHeight: 18 },
  save: { height: 48, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  saveText: { fontSize: 17, lineHeight: 24, fontWeight: '400' },
});
