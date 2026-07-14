import React, { useEffect, useState, useRef } from 'react';
import {
  Animated, Modal, View, Text, TextInput, TouchableOpacity,
  StyleSheet, ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';
import { SafeAreaView } from 'react-native-safe-area-context';
import { NavigationProp, useNavigation } from '@react-navigation/native';
import { Colors as C } from '../theme/colors';
import {
  ApiGuestRealtimeSession,
  clarifyText,
  createGuestRealtimeSession,
  deleteGuestRealtimeSession,
  parseAudio,
  parseText,
  ParseResult,
} from '../services/api';
import {
  RealtimeAsrAudioStats,
  RealtimeAsrSession,
  RealtimeAsrTranscript,
  startRealtimeAsr,
} from '../services/realtimeAsr';
import {
  ScheduleTranscriptSegment,
  appendScheduleTranscriptSegment,
  scheduleTranscriptDisplayText,
  scheduleTranscriptText,
} from '../services/scheduleTranscript';
import { useEvents } from '../store/EventsStore';
import { useAppDialog } from './AppDialog';
import { colorForEvent, normalizeEventCategory } from '../utils/eventColors';
import { checkConflict } from '../utils/eventUtils';
import { createClientRequestState, requestStateForPayload } from '../services/clientRequestId';
import { diagnosticWarn } from '../services/diagnostics';
import { isValidScheduleDate } from '../services/localScheduleParser';
import { reminderUnavailableMessage } from '../services/notifications';
import { CalEvent, EventDraftParams, RootStackParamList } from '../types';

interface Props {
  visible: boolean;
  onClose: () => void;
  onSaved: () => void;
}

type Step = 'input' | 'connecting' | 'recording' | 'parsing' | 'confirm' | 'saving';
type RecordingMode = 'realtime' | 'file';
type AudioLevelSummary = { frameCount: number; maxPeak: number; maxRms: number };

const LOW_AUDIO_PEAK = 1000;
const LOW_AUDIO_RMS = 280;
const ERROR_LINE_HEIGHT = 17;
const ERROR_SLOT_HEIGHT = ERROR_LINE_HEIGHT * 2;

async function discardScheduleRecording(uri: string | undefined): Promise<void> {
  if (!uri) return;
  const normalizedUri = uri.includes('://') ? uri : `file://${uri}`;
  try {
    await FileSystem.deleteAsync(normalizedUri, { idempotent: true });
  } catch {
    diagnosticWarn('schedule realtime audio cleanup failed');
  }
}

export function VoiceInputModal({ visible, onClose, onSaved }: Props) {
  const { events, addEvent } = useEvents();
  const { showDialog } = useAppDialog();
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const [step, setStep]         = useState<Step>('input');
  const [text, setText]         = useState('');
  const [draft, setDraft]       = useState<ParseResult | null>(null);
  const [clarifyAnswer, setClarifyAnswer] = useState('');
  const [error, setError]       = useState('');
  const recordingRef            = useRef<Audio.Recording | null>(null);
  const realtimeRef             = useRef<RealtimeAsrSession | null>(null);
  const realtimeAuthorizationRef = useRef<ApiGuestRealtimeSession | null>(null);
  const recordingModeRef        = useRef<RecordingMode | null>(null);
  const recordingRunRef         = useRef(0);
  const recordingStartRef       = useRef(false);
  const recordingStopRef        = useRef(false);
  const createRequestRef        = useRef(createClientRequestState('event'));
  const transcriptRef           = useRef('');
  const transcriptSegmentsRef   = useRef<ScheduleTranscriptSegment[]>([]);
  const audioLevelRef           = useRef<AudioLevelSummary>({ frameCount: 0, maxPeak: 0, maxRms: 0 });
  const [recordingMode, setRecordingMode] = useState<RecordingMode | null>(null);
  const backdropOpacity         = useRef(new Animated.Value(0)).current;
  const sheetTranslateY         = useRef(new Animated.Value(48)).current;

  useEffect(() => {
    if (!visible) {
      backdropOpacity.setValue(0);
      sheetTranslateY.setValue(48);
      return;
    }
    backdropOpacity.setValue(0);
    sheetTranslateY.setValue(48);
    Animated.timing(backdropOpacity, {
      toValue: 1,
      duration: 160,
      useNativeDriver: true,
    }).start();
    Animated.timing(sheetTranslateY, {
      toValue: 0,
      duration: 240,
      useNativeDriver: true,
    }).start();
  }, [backdropOpacity, sheetTranslateY, visible]);

  const reset = () => {
    recordingRunRef.current += 1;
    setStep('input');
    setText('');
    setDraft(null);
    setClarifyAnswer('');
    setError('');
    setRecordingMode(null);
    transcriptRef.current = '';
    transcriptSegmentsRef.current = [];
    audioLevelRef.current = { frameCount: 0, maxPeak: 0, maxRms: 0 };
    recordingModeRef.current = null;
    recordingStartRef.current = false;
    recordingStopRef.current = false;
    createRequestRef.current = createClientRequestState('event');
  };
  const close = () => {
    recordingRunRef.current += 1;
    void stopActiveRecordingSilently();
    reset();
    onClose();
  };
  const returnToInput = () => {
    const preservedText = text.trim() || draft?.raw_text?.trim() || '';
    setStep('input');
    setText(preservedText);
    setDraft(null);
    setClarifyAnswer('');
    setError('');
    createRequestRef.current = createClientRequestState('event');
  };

  const acceptNewDraft = (result: ParseResult) => {
    createRequestRef.current = createClientRequestState('event');
    setDraft(result);
  };
  const voiceErrorText = (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err ?? '');
    if (message.includes('无法从语音中提取日程')) return '未识别到明确日程，请靠近麦克风再说一次';
    if (message.includes('实时语音流')) return '当前运行环境不支持实时语音，请使用开发版或正式包';
    if (message.includes('realtime ASR') || message.includes('websocket')) return '实时语音接口连接失败，请确认手机网络能访问服务器';
    if (message.includes('Network request failed')) return '语音接口连接失败，请确认手机网络能访问服务器';
    if (message.includes('read audio failed')) return '录音文件读取失败，请重新录音';
    if (message.includes('permission')) return '没有麦克风权限，请在系统设置中允许录音';
    if (message.includes('timed out')) return '语音识别超时，请稍后重试';
    return message ? `语音识别失败：${message}` : '语音识别失败，请重试';
  };

  const setTranscriptSegments = (segments: ScheduleTranscriptSegment[]) => {
    transcriptSegmentsRef.current = segments;
    transcriptRef.current = scheduleTranscriptText(segments);
    setText(scheduleTranscriptDisplayText(segments));
  };

  const appendRealtimeTranscript = (transcript: RealtimeAsrTranscript) => {
    const clean = transcript.text.trim();
    if (!clean) return;
    const segments = appendScheduleTranscriptSegment(transcriptSegmentsRef.current, {
      text: clean,
      receivedAt: Date.now(),
      startTime: transcript.startTime,
      endTime: transcript.endTime,
    });
    setTranscriptSegments(segments);
  };

  const noteRealtimeAudioStats = (stats: RealtimeAsrAudioStats) => {
    audioLevelRef.current = {
      frameCount: stats.frameCount,
      maxPeak: Math.max(audioLevelRef.current.maxPeak, stats.raw.peak),
      maxRms: Math.max(audioLevelRef.current.maxRms, stats.raw.rms),
    };
  };

  const noTranscriptText = () => {
    const level = audioLevelRef.current;
    const isLowAudio = level.frameCount > 0
      && level.maxPeak < LOW_AUDIO_PEAK
      && level.maxRms < LOW_AUDIO_RMS;
    if (isLowAudio) {
      return '未识别到语音内容，当前麦克风音量过低，请靠近手机并提高音量';
    }
    return '未识别到语音内容，请靠近麦克风再说一次';
  };

  const releaseRealtimeAuthorization = async (
    authorization: ApiGuestRealtimeSession | null = realtimeAuthorizationRef.current,
  ) => {
    if (!authorization) return;
    if (realtimeAuthorizationRef.current === authorization) {
      realtimeAuthorizationRef.current = null;
    }
    try {
      await deleteGuestRealtimeSession(
        authorization.meeting_id,
        authorization.guest_token,
      );
    } catch (err) {
      diagnosticWarn('schedule realtime authorization cleanup failed', err);
    }
  };

  const stopActiveRecordingSilently = async () => {
    recordingStopRef.current = true;
    const realtime = realtimeRef.current;
    const recording = recordingRef.current;
    const authorization = realtimeAuthorizationRef.current;
    realtimeRef.current = null;
    recordingRef.current = null;
    realtimeAuthorizationRef.current = null;
    recordingModeRef.current = null;
    setRecordingMode(null);

    if (realtime) {
      try {
        await discardScheduleRecording(await realtime.stop());
      } catch {
        // Closing the modal should never block on recorder cleanup.
      }
    }
    if (recording) {
      try {
        await recording.stopAndUnloadAsync();
      } catch {
        // The recording may already be unloaded.
      }
    }
    await releaseRealtimeAuthorization(authorization);
  };

  // ── Text submit ────────────────────────────────────────────────────────────
  const handleSubmitText = async () => {
    if (!text.trim()) return;
    setStep('parsing'); setError('');
    try {
      const result = await parseText(text.trim());
      acceptNewDraft(result); setStep('confirm');
    } catch {
      setError('解析失败，请检查网络'); setStep('input');
    }
  };

  // ── Voice recording ────────────────────────────────────────────────────────
  const startRecording = async () => {
    if (recordingStartRef.current || recordingModeRef.current) return;
    recordingStartRef.current = true;
    recordingStopRef.current = false;
    const runId = recordingRunRef.current + 1;
    recordingRunRef.current = runId;
    setStep('connecting');
    setError('');
    try {
      const permission = await Audio.requestPermissionsAsync();
      if (recordingRunRef.current !== runId) return;
      if (!permission.granted) {
        setStep('input');
        showDialog({ title: '无法录音', message: '请在系统设置中允许麦克风权限', tone: 'warning' });
        return;
      }
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      if (recordingRunRef.current !== runId) return;
      setError('');
      setText('');
      transcriptRef.current = '';
      transcriptSegmentsRef.current = [];
      audioLevelRef.current = { frameCount: 0, maxPeak: 0, maxRms: 0 };

      let authorization: ApiGuestRealtimeSession | null = null;
      try {
        authorization = await createGuestRealtimeSession('日程语音输入');
        if (recordingRunRef.current !== runId) {
          await releaseRealtimeAuthorization(authorization);
          return;
        }
        realtimeAuthorizationRef.current = authorization;
        const realtime = await startRealtimeAsr({
          meetingId: authorization.meeting_id,
          guestToken: authorization.guest_token,
          purpose: 'schedule',
          onTranscript: transcript => {
            if (recordingRunRef.current === runId) appendRealtimeTranscript(transcript);
          },
          onAudioStats: stats => {
            if (recordingRunRef.current === runId) noteRealtimeAudioStats(stats);
          },
          onError: err => {
            if (recordingRunRef.current !== runId) return;
            diagnosticWarn('realtime voice recognition warning', err);
            if (recordingModeRef.current === 'realtime') setError(voiceErrorText(err));
          },
        });
        if (recordingRunRef.current !== runId) {
          await discardScheduleRecording(await realtime.stop());
          await releaseRealtimeAuthorization(authorization);
          return;
        }
        realtimeRef.current = realtime;
        recordingModeRef.current = 'realtime';
        setRecordingMode('realtime');
        setStep('recording');
        void realtime.completion.then(async completion => {
          if (
            completion.reason !== 'connection-closed'
            || recordingRunRef.current !== runId
            || realtimeRef.current !== realtime
            || recordingStopRef.current
          ) return;
          const audioUri = await realtime.stop().catch(() => undefined);
          await discardScheduleRecording(audioUri);
          await releaseRealtimeAuthorization(authorization);
          if (
            recordingRunRef.current !== runId
            || realtimeRef.current !== realtime
            || recordingStopRef.current
          ) return;
          realtimeRef.current = null;
          recordingModeRef.current = null;
          setRecordingMode(null);
          const transcribed = transcriptRef.current.trim();
          if (transcribed) setText(transcribed);
          setError(transcribed
            ? '实时连接已断开，已保留识别内容，可直接解析或重新录音'
            : '实时语音接口连接失败，请确认手机网络能访问服务器');
          setStep('input');
        }).catch(err => {
          if (recordingRunRef.current !== runId || realtimeRef.current !== realtime) return;
          void releaseRealtimeAuthorization(authorization);
          setError(voiceErrorText(err));
          setStep('input');
          realtimeRef.current = null;
          recordingModeRef.current = null;
          setRecordingMode(null);
        });
        return;
      } catch (realtimeErr) {
        diagnosticWarn('realtime voice unavailable, falling back to file recording', realtimeErr);
        await releaseRealtimeAuthorization(authorization);
        if (recordingRunRef.current !== runId) return;
        if (realtimeErr instanceof Error && realtimeErr.message.includes('microphone is already in use')) {
          throw realtimeErr;
        }
      }

      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY
      );
      if (recordingRunRef.current !== runId) {
        await recording.stopAndUnloadAsync().catch(() => {});
        return;
      }
      recordingRef.current = recording;
      recordingModeRef.current = 'file';
      setRecordingMode('file');
      setStep('recording');
    } catch (err) {
      diagnosticWarn('recording start failed', err);
      if (recordingRunRef.current === runId) {
        setStep('input');
        const message = err instanceof Error && err.message.includes('microphone is already in use')
          ? '麦克风正在被另一个录音任务使用，请先结束后再试'
          : '请检查麦克风权限';
        showDialog({ title: '无法录音', message, tone: 'warning' });
      }
    } finally {
      if (recordingRunRef.current === runId) recordingStartRef.current = false;
    }
  };

  const stopRecording = async () => {
    recordingStopRef.current = true;
    if (recordingModeRef.current === 'realtime') {
      const realtime = realtimeRef.current;
      if (!realtime) return;
      setStep('parsing');
      try {
        await discardScheduleRecording(await realtime.stop());
        const transcribed = transcriptRef.current.trim();
        realtimeRef.current = null;
        recordingModeRef.current = null;
        setRecordingMode(null);
        if (!transcribed) {
          setError(noTranscriptText());
          setStep('input');
          return;
        }
        setText(transcribed);
        const result = await parseText(transcribed);
        acceptNewDraft(result);
        setStep('confirm');
      } catch (err) {
        diagnosticWarn('realtime voice recognition failed', err);
        setError(voiceErrorText(err));
        setStep('input');
        realtimeRef.current = null;
        recordingModeRef.current = null;
        setRecordingMode(null);
      } finally {
        await releaseRealtimeAuthorization();
      }
      return;
    }

    if (!recordingRef.current) return;
    setStep('parsing');
    try {
      await recordingRef.current.stopAndUnloadAsync();
      const uri = recordingRef.current.getURI();
      recordingRef.current = null;
      recordingModeRef.current = null;
      setRecordingMode(null);
      if (!uri) throw new Error('recording uri is empty');
      const result = await parseAudio(uri);
      const transcribed = result.raw_text ?? '';
      if (!transcribed.trim()) { setError('未识别到语音内容'); setStep('input'); return; }
      setText(transcribed);
      acceptNewDraft(result); setStep('confirm');
    } catch (err) {
      diagnosticWarn('voice recognition failed', err);
      setError(voiceErrorText(err)); setStep('input');
      recordingRef.current = null;
      recordingModeRef.current = null;
      setRecordingMode(null);
    }
  };

  // ── Clarify parser follow-up ───────────────────────────────────────────────
  const handleClarify = async () => {
    if (!draft || !clarifyAnswer.trim()) return;
    setStep('parsing'); setError('');
    try {
      const answer = clarifyAnswer.trim();
      const result = await clarifyText(text, answer, draft);
      setDraft(result);
      setText(prev => prev ? `${prev}\n${answer}` : answer);
      setClarifyAnswer('');
      setStep('confirm');
    } catch {
      setError('补充解析失败，请重试');
      setStep('confirm');
    }
  };

  // ── Save ───────────────────────────────────────────────────────────────────
  const eventPayloadFromDraft = (source: ParseResult): Omit<CalEvent, 'id'> => {
    const category = normalizeEventCategory(source.category);
    return {
      title:       source.title.trim(),
      startDate:   source.start_date,
      endDate:     source.end_date ?? undefined,
      startTime:   source.start_time ?? undefined,
      endTime:     source.end_time ?? undefined,
      isAllDay:    source.is_all_day,
      repeat:      source.event_type !== 'once' ? source.event_type : undefined,
      description: source.description ?? undefined,
      rawText:     source.raw_text ?? text,
      location:    source.location ?? undefined,
      category,
      detail:      source.detail ?? undefined,
      status:      source.status ?? undefined,
      spanning:    source.spanning ?? Boolean(source.end_date && source.end_date !== source.start_date),
      reminderMinutes: source.reminder_minutes ?? null,
      color:       colorForEvent({ category }),
    };
  };

  const routeDraftFromParseResult = (source: ParseResult): EventDraftParams => {
    const payload = eventPayloadFromDraft(source);
    return {
      title: payload.title,
      startDate: payload.startDate,
      endDate: payload.endDate,
      startTime: payload.startTime,
      endTime: payload.endTime,
      isAllDay: payload.isAllDay ?? false,
      repeat: payload.repeat,
      description: payload.description,
      rawText: payload.rawText,
      location: payload.location,
      category: payload.category,
      detail: payload.detail,
      status: payload.status,
      reminderMinutes: payload.reminderMinutes,
    };
  };

  const validateDraftForSave = (source: ParseResult): boolean => {
    if (!source.title.trim()) {
      setError('日程标题不能为空');
      return false;
    }
    if (!isValidScheduleDate(source.start_date)) {
      setError('请先补充有效日期，再保存日程');
      return false;
    }
    if (source.end_date && (!isValidScheduleDate(source.end_date) || source.end_date < source.start_date)) {
      setError('结束日期不能早于开始日期');
      return false;
    }
    return true;
  };

  const saveDraft = async (eventPayload: Omit<CalEvent, 'id'>) => {
    setStep('saving');
    try {
      createRequestRef.current = requestStateForPayload(createRequestRef.current, 'event', eventPayload);
      const { reminderDelivery } = await addEvent({ ...eventPayload, clientRequestId: createRequestRef.current.id });
      onSaved(); close();
      if (reminderDelivery === 'unavailable') {
        showDialog({
          title: '日程已保存',
          message: await reminderUnavailableMessage(),
          tone: 'warning',
        });
      } else if (reminderDelivery === 'unconfirmed') {
        showDialog({
          title: '日程已保存',
          message: '本机提醒状态未能确认，可重新打开日程并保存提醒。',
          tone: 'warning',
        });
      }
    } catch {
      setError('保存失败，请重试'); setStep('confirm');
    }
  };

  const handleSave = () => {
    if (!draft || !validateDraftForSave(draft)) return;
    const eventPayload = eventPayloadFromDraft(draft);
    if (!eventPayload.isAllDay && eventPayload.startTime && eventPayload.endTime) {
      const { hasConflict, conflicts } = checkConflict(
        events,
        eventPayload.startDate,
        eventPayload.startTime,
        eventPayload.endTime,
        undefined,
        eventPayload.endDate,
      );
      if (hasConflict) {
        const names = conflicts.map(event => `• ${event.title} (${event.startTime}–${event.endTime})`).join('\n');
        showDialog({
          title: '时间冲突',
          message: `该时间段与以下日程冲突：\n${names}`,
          hint: '如果确认这些安排可以重叠，仍然可以继续保存。',
          tone: 'warning',
          actions: [
            { text: '仍然保存', role: 'primary', onPress: () => saveDraft(eventPayload) },
            { text: '取消', role: 'cancel' },
          ],
        });
        return;
      }
    }
    void saveDraft(eventPayload);
  };

  const openDetailedEdit = () => {
    if (!draft || !validateDraftForSave(draft)) return;
    const params = { date: draft.start_date, draft: routeDraftFromParseResult(draft) };
    close();
    navigation.navigate('AddEvent', params);
  };

  const fmtDate = (d: string) => d.replace(/-/g, '/');
  const fmtDateRange = (draft: ParseResult) => {
    if (draft.end_date && draft.end_date !== draft.start_date) {
      return `${fmtDate(draft.start_date)} – ${fmtDate(draft.end_date)}`;
    }
    return fmtDate(draft.start_date);
  };
  const fmtTime = (t: string | null) => t ?? '全天';
  const sourceLabel = (source: ParseResult['parse_source']) => {
    if (source === 'rules') return '规则解析';
    if (source === 'clarified') return '补充解析';
    return 'AI解析';
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={close}
    >
      <View style={s.modalRoot}>
        <Animated.View
          pointerEvents="none"
          style={[s.backdrop, { opacity: backdropOpacity }]}
          testID="schedule-voice-backdrop"
        />
      <KeyboardAvoidingView
        style={s.overlay} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <Animated.View
          style={[s.sheetMotion, { transform: [{ translateY: sheetTranslateY }] }]}
          testID="schedule-voice-sheet-motion"
        >
        <SafeAreaView
          style={[s.sheet, step === 'confirm' && s.confirmSheet]}
          edges={['bottom']}
          testID="schedule-voice-sheet"
        >
          {/* Handle */}
          <View style={s.handle} />

          {/* ── Input step ── */}
          {(step === 'input' || step === 'connecting' || step === 'recording') && (
            <>
              <Text style={s.title}>说出你的日常</Text>
              <Text style={s.hint}>例如：明天下午三点开会，下周一提醒我发周报</Text>

              <TextInput
                style={s.textBox}
                testID="schedule-voice-input"
                placeholder="输入或说出日程内容…"
                placeholderTextColor={C.faint}
                value={text}
                onChangeText={setText}
                multiline
                maxLength={200}
                editable={step === 'input'}
              />

              <View style={s.errorSlot} testID="schedule-voice-error-slot">
                {error ? <Text style={s.errText} numberOfLines={2}>{error}</Text> : null}
              </View>

              <View style={s.actionDock}>
                <View style={s.actionSide}>
                  {(step === 'connecting' || step === 'recording') && (
                    <Text style={s.recordingLabel} numberOfLines={2}>
                      {step === 'connecting'
                        ? '正在连接语音服务'
                        : recordingMode === 'realtime'
                          ? '实时识别中，点击停止'
                          : '录音中，点击停止'}
                    </Text>
                  )}
                </View>

                <TouchableOpacity
                  style={s.micTouch}
                  onPress={step === 'recording' ? stopRecording : startRecording}
                  disabled={step === 'connecting'}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityLabel={step === 'recording'
                    ? '停止语音输入'
                    : step === 'connecting'
                      ? '正在连接语音服务'
                      : '开始语音输入'}
                  accessibilityState={{
                    disabled: step === 'connecting',
                    busy: step === 'connecting',
                  }}
                  testID={step === 'recording'
                    ? 'schedule-voice-stop'
                    : step === 'connecting'
                      ? 'schedule-voice-connecting'
                      : 'schedule-voice-start'}
                >
                  <LinearGradient
                    colors={step === 'recording' ? ['#FF4D4F','#CC2222'] : [C.gradFrom, C.gradTo]}
                    style={s.micBtn}
                  >
                    {step === 'connecting'
                      ? <ActivityIndicator size="small" color="#fff" />
                      : <Ionicons
                          name={step === 'recording' ? 'stop' : 'mic'}
                          size={26} color="#fff"
                        />}
                  </LinearGradient>
                </TouchableOpacity>

                <View style={[s.actionSide, s.actionSideRight]}>
                  {text.trim().length > 0 && step === 'input' && (
                    <TouchableOpacity style={s.submitBtn} onPress={handleSubmitText}>
                      <Text style={s.submitTxt}>解析</Text>
                      <Ionicons name="arrow-forward" size={14} color="#fff" />
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            </>
          )}

          {/* ── Parsing / saving ── */}
          {(step === 'parsing' || step === 'saving') && (
            <View style={s.loadingWrap}>
              <ActivityIndicator size="large" color={C.purple} />
              <Text style={s.loadingTxt}>
                {step === 'parsing' ? '正在解析…' : '正在保存…'}
              </Text>
            </View>
          )}

          {/* ── Confirm step ── */}
          {step === 'confirm' && draft && (
            <View style={s.confirmStep}>
              <View style={s.confirmHeader}>
                <Text style={s.title}>确认日程</Text>
                <TouchableOpacity
                  style={s.editDraftBtn}
                  onPress={openDetailedEdit}
                  activeOpacity={0.72}
                  accessibilityRole="button"
                  accessibilityLabel="编辑日程详情"
                  testID="schedule-voice-edit-details"
                >
                  <Ionicons name="create-outline" size={16} color={C.purple} />
                  <Text style={s.editDraftText}>编辑</Text>
                </TouchableOpacity>
              </View>

              <ScrollView
                style={s.confirmScroll}
                contentContainerStyle={s.confirmScrollContent}
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                testID="schedule-voice-confirm-scroll"
              >
                {draft.needs_clarification && draft.clarification_question && (
                  <>
                    <View style={s.clarifyBox}>
                      <Ionicons name="help-circle-outline" size={16} color={C.orange} />
                      <Text style={s.clarifyTxt}>{draft.clarification_question}</Text>
                    </View>
                    <View style={s.clarifyAnswerRow}>
                      <TextInput
                        style={s.clarifyInput}
                        value={clarifyAnswer}
                        onChangeText={setClarifyAnswer}
                        placeholder="补充答案（选填）"
                        placeholderTextColor={C.faint}
                        returnKeyType="done"
                        onSubmitEditing={handleClarify}
                      />
                      <TouchableOpacity
                        onPress={handleClarify}
                        disabled={!clarifyAnswer.trim()}
                        style={[s.clarifyBtn, !clarifyAnswer.trim() && { opacity: 0.4 }]}
                      >
                        <Text style={s.clarifyBtnText}>补充解析</Text>
                      </TouchableOpacity>
                    </View>
                  </>
                )}

                <View style={s.draftCard}>
                  {text.trim() && (
                    <View style={s.recognizedBox}>
                      <Ionicons name="chatbubble-ellipses-outline" size={14} color={C.sub} />
                      <Text style={s.recognizedText} testID="schedule-voice-transcript">{text.trim()}</Text>
                    </View>
                  )}
                  <Text style={s.draftTitle} testID="schedule-voice-draft-title">{draft.title}</Text>
                  <View style={s.draftRow}>
                    <Ionicons name="calendar-outline" size={14} color={C.sub} />
                    <Text style={s.draftVal}>{fmtDateRange(draft)}</Text>
                  </View>
                  <View style={s.draftRow}>
                    <Ionicons name="time-outline" size={14} color={C.sub} />
                    <Text style={s.draftVal}>{fmtTime(draft.start_time)}
                      {draft.end_time ? ` – ${draft.end_time}` : ''}
                    </Text>
                  </View>
                  {draft.description && (
                    <View style={s.draftRow}>
                      <Ionicons name="document-text-outline" size={14} color={C.sub} />
                      <Text style={s.draftVal}>{draft.description}</Text>
                    </View>
                  )}
                  {draft.detail && draft.detail !== draft.description && (
                    <View style={s.draftRow}>
                      <Ionicons name="reader-outline" size={14} color={C.sub} />
                      <Text style={s.draftVal}>{draft.detail}</Text>
                    </View>
                  )}
                  {draft.location && (
                    <View style={s.draftRow}>
                      <Ionicons name="location-outline" size={14} color={C.sub} />
                      <Text style={s.draftVal}>{draft.location}</Text>
                    </View>
                  )}
                  {draft.category && (
                    <View style={s.draftRow}>
                      <Ionicons name="pricetag-outline" size={14} color={C.sub} />
                      <Text style={s.draftVal}>{draft.category}</Text>
                    </View>
                  )}
                  {draft.status && (
                    <View style={s.draftRow}>
                      <Ionicons name="ellipse-outline" size={14} color={C.sub} />
                      <Text style={s.draftVal}>{draft.status}</Text>
                    </View>
                  )}
                  <Text style={s.draftMeta}>
                    {sourceLabel(draft.parse_source)}
                  </Text>
                </View>
              </ScrollView>

              <View style={s.errorSlot} testID="schedule-voice-error-slot">
                {error ? <Text style={s.errText} numberOfLines={2}>{error}</Text> : null}
              </View>

              <View style={s.confirmRow} testID="schedule-voice-confirm-actions">
                <TouchableOpacity style={s.cancelBtn} onPress={returnToInput}>
                  <Text style={s.cancelTxt}>重新输入</Text>
                </TouchableOpacity>
                <TouchableOpacity style={s.saveTouch} onPress={handleSave} activeOpacity={0.85}>
                  <LinearGradient colors={[C.gradFrom, C.gradTo]} style={s.saveBtn}>
                    <Text style={s.saveTxt}>保存日程</Text>
                  </LinearGradient>
                </TouchableOpacity>
              </View>
            </View>
          )}

          <TouchableOpacity
            style={s.closeBtn}
            onPress={close}
            hitSlop={{ top:10,bottom:10,left:10,right:10 }}
            accessibilityRole="button"
            accessibilityLabel="关闭语音输入"
            testID="schedule-voice-close"
          >
            <Ionicons name="close" size={20} color={C.sub} />
          </TouchableOpacity>
        </SafeAreaView>
        </Animated.View>
      </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  modalRoot:    { flex: 1 },
  backdrop:     { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(0,0,0,0.35)' },
  overlay:      { flex: 1, justifyContent: 'flex-end' },
  sheetMotion:  { width: '100%' },
  sheet:        { backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, paddingBottom: 36, minHeight: 320 },
  confirmSheet: { minHeight: 0, maxHeight: '92%' },
  confirmStep:  { flexShrink: 1, minHeight: 0 },
  confirmHeader:{ minHeight: 34, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  editDraftBtn: { minHeight: 32, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6 },
  editDraftText:{ fontSize: 13, lineHeight: 18, color: C.purple, fontWeight: '700' },
  confirmScroll:{ flexGrow: 0, flexShrink: 1, minHeight: 0 },
  confirmScrollContent: { paddingTop: 8 },
  handle:       { width: 40, height: 4, borderRadius: 2, backgroundColor: C.border, alignSelf: 'center', marginBottom: 16 },
  title:        { fontSize: 17, fontWeight: '700', color: C.text, marginBottom: 4 },
  hint:         { fontSize: 12, color: C.sub, marginBottom: 14 },
  textBox:      { backgroundColor: C.inputBg, borderRadius: 14, padding: 12, fontSize: 14, color: C.text, minHeight: 80, textAlignVertical: 'top', marginBottom: 8 },
  errorSlot:    { height: ERROR_SLOT_HEIGHT, justifyContent: 'center', marginBottom: 8 },
  errText:      { minWidth: 0, fontSize: 12, lineHeight: ERROR_LINE_HEIGHT, color: C.red },
  actionDock:   { height: 64, flexDirection: 'row', alignItems: 'center' },
  actionSide:   { flex: 1, minWidth: 0, justifyContent: 'center' },
  actionSideRight:{ alignItems: 'flex-end' },
  micTouch:     { width: 72, alignItems: 'center', justifyContent: 'center' },
  micBtn:       { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
  recordingLabel:{ fontSize: 12, lineHeight: 16, color: C.red },
  submitBtn:    { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: C.purple, borderRadius: 20, paddingHorizontal: 18, paddingVertical: 10 },
  submitTxt:    { fontSize: 14, fontWeight: '600', color: '#fff' },
  loadingWrap:  { alignItems: 'center', paddingVertical: 40, gap: 14 },
  loadingTxt:   { fontSize: 14, color: C.sub },
  clarifyBox:   { flexDirection: 'row', alignItems: 'flex-start', gap: 6, backgroundColor: '#FFF8E1', borderRadius: 10, padding: 10, marginBottom: 12 },
  clarifyTxt:   { flex: 1, minWidth: 0, fontSize: 13, color: C.text },
  clarifyAnswerRow: { minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  clarifyInput: { flex: 1, minWidth: 0, backgroundColor: C.inputBg, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: C.text },
  clarifyBtn:   { flexShrink: 0, backgroundColor: C.orange, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10 },
  clarifyBtnText:{ fontSize: 13, fontWeight: '700', color: '#fff' },
  draftCard:    { backgroundColor: C.tasksBg, borderRadius: 16, padding: 16, marginBottom: 16, gap: 10 },
  recognizedBox:{ flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingBottom: 4 },
  recognizedText:{ flex: 1, minWidth: 0, fontSize: 12, lineHeight: 17, color: C.sub },
  draftTitle:   { minWidth: 0, flexShrink: 1, fontSize: 17, fontWeight: '700', color: C.text },
  draftRow:     { minWidth: 0, flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  draftVal:     { flex: 1, minWidth: 0, fontSize: 13, color: C.text },
  draftMeta:    { fontSize: 11, color: C.faint, marginTop: 4 },
  confirmRow:   { flexShrink: 0, flexDirection: 'row', gap: 12 },
  cancelBtn:    { flex: 1, minWidth: 0, borderRadius: 20, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center', paddingVertical: 12 },
  cancelTxt:    { fontSize: 14, color: C.sub },
  saveTouch:    { flex: 1, minWidth: 0 },
  saveBtn:      { width: '100%', borderRadius: 20, paddingVertical: 12, paddingHorizontal: 24, alignItems: 'center', justifyContent: 'center' },
  saveTxt:      { fontSize: 14, fontWeight: '700', color: '#fff' },
  closeBtn:     { position: 'absolute', top: 16, right: 16 },
});
