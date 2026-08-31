import DateTimePicker from '@react-native-community/datetimepicker';
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Keyboard,
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
import type { CalEvent, Meeting } from '../types';
import { getUiTokens } from '../theme/uiTokens';
import { eventRefKey, eventRefForEvent } from '../utils/eventIdentity';

const MOTION_MS = 300;
const MAX_TITLE_LENGTH = 500;
const MAX_EVENT_DISTANCE_MS = 31 * 24 * 60 * 60 * 1000;

export interface MeetingImportDraft {
  title: string;
  recordedAtMs: number;
  calendarEvent: CalEvent | null;
  targetMeetingId: string | null;
}

function formatDate(value: number): string {
  const date = new Date(value);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

function formatTime(value: number): string {
  const date = new Date(value);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function eventTimestamp(event: CalEvent): number | null {
  const value = new Date(`${event.startDate}T${event.startTime || '00:00'}:00`).getTime();
  return Number.isFinite(value) ? value : null;
}

function eventMetadata(event: CalEvent): string {
  const date = new Date(`${event.startDate}T${event.startTime || '00:00'}:00`);
  const dateLabel = Number.isNaN(date.getTime())
    ? event.startDate
    : `${date.getMonth() + 1}月${date.getDate()}日${event.isAllDay || !event.startTime ? '' : ` ${event.startTime}`}`;
  return event.location?.trim() ? `${dateLabel} · ${event.location.trim()}` : dateLabel;
}

function readableFileSize(value: number | null): string {
  if (value === null || value < 0) return '';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function candidateEvents(events: readonly CalEvent[], recordedAtMs: number): CalEvent[] {
  const unique = new Map<string, CalEvent>();
  events.forEach(event => {
    const timestamp = eventTimestamp(event);
    if (timestamp === null || Math.abs(timestamp - recordedAtMs) > MAX_EVENT_DISTANCE_MS) return;
    const key = eventRefKey(eventRefForEvent(event));
    const current = unique.get(key);
    if (!current || Math.abs(timestamp - recordedAtMs) < Math.abs((eventTimestamp(current) ?? 0) - recordedAtMs)) {
      unique.set(key, event);
    }
  });
  return [...unique.values()]
    .sort((left, right) => {
      const leftTime = eventTimestamp(left) ?? 0;
      const rightTime = eventTimestamp(right) ?? 0;
      return Math.abs(leftTime - recordedAtMs) - Math.abs(rightTime - recordedAtMs)
        || leftTime - rightTime
        || eventRefKey(eventRefForEvent(left)).localeCompare(eventRefKey(eventRefForEvent(right)));
    })
    .slice(0, 20);
}

function candidateMeetings(meetings: readonly Meeting[]): Meeting[] {
  return meetings
    .filter(meeting => !['recording', 'paused'].includes(meeting.status ?? ''))
    .slice(0, 50);
}

function meetingMetadata(meeting: Meeting): string {
  return [meeting.date, meeting.time].filter(Boolean).join(' ');
}

export function MeetingImportSheet({
  visible,
  requestKey,
  fileName,
  mimeType,
  byteSize,
  initialTitle,
  initialRecordedAtMs,
  events,
  meetings,
  allowExistingMeeting,
  onClose,
  onValidate,
  onImport,
}: {
  visible: boolean;
  requestKey: string;
  fileName: string;
  mimeType: string | null;
  byteSize: number | null;
  initialTitle: string;
  initialRecordedAtMs: number;
  events: readonly CalEvent[];
  meetings: readonly Meeting[];
  allowExistingMeeting: boolean;
  onClose: () => void;
  onValidate: (draft: MeetingImportDraft) => Promise<string | null>;
  onImport: (draft: MeetingImportDraft) => void;
}) {
  const { colors } = getUiTokens();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const progress = useRef(new Animated.Value(0)).current;
  const mountedRef = useRef(visible);
  const closingRef = useRef(false);
  const closeRef = useRef(onClose);
  const validateRef = useRef(onValidate);
  const importRef = useRef(onImport);
  closeRef.current = onClose;
  validateRef.current = onValidate;
  importRef.current = onImport;

  const [mounted, setMounted] = useState(visible);
  const [closing, setClosing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [page, setPage] = useState<'form' | 'events' | 'meetings'>('form');
  const [title, setTitle] = useState(initialTitle);
  const [recordedAtMs, setRecordedAtMs] = useState(initialRecordedAtMs);
  const [calendarEvent, setCalendarEvent] = useState<CalEvent | null>(null);
  const [targetMeetingId, setTargetMeetingId] = useState<string | null>(null);
  const [pickerMode, setPickerMode] = useState<'date' | 'time' | null>(null);
  const [error, setError] = useState('');
  const [androidKeyboardInset, setAndroidKeyboardInset] = useState(0);

  const finishClose = useCallback((notify: boolean, afterExit?: () => void) => {
    if (!mountedRef.current || closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    Keyboard.dismiss();
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
      if (notify) closeRef.current();
      afterExit?.();
    });
  }, [progress]);

  useEffect(() => {
    if (visible) {
      setTitle(initialTitle.slice(0, MAX_TITLE_LENGTH));
      setRecordedAtMs(initialRecordedAtMs);
      setCalendarEvent(null);
      setTargetMeetingId(null);
      setPage('form');
      setPickerMode(null);
      setError('');
      setSubmitting(false);
      setAndroidKeyboardInset(0);
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
  }, [finishClose, initialRecordedAtMs, initialTitle, progress, requestKey, visible]);

  useEffect(() => () => progress.stopAnimation(), [progress]);

  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    const shown = Keyboard.addListener('keyboardDidShow', event => {
      const inset = Math.max(0, height - event.endCoordinates.screenY);
      setAndroidKeyboardInset(Math.min(height, inset));
    });
    const hidden = Keyboard.addListener('keyboardDidHide', () => {
      setAndroidKeyboardInset(0);
    });
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, [height]);

  const candidates = useMemo(
    () => candidateEvents(events, recordedAtMs),
    [events, recordedAtMs],
  );
  const meetingCandidates = useMemo(
    () => candidateMeetings(meetings),
    [meetings],
  );

  if (!mounted) return null;
  const requestClose = () => {
    if (submitting) return;
    if (page !== 'form') {
      setPage('form');
      return;
    }
    finishClose(true);
  };

  const submit = async () => {
    if (submitting || closing) return;
    const draft: MeetingImportDraft = {
      title: title.slice(0, MAX_TITLE_LENGTH),
      recordedAtMs,
      calendarEvent: targetMeetingId ? null : calendarEvent,
      targetMeetingId,
    };
    Keyboard.dismiss();
    setError('');
    setSubmitting(true);
    try {
      const validationError = await validateRef.current(draft);
      if (validationError) {
        setError(validationError);
        setSubmitting(false);
        return;
      }
      finishClose(false, () => importRef.current(draft));
    } catch {
      setError('暂时无法检查关联日程，请稍后重试。');
      setSubmitting(false);
    }
  };

  const updateDateTime = (mode: 'date' | 'time', value: Date) => {
    const current = new Date(recordedAtMs);
    if (mode === 'date') {
      current.setFullYear(value.getFullYear(), value.getMonth(), value.getDate());
    } else {
      current.setHours(value.getHours(), value.getMinutes(), 0, 0);
    }
    setRecordedAtMs(current.getTime());
    setError('');
  };

  const openPicker = (mode: 'date' | 'time') => {
    Keyboard.dismiss();
    setAndroidKeyboardInset(0);
    setPickerMode(mode);
  };

  const sheetHeight = Math.max(
    0,
    Math.min(
      page === 'form' && targetMeetingId ? 348 : 620,
      height - androidKeyboardInset - Math.max(insets.top, 12),
    ),
  );
  const selectedEventLabel = calendarEvent?.title.trim() || (calendarEvent ? '无标题日程' : '不关联');
  const selectedTarget = targetMeetingId
    ? meetings.find(meeting => meeting.id === targetMeetingId) ?? null
    : null;
  const selectedTargetLabel = selectedTarget?.title.trim()
    || (selectedTarget ? '无标题会议' : '新建会议记录');

  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={requestClose}
    >
      <View style={styles.root}>
        <Animated.View style={[styles.backdrop, { backgroundColor: colors.backgroundMask, opacity: progress }]}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={requestClose}
            accessibilityRole="button"
            accessibilityLabel="取消导入会议录音"
          />
        </Animated.View>
        <KeyboardAvoidingView
          style={[
            styles.keyboardHost,
            Platform.OS === 'android' ? { paddingBottom: androidKeyboardInset } : null,
          ]}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <Animated.View
            pointerEvents={closing ? 'none' : 'auto'}
            style={[
              styles.sheet,
              {
                height: sheetHeight,
                paddingBottom: Math.max(12, insets.bottom),
                backgroundColor: colors.backgroundFloat,
                transform: [{
                  translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [sheetHeight, 0] }),
                }],
              },
            ]}
            accessibilityViewIsModal
          >
            <View style={[styles.titleBar, { borderBottomColor: colors.divider }]}>
              <Pressable
                style={({ pressed }) => [styles.titleAction, pressed && { backgroundColor: colors.pressedFill }]}
                onPress={requestClose}
                disabled={submitting}
                accessibilityRole="button"
                accessibilityLabel={page !== 'form' ? '返回导入设置' : '取消导入会议录音'}
              >
                <Ionicons
                  name={page !== 'form' ? 'chevron-back' : 'close'}
                  size={24}
                  color={submitting ? colors.iconDisabled : colors.iconPrimary}
                />
              </Pressable>
              <Text style={[styles.title, { color: colors.textTitle }]}>
                {page === 'events' ? '关联日程' : page === 'meetings' ? '保存到' : '导入会议录音'}
              </Text>
              <View style={styles.titleAction} />
            </View>

            {page === 'meetings' ? (
              <ScrollView style={styles.content} bounces={false} showsVerticalScrollIndicator={false}>
                <Pressable
                  style={({ pressed }) => [
                    styles.eventRow,
                    { borderTopColor: colors.divider },
                    pressed && { backgroundColor: colors.pressedFill },
                  ]}
                  onPress={() => {
                    setTargetMeetingId(null);
                    setPage('form');
                    setError('');
                  }}
                  accessibilityRole="radio"
                  accessibilityLabel="新建会议记录"
                  accessibilityState={{ checked: targetMeetingId === null }}
                >
                  <View style={styles.eventBody}>
                    <Text style={[styles.eventTitle, { color: colors.textTitle }]}>新建会议记录</Text>
                  </View>
                  {targetMeetingId === null ? <Ionicons name="checkmark" size={22} color={colors.primary} /> : null}
                </Pressable>
                {meetingCandidates.map(meeting => {
                  const selected = meeting.id === targetMeetingId;
                  return (
                    <Pressable
                      key={meeting.id}
                      style={({ pressed }) => [
                        styles.eventRow,
                        { borderTopColor: colors.divider },
                        pressed && { backgroundColor: colors.pressedFill },
                      ]}
                      onPress={() => {
                        setTargetMeetingId(meeting.id);
                        setCalendarEvent(null);
                        setPage('form');
                        setError('');
                      }}
                      accessibilityRole="radio"
                      accessibilityLabel={`${meeting.title.trim() || '无标题会议'}，${meetingMetadata(meeting)}`}
                      accessibilityState={{ checked: selected }}
                    >
                      <View style={styles.eventBody}>
                        <Text style={[styles.eventTitle, { color: colors.textTitle }]} numberOfLines={1}>
                          {meeting.title.trim() || '无标题会议'}
                        </Text>
                        <Text style={[styles.eventMeta, { color: colors.textCaption }]} numberOfLines={1}>
                          {meetingMetadata(meeting)}
                        </Text>
                      </View>
                      {selected ? <Ionicons name="checkmark" size={22} color={colors.primary} /> : null}
                    </Pressable>
                  );
                })}
              </ScrollView>
            ) : page === 'events' ? (
              <ScrollView style={styles.content} bounces={false} showsVerticalScrollIndicator={false}>
                <Pressable
                  style={({ pressed }) => [
                    styles.eventRow,
                    { borderTopColor: colors.divider },
                    pressed && { backgroundColor: colors.pressedFill },
                  ]}
                  onPress={() => {
                    setCalendarEvent(null);
                    setPage('form');
                    setError('');
                  }}
                  accessibilityRole="radio"
                  accessibilityLabel="不关联日程"
                  accessibilityState={{ checked: calendarEvent === null }}
                >
                  <View style={styles.eventBody}>
                    <Text style={[styles.eventTitle, { color: colors.textTitle }]}>不关联</Text>
                  </View>
                  {calendarEvent === null ? <Ionicons name="checkmark" size={22} color={colors.primary} /> : null}
                </Pressable>
                {candidates.map(event => {
                  const key = eventRefKey(eventRefForEvent(event));
                  const selected = calendarEvent
                    ? key === eventRefKey(eventRefForEvent(calendarEvent))
                    : false;
                  return (
                    <Pressable
                      key={key}
                      style={({ pressed }) => [
                        styles.eventRow,
                        { borderTopColor: colors.divider },
                        pressed && { backgroundColor: colors.pressedFill },
                      ]}
                      onPress={() => {
                        setCalendarEvent(event);
                        setPage('form');
                        setError('');
                      }}
                      accessibilityRole="radio"
                      accessibilityLabel={`${event.title.trim() || '无标题日程'}，${eventMetadata(event)}`}
                      accessibilityState={{ checked: selected }}
                    >
                      <View style={styles.eventBody}>
                        <Text style={[styles.eventTitle, { color: colors.textTitle }]} numberOfLines={1}>
                          {event.title.trim() || '无标题日程'}
                        </Text>
                        <Text style={[styles.eventMeta, { color: colors.textCaption }]} numberOfLines={1}>
                          {eventMetadata(event)}
                        </Text>
                      </View>
                      {selected ? <Ionicons name="checkmark" size={22} color={colors.primary} /> : null}
                    </Pressable>
                  );
                })}
              </ScrollView>
            ) : (
              <>
                <ScrollView
                  style={styles.content}
                  contentContainerStyle={styles.form}
                  keyboardShouldPersistTaps="handled"
                  bounces={false}
                  showsVerticalScrollIndicator={false}
                >
                <View style={styles.fileRow}>
                  <Ionicons
                    name={mimeType?.toLowerCase().startsWith('video/') ? 'videocam-outline' : 'musical-notes-outline'}
                    size={20}
                    color={colors.iconSecondary}
                  />
                  <View style={styles.fileBody}>
                    <Text style={[styles.fileName, { color: colors.textTitle }]} numberOfLines={1}>{fileName}</Text>
                    {readableFileSize(byteSize) ? (
                      <Text style={[styles.fileMeta, { color: colors.textCaption }]}>{readableFileSize(byteSize)}</Text>
                    ) : null}
                  </View>
                </View>

                {allowExistingMeeting && meetingCandidates.length > 0 ? (
                  <>
                    <Text style={[styles.label, { color: colors.textCaption }]}>保存到</Text>
                    <Pressable
                      style={({ pressed }) => [
                        styles.linkRow,
                        { borderColor: colors.divider },
                        pressed && { backgroundColor: colors.pressedFill },
                      ]}
                      onPress={() => {
                        Keyboard.dismiss();
                        setAndroidKeyboardInset(0);
                        setPage('meetings');
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={`保存到，${selectedTargetLabel}`}
                    >
                      <Text style={[styles.valueLabel, { color: colors.textTitle }]}>保存到</Text>
                      <Text style={[styles.value, { color: colors.textCaption }]} numberOfLines={1}>
                        {selectedTargetLabel}
                      </Text>
                      <Ionicons name="chevron-forward" size={18} color={colors.iconTertiary} />
                    </Pressable>
                  </>
                ) : null}

                {targetMeetingId === null ? (
                  <>
                    <Text style={[styles.label, styles.sectionLabel, { color: colors.textCaption }]}>标题</Text>
                    <TextInput
                      style={[
                        styles.input,
                        {
                          color: colors.textTitle,
                          backgroundColor: colors.backgroundBase,
                          borderColor: colors.divider,
                        },
                      ]}
                      value={title}
                      onChangeText={value => {
                        setTitle(value.slice(0, MAX_TITLE_LENGTH));
                        setError('');
                      }}
                      placeholder="无标题会议"
                      placeholderTextColor={colors.textPlaceholder}
                      maxLength={MAX_TITLE_LENGTH}
                      returnKeyType="done"
                      onSubmitEditing={Keyboard.dismiss}
                      accessibilityLabel="会议标题"
                    />

                    <Text style={[styles.label, styles.sectionLabel, { color: colors.textCaption }]}>录制时间</Text>
                    <View style={[styles.rows, { borderColor: colors.divider }]}>
                      <Pressable
                        style={({ pressed }) => [styles.valueRow, pressed && { backgroundColor: colors.pressedFill }]}
                        onPress={() => openPicker('date')}
                        accessibilityRole="button"
                        accessibilityLabel={`录制日期，${formatDate(recordedAtMs)}`}
                      >
                        <Text style={[styles.valueLabel, { color: colors.textTitle }]}>日期</Text>
                        <Text style={[styles.value, { color: colors.textCaption }]}>{formatDate(recordedAtMs)}</Text>
                        <Ionicons name="chevron-forward" size={18} color={colors.iconTertiary} />
                      </Pressable>
                      <View style={[styles.divider, { backgroundColor: colors.divider }]} />
                      <Pressable
                        style={({ pressed }) => [styles.valueRow, pressed && { backgroundColor: colors.pressedFill }]}
                        onPress={() => openPicker('time')}
                        accessibilityRole="button"
                        accessibilityLabel={`录制时间，${formatTime(recordedAtMs)}`}
                      >
                        <Text style={[styles.valueLabel, { color: colors.textTitle }]}>时间</Text>
                        <Text style={[styles.value, { color: colors.textCaption }]}>{formatTime(recordedAtMs)}</Text>
                        <Ionicons name="chevron-forward" size={18} color={colors.iconTertiary} />
                      </Pressable>
                    </View>

                    <Text style={[styles.label, styles.sectionLabel, { color: colors.textCaption }]}>日程</Text>
                    <Pressable
                      style={({ pressed }) => [
                        styles.linkRow,
                        { borderColor: colors.divider },
                        pressed && { backgroundColor: colors.pressedFill },
                      ]}
                      onPress={() => {
                        Keyboard.dismiss();
                        setAndroidKeyboardInset(0);
                        setPage('events');
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={`关联日程，${selectedEventLabel}`}
                    >
                      <Text style={[styles.valueLabel, { color: colors.textTitle }]}>关联日程</Text>
                      <Text style={[styles.value, { color: colors.textCaption }]} numberOfLines={1}>
                        {selectedEventLabel}
                      </Text>
                      <Ionicons name="chevron-forward" size={18} color={colors.iconTertiary} />
                    </Pressable>
                  </>
                ) : null}
                </ScrollView>

                <View style={styles.footer}>
                  <View style={styles.errorSlot}>
                    <Text style={[styles.error, { color: colors.danger }]} numberOfLines={2}>{error}</Text>
                  </View>
                  <Pressable
                    style={({ pressed }) => [
                      styles.submit,
                      { backgroundColor: pressed && !submitting ? colors.primaryPressed : colors.primary },
                    ]}
                    onPress={() => { void submit(); }}
                    disabled={submitting || closing}
                    accessibilityRole="button"
                    accessibilityLabel={targetMeetingId ? '加入会议录音' : '导入会议录音'}
                    accessibilityState={{ busy: submitting, disabled: submitting || closing }}
                  >
                    {submitting ? (
                      <ActivityIndicator color={colors.onPrimary} />
                    ) : (
                      <Text style={[styles.submitText, { color: colors.onPrimary }]}>
                        {targetMeetingId ? '加入' : '导入'}
                      </Text>
                    )}
                  </Pressable>
                </View>
              </>
            )}

            {pickerMode ? (
              <DateTimePicker
                value={new Date(recordedAtMs)}
                mode={pickerMode}
                display="default"
                maximumDate={new Date()}
                onChange={(event, value) => {
                  if (Platform.OS === 'android') setPickerMode(null);
                  if (event.type !== 'set' || !value) return;
                  updateDateTime(pickerMode, value);
                }}
              />
            ) : null}
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
  sheet: { borderTopLeftRadius: 12, borderTopRightRadius: 12, overflow: 'hidden' },
  titleBar: { height: 52, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
  titleAction: { width: 60, height: 44, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, textAlign: 'center', fontSize: 17, lineHeight: 24, fontWeight: '500' },
  content: { flex: 1 },
  form: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 },
  fileRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10 },
  fileBody: { flex: 1, minWidth: 0 },
  fileName: { fontSize: 14, lineHeight: 20, fontWeight: '400' },
  fileMeta: { marginTop: 1, fontSize: 12, lineHeight: 18 },
  label: { marginTop: 10, marginBottom: 6, fontSize: 13, lineHeight: 20 },
  sectionLabel: { marginTop: 16 },
  input: { height: 48, borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, paddingHorizontal: 12, fontSize: 16, lineHeight: 24 },
  rows: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, overflow: 'hidden' },
  valueRow: { height: 52, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center' },
  valueLabel: { fontSize: 16, lineHeight: 24, fontWeight: '400' },
  value: { flex: 1, marginLeft: 16, fontSize: 15, lineHeight: 22, textAlign: 'right' },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 12 },
  linkRow: { height: 52, paddingHorizontal: 12, borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, flexDirection: 'row', alignItems: 'center' },
  footer: { paddingHorizontal: 16, paddingTop: 2 },
  errorSlot: { height: 38, justifyContent: 'center' },
  error: { fontSize: 13, lineHeight: 18 },
  submit: { height: 48, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  submitText: { fontSize: 17, lineHeight: 24, fontWeight: '400' },
  eventRow: { minHeight: 66, paddingLeft: 16, paddingRight: 18, borderTopWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center' },
  eventBody: { flex: 1, minWidth: 0, paddingVertical: 10 },
  eventTitle: { fontSize: 16, lineHeight: 24, fontWeight: '400' },
  eventMeta: { marginTop: 1, fontSize: 13, lineHeight: 20 },
});
