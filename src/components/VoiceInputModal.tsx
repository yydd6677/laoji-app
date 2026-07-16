import React, { useEffect, useState, useRef } from 'react';
import {
  Animated, Modal, View, Text, TextInput, TouchableOpacity, Pressable,
  StyleSheet, ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';
import { SafeAreaView } from 'react-native-safe-area-context';
import { NavigationProp, useNavigation } from '@react-navigation/native';
import { Colors as C, Motion } from '../theme/colors';
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
import { createClientRequestState, requestStateForPayload } from '../services/clientRequestId';
import { diagnosticWarn } from '../services/diagnostics';
import { reminderUnavailableMessage } from '../services/notifications';
import { CalEvent, EventDraftParams, RootStackParamList } from '../types';
import { validateEventDraft } from '../utils/eventDraftValidation';

interface Props {
  visible: boolean;
  onClose: () => void;
  onSaved: () => void;
}

type Step = 'input' | 'connecting' | 'recording' | 'parsing' | 'confirm' | 'saving';
type RecordingMode = 'realtime' | 'file';
type AudioLevelSummary = { frameCount: number; maxPeak: number; maxRms: number };
type IconName = React.ComponentProps<typeof Ionicons>['name'];

const LOW_AUDIO_PEAK = 1000;
const LOW_AUDIO_RMS = 280;
const ERROR_LINE_HEIGHT = 17;
const ERROR_SLOT_HEIGHT = ERROR_LINE_HEIGHT * 2;
const HOLD_TO_TALK_DELAY_MS = 320;

export const VOICE_INPUT_GEOMETRY = Object.freeze({
  sheetRadius: 12,
  titleBarHeight: 48,
  titleRowMinHeight: 52,
  fieldRowMinHeight: 48,
  fieldIconColumnWidth: 46,
  controlDockHeight: 128,
  microphoneSize: 72,
  microphoneTouchSize: 88,
  holdToTalkDelay: HOLD_TO_TALK_DELAY_MS,
  errorSlotHeight: ERROR_SLOT_HEIGHT,
  backdropDuration: Motion.standard,
  enterDuration: Motion.panel,
  exitDuration: Motion.standard,
  entryOffset: 48,
});

function VoiceSheetTitleBar({
  title,
  leftText,
  rightText,
  onLeft,
  onRight,
  onClose,
  testID,
}: {
  title: string;
  leftText?: string;
  rightText?: string;
  onLeft?: () => void;
  onRight?: () => void;
  onClose?: () => void;
  testID?: string;
}) {
  return (
    <View style={s.sheetTitleBar} testID={testID}>
      <View style={s.sheetTitleSide}>
        {leftText && onLeft ? (
          <TouchableOpacity
            style={s.sheetTextAction}
            onPress={onLeft}
            activeOpacity={0.65}
            accessibilityRole="button"
            accessibilityLabel={leftText}
          >
            <Text style={s.sheetCancelText}>{leftText}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      <Text style={s.sheetTitle} numberOfLines={1} testID={testID ? `${testID}-title` : undefined}>{title}</Text>
      <View
        style={[s.sheetTitleSide, s.sheetTitleSideRight]}
        testID={testID ? `${testID}-right-slot` : undefined}
      >
        {rightText && onRight ? (
          <TouchableOpacity
            style={[s.sheetTextAction, s.sheetTextActionRight]}
            onPress={onRight}
            activeOpacity={0.65}
            accessibilityRole="button"
            accessibilityLabel={rightText}
          >
            <Text style={s.sheetSaveText}>{rightText}</Text>
          </TouchableOpacity>
        ) : onClose ? (
          <TouchableOpacity
            style={s.sheetCloseAction}
            onPress={onClose}
            activeOpacity={0.65}
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            accessibilityRole="button"
            accessibilityLabel="关闭语音输入"
            testID="schedule-voice-close"
          >
            <Ionicons name="close" size={20} color={C.sub} />
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

function ParsedFieldRow({
  icon,
  value,
  testID,
  onPress,
  trailing,
  accessibilityLabel,
}: {
  icon: IconName;
  value: string;
  testID?: string;
  onPress?: () => void;
  trailing?: React.ReactNode;
  accessibilityLabel?: string;
}) {
  const content = (
    <>
      <View style={s.parsedFieldIcon}>
        <Ionicons name={icon} size={18} color={C.faint} />
      </View>
      <Text style={s.parsedFieldValue}>{value}</Text>
      {trailing}
    </>
  );

  if (onPress) {
    return (
      <TouchableOpacity
        style={s.parsedFieldRow}
        onPress={onPress}
        activeOpacity={0.65}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? value}
        testID={testID}
      >
        {content}
      </TouchableOpacity>
    );
  }

  return <View style={s.parsedFieldRow} testID={testID}>{content}</View>;
}

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
  const { addEvent, findConflicts } = useEvents();
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
  const operationRunRef         = useRef(0);
  const micPressStartedAtRef    = useRef(0);
  const micPressStartedStepRef  = useRef<Step | null>(null);
  const micPhysicalReleaseAtRef = useRef(0);
  const micHoldTimerRef         = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdReleaseRequestedRef = useRef(false);
  const createRequestRef        = useRef(createClientRequestState('event'));
  const transcriptRef           = useRef('');
  const transcriptSegmentsRef   = useRef<ScheduleTranscriptSegment[]>([]);
  const audioLevelRef           = useRef<AudioLevelSummary>({ frameCount: 0, maxPeak: 0, maxRms: 0 });
  const [recordingMode, setRecordingMode] = useState<RecordingMode | null>(null);
  const [micInteraction, setMicInteraction] = useState<'idle' | 'latched' | 'holding'>('idle');
  const [mounted, setMounted]   = useState(visible);
  const [closing, setClosing]   = useState(false);
  const mountedRef              = useRef(visible);
  const closingRef              = useRef(false);
  const transitionRef           = useRef(0);
  const onCloseRef              = useRef(onClose);
  const onSavedRef              = useRef(onSaved);
  const backdropOpacity         = useRef(new Animated.Value(0)).current;
  const sheetTranslateY         = useRef(new Animated.Value(VOICE_INPUT_GEOMETRY.entryOffset)).current;
  onCloseRef.current = onClose;
  onSavedRef.current = onSaved;

  const invalidatePendingWork = () => {
    operationRunRef.current += 1;
    recordingRunRef.current += 1;
    if (micHoldTimerRef.current) clearTimeout(micHoldTimerRef.current);
    micHoldTimerRef.current = null;
    holdReleaseRequestedRef.current = false;
    micPressStartedStepRef.current = null;
  };

  const reset = () => {
    invalidatePendingWork();
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
    holdReleaseRequestedRef.current = false;
    micPressStartedStepRef.current = null;
    setMicInteraction('idle');
    createRequestRef.current = createClientRequestState('event');
  };
  const returnToInput = () => {
    operationRunRef.current += 1;
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

  const finishPresentation = (afterExit?: () => void) => {
    if (!mountedRef.current || closingRef.current) return;

    closingRef.current = true;
    setClosing(true);
    invalidatePendingWork();
    void stopActiveRecordingSilently();
    const transition = transitionRef.current + 1;
    transitionRef.current = transition;
    backdropOpacity.stopAnimation();
    sheetTranslateY.stopAnimation();
    Animated.parallel([
      Animated.timing(backdropOpacity, {
        toValue: 0,
        duration: VOICE_INPUT_GEOMETRY.backdropDuration,
        useNativeDriver: true,
      }),
      Animated.timing(sheetTranslateY, {
        toValue: VOICE_INPUT_GEOMETRY.entryOffset,
        duration: VOICE_INPUT_GEOMETRY.exitDuration,
        useNativeDriver: true,
      }),
    ]).start(({ finished }) => {
      if (!finished || transitionRef.current !== transition) return;

      mountedRef.current = false;
      closingRef.current = false;
      setMounted(false);
      setClosing(false);
      reset();
      afterExit?.();
    });
  };

  const requestClose = () => {
    if (step === 'saving' || closingRef.current) return;
    finishPresentation(() => onCloseRef.current());
  };

  useEffect(() => {
    if (visible) {
      const interruptedExit = closingRef.current;
      transitionRef.current += 1;
      backdropOpacity.stopAnimation();
      sheetTranslateY.stopAnimation();
      closingRef.current = false;
      mountedRef.current = true;
      setClosing(false);
      setMounted(true);
      if (interruptedExit) reset();
      backdropOpacity.setValue(0);
      sheetTranslateY.setValue(VOICE_INPUT_GEOMETRY.entryOffset);
      Animated.parallel([
        Animated.timing(backdropOpacity, {
          toValue: 1,
          duration: VOICE_INPUT_GEOMETRY.backdropDuration,
          useNativeDriver: true,
        }),
        Animated.timing(sheetTranslateY, {
          toValue: 0,
          duration: VOICE_INPUT_GEOMETRY.enterDuration,
          useNativeDriver: true,
        }),
      ]).start();
      return;
    }

    finishPresentation();
  }, [visible]);

  useEffect(() => () => {
    transitionRef.current += 1;
    invalidatePendingWork();
    backdropOpacity.stopAnimation();
    sheetTranslateY.stopAnimation();
  }, [backdropOpacity, sheetTranslateY]);

  // ── Text submit ────────────────────────────────────────────────────────────
  const handleSubmitText = async () => {
    if (!text.trim()) return;
    const runId = operationRunRef.current + 1;
    operationRunRef.current = runId;
    const sourceText = text.trim();
    setStep('parsing'); setError('');
    try {
      const result = await parseText(sourceText);
      if (operationRunRef.current !== runId) return;
      acceptNewDraft(result); setStep('confirm');
    } catch {
      if (operationRunRef.current !== runId) return;
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
        if (micHoldTimerRef.current) clearTimeout(micHoldTimerRef.current);
        micHoldTimerRef.current = null;
        setMicInteraction('idle');
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
        if (holdReleaseRequestedRef.current) void stopRecording();
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
          setMicInteraction('idle');
          setStep('input');
        }).catch(err => {
          if (recordingRunRef.current !== runId || realtimeRef.current !== realtime) return;
          void releaseRealtimeAuthorization(authorization);
          setError(voiceErrorText(err));
          setStep('input');
          realtimeRef.current = null;
          recordingModeRef.current = null;
          setRecordingMode(null);
          setMicInteraction('idle');
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
      if (holdReleaseRequestedRef.current) void stopRecording();
    } catch (err) {
      diagnosticWarn('recording start failed', err);
      if (recordingRunRef.current === runId) {
        if (micHoldTimerRef.current) clearTimeout(micHoldTimerRef.current);
        micHoldTimerRef.current = null;
        setMicInteraction('idle');
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
    const runId = recordingRunRef.current;
    if (micHoldTimerRef.current) clearTimeout(micHoldTimerRef.current);
    micHoldTimerRef.current = null;
    setMicInteraction('idle');
    recordingStopRef.current = true;
    if (recordingModeRef.current === 'realtime') {
      const realtime = realtimeRef.current;
      if (!realtime) return;
      setStep('parsing');
      try {
        await discardScheduleRecording(await realtime.stop());
        if (recordingRunRef.current !== runId) return;
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
        if (recordingRunRef.current !== runId) return;
        acceptNewDraft(result);
        setStep('confirm');
      } catch (err) {
        if (recordingRunRef.current !== runId) return;
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
      if (recordingRunRef.current !== runId) return;
      const uri = recordingRef.current.getURI();
      recordingRef.current = null;
      recordingModeRef.current = null;
      setRecordingMode(null);
      if (!uri) throw new Error('recording uri is empty');
      const result = await parseAudio(uri);
      if (recordingRunRef.current !== runId) return;
      const transcribed = result.raw_text ?? '';
      if (!transcribed.trim()) { setError('未识别到语音内容'); setStep('input'); return; }
      setText(transcribed);
      acceptNewDraft(result); setStep('confirm');
    } catch (err) {
      if (recordingRunRef.current !== runId) return;
      diagnosticWarn('voice recognition failed', err);
      setError(voiceErrorText(err)); setStep('input');
      recordingRef.current = null;
      recordingModeRef.current = null;
      setRecordingMode(null);
    }
  };

  const handleMicPressIn = () => {
    micPressStartedAtRef.current = Date.now();
    micPressStartedStepRef.current = step;
    if (step !== 'input') return;
    holdReleaseRequestedRef.current = false;
    setMicInteraction('latched');
    micHoldTimerRef.current = setTimeout(() => {
      setMicInteraction('holding');
    }, HOLD_TO_TALK_DELAY_MS);
    void startRecording();
  };

  const handleMicPressOut = () => {
    const startedStep = micPressStartedStepRef.current;
    micPressStartedStepRef.current = null;
    micPhysicalReleaseAtRef.current = Date.now();
    if (micHoldTimerRef.current) clearTimeout(micHoldTimerRef.current);
    micHoldTimerRef.current = null;

    if (startedStep === 'recording') {
      void stopRecording();
      return;
    }
    if (startedStep !== 'input') return;

    const heldFor = Date.now() - micPressStartedAtRef.current;
    if (heldFor >= HOLD_TO_TALK_DELAY_MS) {
      holdReleaseRequestedRef.current = true;
      setMicInteraction('idle');
      if (recordingModeRef.current) void stopRecording();
      return;
    }
    setMicInteraction('latched');
  };

  const handleMicPress = () => {
    if (Date.now() - micPhysicalReleaseAtRef.current < 120) return;
    if (step === 'recording') {
      void stopRecording();
      return;
    }
    if (step === 'input') {
      setMicInteraction('latched');
      void startRecording();
    }
  };

  // ── Clarify parser follow-up ───────────────────────────────────────────────
  const handleClarify = async () => {
    if (!draft || !clarifyAnswer.trim()) return;
    const runId = operationRunRef.current + 1;
    operationRunRef.current = runId;
    setStep('parsing'); setError('');
    try {
      const answer = clarifyAnswer.trim();
      const result = await clarifyText(text, answer, draft);
      if (operationRunRef.current !== runId) return;
      setDraft(result);
      setText(prev => prev ? `${prev}\n${answer}` : answer);
      setClarifyAnswer('');
      setStep('confirm');
    } catch {
      if (operationRunRef.current !== runId) return;
      setError('补充解析失败，请重试');
      setStep('confirm');
    }
  };

  // ── Save ───────────────────────────────────────────────────────────────────
  const eventPayloadFromDraft = (source: ParseResult): Omit<CalEvent, 'id'> => {
    const category = normalizeEventCategory(source.category);
    const hasTimedRange = !source.is_all_day && Boolean(source.start_time && source.end_time);
    return {
      title:       source.title.trim(),
      startDate:   source.start_date,
      endDate:     source.end_date ?? undefined,
      startTime:   source.is_all_day ? undefined : source.start_time ?? undefined,
      endTime:     source.is_all_day ? undefined : source.end_time ?? undefined,
      isAllDay:    source.is_all_day,
      repeat:      source.event_type !== 'once' ? source.event_type : undefined,
      description: source.description ?? undefined,
      rawText:     source.raw_text ?? text,
      location:    source.location ?? undefined,
      category,
      detail:      source.detail ?? undefined,
      status:      source.status ?? undefined,
      spanning:    source.spanning ?? Boolean(source.end_date && source.end_date !== source.start_date),
      reminderMinutes: hasTimedRange ? source.reminder_minutes ?? null : null,
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
    const result = validateEventDraft(eventPayloadFromDraft(source));
    if (result.valid) return true;
    setError(result.issues[0]?.message ?? '日程信息不完整');
    return false;
  };

  const saveDraft = async (eventPayload: Omit<CalEvent, 'id'>) => {
    const runId = operationRunRef.current + 1;
    operationRunRef.current = runId;
    setStep('saving');
    try {
      createRequestRef.current = requestStateForPayload(createRequestRef.current, 'event', eventPayload);
      const { reminderDelivery } = await addEvent({ ...eventPayload, clientRequestId: createRequestRef.current.id });
      if (operationRunRef.current !== runId) return;
      finishPresentation(() => {
        onSavedRef.current();
        onCloseRef.current();
        if (reminderDelivery === 'unavailable') {
          void reminderUnavailableMessage().then(message => showDialog({
            title: '日程已保存',
            message,
            tone: 'warning',
          }));
        } else if (reminderDelivery === 'unconfirmed') {
          showDialog({
            title: '日程已保存',
            message: '本机提醒状态未能确认，可重新打开日程并保存提醒。',
            tone: 'warning',
          });
        }
      });
    } catch {
      if (operationRunRef.current !== runId) return;
      setError('保存失败，请重试'); setStep('confirm');
    }
  };

  const handleSave = async () => {
    if (!draft || !validateDraftForSave(draft)) return;
    const eventPayload = eventPayloadFromDraft(draft);
    const validation = validateEventDraft(eventPayload);
    if (!validation.valid || !validation.value) return;
    const runId = operationRunRef.current + 1;
    operationRunRef.current = runId;
    try {
      const result = await findConflicts(validation.value);
      if (operationRunRef.current !== runId) return;
      if (result.hasConflict) {
        const explicit = result.conflicts.some(conflict => conflict.severity === 'overlap');
        const names = result.conflicts.map(({ event }) => {
          const time = event.startTime && event.endTime
            ? `${event.startTime}–${event.endTime}`
            : event.isAllDay ? '全天' : '无具体时间';
          return `• ${event.title} (${time})`;
        }).join('\n');
        showDialog({
          title: explicit ? '时间冲突' : '全天安排提示',
          message: `${explicit ? '该安排与以下日程重叠' : '该日期已有全天或定时安排'}：\n${names}`,
          hint: result.complete
            ? '如果确认这些安排可以重叠，仍然可以继续保存。'
            : '当前只能核对本机已有日程；仍可继续保存。',
          tone: 'warning',
          actions: [
            { text: '仍然保存', role: 'primary', onPress: () => saveDraft(validation.value!) },
            { text: '取消', role: 'cancel' },
          ],
        });
        return;
      }
      await saveDraft(validation.value);
    } catch {
      if (operationRunRef.current !== runId) return;
      setError('暂时无法检查日程冲突，请重试');
    }
  };

  const openDetailedEdit = () => {
    if (!draft || !validateDraftForSave(draft)) return;
    const params = { date: draft.start_date, draft: routeDraftFromParseResult(draft) };
    finishPresentation(() => {
      onCloseRef.current();
      navigation.navigate('AddEvent', params);
    });
  };

  const fmtDate = (dateText: string) => {
    const [year, month, day] = dateText.split('-').map(Number);
    const value = new Date(year, month - 1, day);
    if (
      !Number.isInteger(year)
      || !Number.isInteger(month)
      || !Number.isInteger(day)
      || Number.isNaN(value.getTime())
    ) return dateText.replace(/-/g, '/');
    const weekday = ['日', '一', '二', '三', '四', '五', '六'][value.getDay()];
    const yearText = year === new Date().getFullYear() ? '' : `${year}年`;
    return `${yearText}${month}月${day}日 周${weekday}`;
  };
  const fmtDateRange = (draft: ParseResult) => {
    if (draft.end_date && draft.end_date !== draft.start_date) {
      return `${fmtDate(draft.start_date)} – ${fmtDate(draft.end_date)}`;
    }
    return fmtDate(draft.start_date);
  };
  const fmtTime = (t: string | null) => t ?? '全天';
  const fmtRepeat = (value: ParseResult['event_type']) => {
    if (value === 'daily') return '每天重复';
    if (value === 'weekly') return '每周重复';
    if (value === 'monthly') return '每月重复';
    if (value === 'yearly') return '每年重复';
    return '不重复';
  };
  const fmtReminder = (minutes: number | null | undefined) => {
    if (minutes === null || minutes === undefined) return '不提醒';
    if (minutes === 0) return '开始时提醒';
    if (minutes % (24 * 60) === 0) return `提前 ${minutes / (24 * 60)} 天提醒`;
    if (minutes % 60 === 0) return `提前 ${minutes / 60} 小时提醒`;
    return `提前 ${minutes} 分钟提醒`;
  };

  if (!mounted) return null;

  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={requestClose}
    >
      <View style={s.modalRoot} accessibilityViewIsModal>
        <Animated.View
          pointerEvents="auto"
          style={[s.backdrop, { opacity: backdropOpacity }]}
          testID="schedule-voice-backdrop"
        >
          <View
            style={s.backdropHitShield}
            accessible={false}
            testID="schedule-voice-backdrop-hit-shield"
          />
        </Animated.View>
        <KeyboardAvoidingView
          pointerEvents="box-none"
          style={s.overlay}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <Animated.View
            pointerEvents={closing ? 'none' : 'auto'}
            style={[s.sheetMotion, { transform: [{ translateY: sheetTranslateY }] }]}
            testID="schedule-voice-sheet-motion"
          >
            <SafeAreaView
              style={[s.sheet, step === 'confirm' && s.confirmSheet]}
              edges={['bottom']}
              testID="schedule-voice-sheet"
            >
          {/* ── Input step ── */}
          {(step === 'input' || step === 'connecting' || step === 'recording') && (
            <View style={s.inputStep}>
              <VoiceSheetTitleBar
                title="语音新建日程"
                onClose={requestClose}
                testID="schedule-voice-input-title-bar"
              />

              <View style={s.inputContent}>
                <TextInput
                  style={s.textBox}
                  testID="schedule-voice-input"
                  placeholder="输入日程内容"
                  placeholderTextColor={C.faint}
                  value={text}
                  onChangeText={setText}
                  multiline
                  maxLength={200}
                  editable={step === 'input'}
                />

                <View style={s.errorSlot} testID="schedule-voice-error-slot">
                  {error ? (
                    <Text style={s.errText} numberOfLines={2} accessibilityLiveRegion="polite">
                      {error}
                    </Text>
                  ) : null}
                </View>

                <View style={s.actionDock} testID="schedule-voice-control-dock">
                  <View style={s.recordingStatusSlot}>
                    {(step === 'connecting' || step === 'recording') && (
                      <Text style={s.recordingLabel} numberOfLines={2}>
                        {step === 'connecting'
                          ? '正在连接语音服务'
                          : micInteraction === 'holding'
                            ? '松开结束'
                            : recordingMode === 'realtime'
                              ? '实时识别中，轻点结束'
                              : '录音中，轻点结束'}
                      </Text>
                    )}
                  </View>

                  <Pressable
                    style={s.micTouch}
                    onPressIn={handleMicPressIn}
                    onPressOut={handleMicPressOut}
                    onPress={handleMicPress}
                    accessibilityRole="button"
                    accessibilityLabel={step === 'recording'
                      ? '停止语音输入'
                      : step === 'connecting'
                        ? '正在连接语音服务'
                        : '开始语音输入'}
                    accessibilityState={{
                      busy: step === 'connecting',
                    }}
                    accessibilityHint="轻点可持续录音，再轻点结束；按住录音时松开即可结束"
                    testID={step === 'recording'
                      ? 'schedule-voice-stop'
                      : step === 'connecting'
                        ? 'schedule-voice-connecting'
                        : 'schedule-voice-start'}
                  >
                    <View style={[
                      s.micBtn,
                      step === 'recording' && s.micBtnRecording,
                      micInteraction === 'holding' && s.micBtnHolding,
                    ]} testID="schedule-voice-mic-visual">
                      {step === 'connecting'
                        ? <ActivityIndicator size="small" color="#fff" />
                        : <Ionicons
                            name={step === 'recording' ? 'stop' : 'mic'}
                            size={34} color="#fff"
                          />}
                    </View>
                  </Pressable>

                  {text.trim().length > 0 && step === 'input' && (
                    <TouchableOpacity
                      style={s.submitBtn}
                      onPress={handleSubmitText}
                      activeOpacity={0.65}
                      accessibilityRole="button"
                      accessibilityLabel="解析日程"
                    >
                      <Text style={s.submitTxt}>解析</Text>
                      <Ionicons name="chevron-forward" size={14} color={C.primary} />
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            </View>
          )}

          {/* ── Parsing / saving ── */}
          {(step === 'parsing' || step === 'saving') && (
            <View style={s.loadingStep}>
              <VoiceSheetTitleBar
                title={step === 'parsing' ? '解析日程' : '保存日程'}
                onClose={step === 'saving' ? undefined : requestClose}
              />
              <View style={s.loadingWrap}>
                <ActivityIndicator size="small" color={C.primary} />
                <Text style={s.loadingTxt}>
                  {step === 'parsing' ? '正在解析' : '正在保存'}
                </Text>
              </View>
            </View>
          )}

          {/* ── Confirm step ── */}
          {step === 'confirm' && draft && (
            <View style={s.confirmStep}>
              <VoiceSheetTitleBar
                title="确认日程"
                leftText="取消"
                rightText="保存"
                onLeft={requestClose}
                onRight={handleSave}
                testID="schedule-voice-confirm-actions"
              />

              <ScrollView
                style={s.confirmScroll}
                contentContainerStyle={s.confirmScrollContent}
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                testID="schedule-voice-confirm-scroll"
              >
                {text.trim() ? (
                  <View style={s.transcriptSection}>
                    <View style={s.transcriptHeader}>
                      <Text style={s.transcriptLabel}>识别内容</Text>
                      <TouchableOpacity
                        style={s.reenterAction}
                        onPress={returnToInput}
                        activeOpacity={0.65}
                        accessibilityRole="button"
                        accessibilityLabel="重新输入"
                      >
                        <Ionicons name="refresh" size={15} color={C.primary} />
                        <Text style={s.reenterText}>重新输入</Text>
                      </TouchableOpacity>
                    </View>
                    <Text style={s.recognizedText} testID="schedule-voice-transcript">
                      {text.trim()}
                    </Text>
                  </View>
                ) : null}

                {draft.needs_clarification && draft.clarification_question && (
                  <View style={s.clarifySection}>
                    <View style={s.clarifyPromptRow}>
                      <View style={s.parsedFieldIcon}>
                        <Ionicons name="help-circle-outline" size={18} color={C.faint} />
                      </View>
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
                  </View>
                )}

                <View style={s.draftForm} testID="schedule-voice-draft-form">
                  <Text style={s.draftTitle} testID="schedule-voice-draft-title">{draft.title}</Text>
                  <View style={s.formDivider} />
                  <ParsedFieldRow
                    icon="calendar-outline"
                    value={fmtDateRange(draft)}
                    testID="schedule-voice-field-date"
                  />
                  <ParsedFieldRow
                    icon="time-outline"
                    value={`${fmtTime(draft.start_time)}${draft.end_time ? ` – ${draft.end_time}` : ''}`}
                    testID="schedule-voice-field-time"
                  />
                  <ParsedFieldRow icon="repeat-outline" value={fmtRepeat(draft.event_type)} />
                  <ParsedFieldRow
                    icon="notifications-outline"
                    value={fmtReminder(draft.reminder_minutes)}
                  />
                  {draft.description && (
                    <ParsedFieldRow icon="document-text-outline" value={draft.description} />
                  )}
                  {draft.detail && draft.detail !== draft.description && (
                    <ParsedFieldRow icon="reader-outline" value={draft.detail} />
                  )}
                  {draft.location && (
                    <ParsedFieldRow icon="location-outline" value={draft.location} />
                  )}
                  {draft.status && (
                    <ParsedFieldRow icon="ellipse-outline" value={draft.status} />
                  )}
                  <View style={s.formDivider} />
                  <ParsedFieldRow
                    icon="create-outline"
                    value="编辑更多内容"
                    onPress={openDetailedEdit}
                    testID="schedule-voice-edit-details"
                    accessibilityLabel="编辑日程详情"
                    trailing={<Ionicons name="chevron-forward" size={14} color={C.faint} />}
                  />
                </View>
              </ScrollView>

              <View style={s.errorSlot} testID="schedule-voice-error-slot">
                  {error ? (
                    <Text style={s.errText} numberOfLines={2} accessibilityLiveRegion="polite">
                      {error}
                    </Text>
                  ) : null}
              </View>
            </View>
          )}
            </SafeAreaView>
          </Animated.View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  modalRoot:    { flex: 1 },
  backdrop:     { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: C.overlay },
  backdropHitShield: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  overlay:      { flex: 1, justifyContent: 'flex-end' },
  sheetMotion:  { width: '100%' },
  sheet:        {
    backgroundColor: C.body,
    borderTopLeftRadius: VOICE_INPUT_GEOMETRY.sheetRadius,
    borderTopRightRadius: VOICE_INPUT_GEOMETRY.sheetRadius,
    paddingTop: 8,
    minHeight: 360,
    overflow: 'hidden',
  },
  confirmSheet: { minHeight: 0, maxHeight: '92%' },
  inputStep:    { minHeight: 344 },
  inputContent: { paddingHorizontal: 16 },
  loadingStep:  { minHeight: 280 },
  confirmStep:  { flexShrink: 1, minHeight: 0 },
  sheetTitleBar:{
    height: VOICE_INPUT_GEOMETRY.titleBarHeight,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: C.body,
  },
  sheetTitleSide: { width: 72, height: VOICE_INPUT_GEOMETRY.titleBarHeight, flexShrink: 0, justifyContent: 'center' },
  sheetTitleSideRight: { alignItems: 'flex-end' },
  sheetTitle: {
    flex: 1,
    minWidth: 0,
    fontSize: 17,
    lineHeight: 24,
    fontWeight: '600',
    color: C.text,
    textAlign: 'center',
  },
  sheetTextAction: { height: 48, minWidth: 64, paddingHorizontal: 16, justifyContent: 'center' },
  sheetTextActionRight: { alignItems: 'flex-end' },
  sheetCancelText: { fontSize: 16, lineHeight: 22, color: C.text },
  sheetSaveText: { fontSize: 16, lineHeight: 22, fontWeight: '500', color: C.primary },
  sheetCloseAction: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  confirmScroll:{ flexGrow: 0, flexShrink: 1, minHeight: 0 },
  confirmScrollContent: { paddingHorizontal: 16, paddingBottom: 8 },
  textBox:      {
    backgroundColor: C.inputBg,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontSize: 14,
    lineHeight: 20,
    color: C.text,
    minHeight: 88,
    maxHeight: 128,
    textAlignVertical: 'top',
    marginTop: 8,
  },
  errorSlot:    {
    height: VOICE_INPUT_GEOMETRY.errorSlotHeight,
    justifyContent: 'center',
    marginHorizontal: 16,
  },
  errText:      { minWidth: 0, fontSize: 12, lineHeight: ERROR_LINE_HEIGHT, color: C.red },
  actionDock:   {
    height: VOICE_INPUT_GEOMETRY.controlDockHeight,
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  recordingStatusSlot: {
    position: 'absolute',
    top: 0,
    left: 72,
    right: 72,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  micTouch:     {
    width: VOICE_INPUT_GEOMETRY.microphoneTouchSize,
    height: VOICE_INPUT_GEOMETRY.microphoneTouchSize,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  micBtn:       {
    width: VOICE_INPUT_GEOMETRY.microphoneSize,
    height: VOICE_INPUT_GEOMETRY.microphoneSize,
    borderRadius: VOICE_INPUT_GEOMETRY.microphoneSize / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.primary,
  },
  micBtnRecording:{ backgroundColor: C.red },
  micBtnHolding: { transform: [{ scale: 0.94 }] },
  recordingLabel:{ fontSize: 12, lineHeight: 17, color: C.sub, textAlign: 'center' },
  submitBtn:    {
    position: 'absolute',
    right: 0,
    bottom: 24,
    minWidth: 64,
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 2,
  },
  submitTxt:    { fontSize: 16, lineHeight: 22, fontWeight: '500', color: C.primary },
  loadingWrap:  { flex: 1, minHeight: 200, alignItems: 'center', justifyContent: 'center', gap: 12 },
  loadingTxt:   { fontSize: 14, color: C.sub },
  transcriptSection: { paddingTop: 8, paddingBottom: 14 },
  transcriptHeader: { height: 32, flexDirection: 'row', alignItems: 'center' },
  transcriptLabel: { fontSize: 14, lineHeight: 20, color: C.sub },
  reenterAction: { marginLeft: 'auto', height: 32, flexDirection: 'row', alignItems: 'center', gap: 4 },
  reenterText: { fontSize: 14, lineHeight: 20, color: C.primary },
  recognizedText:{
    minWidth: 0,
    fontSize: 14,
    lineHeight: 20,
    color: C.text,
    backgroundColor: C.inputBg,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  clarifySection: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.divider, paddingBottom: 8 },
  clarifyPromptRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center' },
  clarifyTxt:   { flex: 1, minWidth: 0, fontSize: 14, lineHeight: 20, color: C.text, paddingVertical: 12 },
  clarifyAnswerRow: { minWidth: 0, height: 48, flexDirection: 'row', alignItems: 'center', paddingLeft: 46 },
  clarifyInput: {
    flex: 1,
    minWidth: 0,
    height: 40,
    backgroundColor: C.inputBg,
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 0,
    fontSize: 14,
    color: C.text,
  },
  clarifyBtn:   { flexShrink: 0, height: 40, justifyContent: 'center', paddingLeft: 12 },
  clarifyBtnText:{ fontSize: 14, lineHeight: 20, fontWeight: '500', color: C.primary },
  draftForm:    { minWidth: 0 },
  draftTitle:   {
    minWidth: 0,
    flexShrink: 1,
    minHeight: VOICE_INPUT_GEOMETRY.titleRowMinHeight,
    paddingVertical: 13,
    fontSize: 18,
    lineHeight: 26,
    fontWeight: '500',
    color: C.text,
  },
  formDivider:  {
    height: StyleSheet.hairlineWidth,
    backgroundColor: C.divider,
    marginVertical: 14,
  },
  parsedFieldRow: {
    minHeight: VOICE_INPUT_GEOMETRY.fieldRowMinHeight,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
  },
  parsedFieldIcon: {
    width: VOICE_INPUT_GEOMETRY.fieldIconColumnWidth,
    alignItems: 'flex-start',
    justifyContent: 'center',
    paddingLeft: 4,
  },
  parsedFieldValue: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 12,
    paddingRight: 8,
    fontSize: 16,
    lineHeight: 22,
    color: C.text,
  },
});
