import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { requestRecordingPermissionsAsync, setAudioModeAsync } from 'expo-audio';
import { BackHeader } from '../components/Common';
import { ScreenContainer } from '../components/ScreenContainer';
import { useAppDialog } from '../components/AppDialog';
import { readableErrorMessage } from '../services/errors';
import {
  deleteLocalWavRecording,
  RealtimeAsrAudioStats,
  startLocalWavRecording,
  LocalWavRecordingSession,
} from '../services/realtimeAsr';
import {
  deleteDeviceSpeakerProfile,
  fetchDeviceSpeakerProfiles,
  registerDeviceSpeaker,
  renameDeviceSpeaker,
  supplementDeviceSpeaker,
  deleteSpeaker,
  fetchSpeakers,
  registerSpeaker,
  renameSpeaker,
  SpeakerProfile,
  supplementSpeaker,
} from '../services/speakers';
import { useAuth } from '../store/AuthStore';
import { Colors as C, withAlpha } from '../theme/colors';
import { RootStackParamList } from '../types';
import { meetingAudioLevelPercent } from '../utils/meetingAudioStatus';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'SpeakerEnrollment'>;
  route: RouteProp<RootStackParamList, 'SpeakerEnrollment'>;
};

const MIN_RECORDING_MS = 2000;
const MAX_RECORDING_MS = 15000;
const VOLUME_SEGMENTS = 10;
const VOICEPRINT_SAMPLE_TEXT = '今天的会议将围绕项目进展展开，请大家依次说明完成情况和下一步安排。';

function clock(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return `00:${String(seconds).padStart(2, '0')}`;
}

export function SpeakerEnrollmentScreen({ navigation, route }: Props) {
  const speakerId = route.params?.speakerId;
  const { accessToken, isGuest } = useAuth();
  const deviceMode = isGuest || !accessToken;
  const { showDialog } = useAppDialog();
  const [speaker, setSpeaker] = useState<SpeakerProfile | null>(null);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(Boolean(speakerId));
  const [recording, setRecording] = useState(false);
  const [startingRecording, setStartingRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [audioLevel, setAudioLevel] = useState(0);
  const [audioUri, setAudioUri] = useState('');
  const [fileName, setFileName] = useState('voice.wav');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sessionRef = useRef<LocalWavRecordingSession | null>(null);
  const stopPromiseRef = useRef<Promise<void> | null>(null);
  const startedAtRef = useRef(0);
  const audioUriRef = useRef('');
  const startingRecordingRef = useRef(false);
  const uploadInFlightRef = useRef(false);
  const mountedRef = useRef(true);

  const discardRecording = useCallback(async (uri: string | undefined) => {
    try {
      await deleteLocalWavRecording(uri);
    } catch {
      // Cleanup must never replace the user-facing result of recording/upload.
    }
  }, []);

  const restorePlaybackAudioMode = useCallback(async () => {
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
  }, []);

  const loadSpeaker = useCallback(async () => {
    if (!speakerId) return;
    setLoading(true);
    setError('');
    try {
      const profiles = deviceMode
        ? await fetchDeviceSpeakerProfiles()
        : await fetchSpeakers(accessToken!);
      const found = profiles.find(item => item.speaker_id === speakerId);
      if (!found) throw new Error('讲话人不存在或已被删除');
      setSpeaker(found);
      setName(found.name);
    } catch (reason) {
      setError(readableErrorMessage(reason, '讲话人暂时无法加载。'));
    } finally {
      setLoading(false);
    }
  }, [accessToken, deviceMode, speakerId]);

  useEffect(() => {
    void loadSpeaker();
  }, [loadSpeaker]);

  const stopRecording = useCallback((): Promise<void> => {
    if (stopPromiseRef.current) return stopPromiseRef.current;
    const session = sessionRef.current;
    if (!session) return Promise.resolve();
    const operation = (async () => {
      try {
        const uri = await session.stop();
        if (!mountedRef.current) {
          await discardRecording(uri);
          return;
        }
        audioUriRef.current = uri;
        setAudioUri(uri);
        setFileName(session.fileName);
        setElapsedMs(Math.min(MAX_RECORDING_MS, Date.now() - startedAtRef.current));
      } catch (reason) {
        if (mountedRef.current) setError(readableErrorMessage(reason, '录音没有正确保存，请重新录制。'));
      } finally {
        sessionRef.current = null;
        await restorePlaybackAudioMode();
        if (mountedRef.current) setRecording(false);
      }
    })().finally(() => {
      stopPromiseRef.current = null;
    });
    stopPromiseRef.current = operation;
    return operation;
  }, [discardRecording, restorePlaybackAudioMode]);

  useEffect(() => {
    if (!recording) return;
    const tick = setInterval(() => {
      const next = Date.now() - startedAtRef.current;
      setElapsedMs(Math.min(MAX_RECORDING_MS, next));
      if (next >= MAX_RECORDING_MS) void stopRecording();
    }, 100);
    return () => clearInterval(tick);
  }, [recording, stopRecording]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const session = sessionRef.current;
      sessionRef.current = null;
      if (session) {
        void session.stop()
          .then(async uri => {
            await discardRecording(uri);
            await restorePlaybackAudioMode();
          })
          .catch(() => { void restorePlaybackAudioMode(); });
      }
      if (!uploadInFlightRef.current) {
        const uri = audioUriRef.current;
        audioUriRef.current = '';
        void discardRecording(uri);
      }
    };
  }, [discardRecording, restorePlaybackAudioMode]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active' && sessionRef.current) void stopRecording();
    });
    return () => subscription.remove();
  }, [stopRecording]);

  const startRecording = async () => {
    if (recording || busy || startingRecordingRef.current) return;
    startingRecordingRef.current = true;
    setStartingRecording(true);
    setError('');
    const previousUri = audioUriRef.current;
    audioUriRef.current = '';
    setAudioUri('');
    void discardRecording(previousUri);
    setElapsedMs(0);
    setAudioLevel(0);
    let recordingStarted = false;
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!mountedRef.current || AppState.currentState !== 'active') return;
      if (!permission.granted) {
        showDialog({ title: '无法录制音色', message: '请允许麦克风权限后再录制。', tone: 'warning' });
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      if (!mountedRef.current || AppState.currentState !== 'active') return;
      const id = `speaker-${Date.now()}`;
      const session = await startLocalWavRecording(id, (stats: RealtimeAsrAudioStats) => {
        if (mountedRef.current) setAudioLevel(meetingAudioLevelPercent(stats.raw.rms));
      });
      if (!mountedRef.current || AppState.currentState !== 'active') {
        await session.stop().then(uri => discardRecording(uri)).catch(() => {});
        return;
      }
      sessionRef.current = session;
      startedAtRef.current = Date.now();
      recordingStarted = true;
      setRecording(true);
    } catch (reason) {
      if (mountedRef.current) setError(readableErrorMessage(reason, '启动录音失败，请稍后重试。'));
    } finally {
      if (!recordingStarted) await restorePlaybackAudioMode();
      startingRecordingRef.current = false;
      if (mountedRef.current) setStartingRecording(false);
    }
  };

  const submit = async () => {
    if (!audioUri || elapsedMs < MIN_RECORDING_MS || uploadInFlightRef.current) return;
    if (!speakerId && !name.trim()) {
      setError('请先填写讲话人名称。');
      return;
    }
    uploadInFlightRef.current = true;
    setBusy(true);
    setError('');
    try {
      const result = speakerId
        ? deviceMode
          ? await supplementDeviceSpeaker(speakerId, audioUri, fileName)
          : await supplementSpeaker(speakerId, audioUri, fileName, accessToken!)
        : deviceMode
          ? await registerDeviceSpeaker(name, audioUri, fileName)
          : await registerSpeaker(name, audioUri, fileName, accessToken!);
      await discardRecording(audioUri);
      audioUriRef.current = '';
      if (!mountedRef.current) return;
      setAudioUri('');
      showDialog({
        title: '声纹采集成功',
        message: speakerId
          ? `已为“${result.speaker.name}”补充声纹，后续会议将自动应用这个名称。`
          : `已建立“${result.speaker.name}”，后续会议将自动应用这个名称。`,
        tone: 'success',
        actions: [{ text: '完成', role: 'primary', onPress: () => navigation.goBack() }],
      });
    } catch (reason) {
      if (mountedRef.current) {
        setError(readableErrorMessage(reason, '音色保存失败，请重新录制后再试。'));
      } else {
        await discardRecording(audioUri);
        audioUriRef.current = '';
      }
    } finally {
      uploadInFlightRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  const saveName = async () => {
    if (!speaker || !speakerId || !name.trim() || name.trim() === speaker.name) return;
    setBusy(true);
    setError('');
    try {
      const result = deviceMode
        ? await renameDeviceSpeaker(speakerId, name)
        : await renameSpeaker(speakerId, name, accessToken!);
      setSpeaker(result.speaker);
      setName(result.speaker.name);
    } catch (reason) {
      setError(readableErrorMessage(reason, '名称保存失败，请稍后重试。'));
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = () => {
    if (!speakerId || busy || recording || startingRecording) return;
    showDialog({
      title: '删除讲话人',
      message: `删除“${speaker?.name ?? name}”后，后续会议将不再使用这份音色识别名称。`,
      tone: 'danger',
      actions: [
        {
          text: '删除',
          role: 'destructive',
          onPress: async () => {
            setBusy(true);
            try {
              if (deviceMode) await deleteDeviceSpeakerProfile(speakerId);
              else await deleteSpeaker(speakerId, accessToken!);
              navigation.goBack();
            } catch (reason) {
              setError(readableErrorMessage(reason, '删除失败，请稍后重试。'));
            } finally {
              setBusy(false);
            }
          },
        },
        { text: '取消', role: 'cancel' },
      ],
    });
  };

  const stateText = useMemo(() => {
    if (startingRecording) return '正在准备麦克风';
    if (recording) return '正在采集声音';
    if (audioUri && elapsedMs >= MIN_RECORDING_MS) return '录音已就绪';
    if (audioUri) return '录音不足 2 秒，请重新录制';
    return '尚未录制';
  }, [audioUri, elapsedMs, recording, startingRecording]);

  const recordingReady = Boolean(audioUri && elapsedMs >= MIN_RECORDING_MS);
  const destructiveActionsLocked = busy || recording || startingRecording;
  const recordActionLabel = recording
    ? '停止录制音色'
    : audioUri
      ? '重新录制音色'
      : '开始录制音色';

  if (speakerId && !speaker) {
    return (
      <ScreenContainer edges={['top']} bg={C.appBg}>
        <BackHeader title="讲话人详情" onBack={() => navigation.goBack()} />
        <View style={s.centerState}>
          {loading ? (
            <>
              <ActivityIndicator color={C.primary} />
              <Text style={s.stateHint}>正在加载讲话人</Text>
            </>
          ) : (
            <>
              <View style={s.loadErrorIcon}>
                <Ionicons name="cloud-offline-outline" size={26} color={C.red} />
              </View>
              <Text style={s.stateTitle}>讲话人未能加载</Text>
              <Text style={s.stateHint}>{error || '请检查网络后重试。'}</Text>
              <TouchableOpacity
                style={s.retryButton}
                onPress={() => { void loadSpeaker(); }}
                accessibilityRole="button"
                accessibilityLabel="重试加载讲话人详情"
              >
                <Ionicons name="refresh" size={17} color="#fff" />
                <Text style={s.retryButtonText}>重试</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer edges={['top', 'bottom']} bg={C.appBg}>
      <BackHeader
        title={speakerId ? '讲话人详情' : '声纹采集'}
        onBack={() => navigation.goBack()}
        right={speakerId ? (
          <TouchableOpacity
            style={[s.headerButton, destructiveActionsLocked && s.headerButtonDisabled]}
            onPress={confirmDelete}
            disabled={destructiveActionsLocked}
            accessibilityRole="button"
            accessibilityLabel="删除讲话人"
            accessibilityState={{ disabled: destructiveActionsLocked }}
          >
            <Ionicons
              name="trash-outline"
              size={24}
              color={C.red}
              testID="speaker-delete-icon"
            />
          </TouchableOpacity>
        ) : null}
      />
      <ScrollView style={s.scroll} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <View style={s.nameSection}>
          <View style={s.nameRow}>
            <TextInput
              style={s.nameInput}
              value={name}
              onChangeText={setName}
              placeholder="输入人名"
              placeholderTextColor={C.faint}
              maxLength={30}
              editable={!busy && !recording}
              accessibilityLabel="讲话人名称"
            />
            {speaker ? (
              <TouchableOpacity
                style={s.saveNameButton}
                onPress={() => void saveName()}
                disabled={busy || !name.trim() || name.trim() === speaker.name}
                accessibilityRole="button"
                accessibilityLabel="保存讲话人名称"
                accessibilityState={{ disabled: busy || !name.trim() || name.trim() === speaker.name }}
              >
                <Text style={[
                  s.saveNameText,
                  (busy || !name.trim() || name.trim() === speaker.name) && s.saveNameTextDisabled,
                ]}>保存</Text>
              </TouchableOpacity>
            ) : null}
          </View>
          {speaker ? <Text style={s.nameHint}>后续会议将自动应用修改后的名称</Text> : null}
        </View>

        <View style={s.groupGap} />
        <View style={s.recordingSection}>
          <Text style={s.recordingHint}>
            {speakerId
              ? '请在安静环境下，点击“开始”后朗读下方文字以补充声纹'
              : '请在安静环境下，点击“开始”后朗读下方文字'}
          </Text>
          <View style={s.readingPanel}>
            <Text style={s.readingText}>{VOICEPRINT_SAMPLE_TEXT}</Text>
          </View>
          <Text style={s.readingHint}>偶尔读错无需停顿，继续朗读即可</Text>
          <View style={s.recordingMetaRow}>
            <Text style={s.recordingState}>{stateText}</Text>
            <Text style={s.timer}>{clock(elapsedMs)} / 00:15</Text>
          </View>
          <View style={s.levelTrack} testID="speaker-volume-level">
            {Array.from({ length: VOLUME_SEGMENTS }, (_, index) => (
              <View
                key={index}
                testID="speaker-volume-segment"
                style={[
                  s.levelSegment,
                  audioLevel >= ((index + 1) / VOLUME_SEGMENTS) * 100 && s.levelSegmentActive,
                ]}
              />
            ))}
          </View>
          <View style={s.statusSlot}>
            {error ? <Text style={[s.statusText, s.errorText]} accessibilityRole="alert">{error}</Text> : null}
          </View>
        </View>
      </ScrollView>
      <View style={s.bottomBar} testID="speaker-recording-bottom-bar">
        {recordingReady && !recording && !busy ? (
          <View style={s.readyActions}>
            <TouchableOpacity
              style={s.secondaryButton}
              onPress={() => void startRecording()}
              accessibilityRole="button"
              accessibilityLabel="重新录制音色"
            >
              <Text style={s.secondaryButtonText}>重新录制</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={s.submitButton}
              onPress={() => void submit()}
              accessibilityRole="button"
              accessibilityLabel={speakerId ? '保存补录音色' : '保存新讲话人音色'}
            >
              <Text style={s.submitText}>{speakerId ? '保存补录音色' : '建立讲话人'}</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity
            style={[
              s.recordAction,
              recording && s.recordActionStop,
              (busy || startingRecording) && s.buttonDisabled,
            ]}
            onPress={() => recording ? void stopRecording() : void startRecording()}
            disabled={busy || startingRecording}
            accessibilityRole="button"
            accessibilityLabel={busy ? '正在保存音色' : startingRecording ? '正在准备麦克风' : recordActionLabel}
            testID="speaker-record-action"
          >
            {busy || startingRecording ? <ActivityIndicator size="small" color="#fff" /> : null}
            <Text style={[s.recordActionText, recording && s.recordActionStopText]}>
              {busy ? '正在保存' : startingRecording ? '正在准备' : recording ? '停止' : audioUri ? '重新录制' : '开始'}
            </Text>
          </TouchableOpacity>
        )}
      </View>
    </ScreenContainer>
  );
}

const s = StyleSheet.create({
  headerButton: { width: 48, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerButtonDisabled: { opacity: 0.35 },
  scroll: { flex: 1, backgroundColor: C.appBg },
  content: { flexGrow: 1, paddingBottom: 20 },
  nameSection: { paddingTop: 12, paddingBottom: 12, backgroundColor: C.body },
  nameRow: { height: 40, marginHorizontal: 16, paddingLeft: 12, paddingRight: 2, borderRadius: 6, backgroundColor: C.inputBg, flexDirection: 'row', alignItems: 'center' },
  nameInput: { flex: 1, minWidth: 0, height: 40, padding: 0, fontSize: 16, lineHeight: 24, color: C.text },
  saveNameButton: { width: 56, height: 40, alignItems: 'center', justifyContent: 'center' },
  saveNameText: { fontSize: 14, lineHeight: 20, color: C.primary, fontWeight: '500' },
  saveNameTextDisabled: { color: C.faint },
  nameHint: { marginTop: 8, paddingHorizontal: 16, fontSize: 12, lineHeight: 18, color: C.faint, textAlign: 'center' },
  groupGap: { height: 8, backgroundColor: C.appBg },
  recordingSection: { flex: 1, minHeight: 286, paddingTop: 10, paddingHorizontal: 16, backgroundColor: C.body },
  recordingHint: { marginBottom: 8, fontSize: 14, lineHeight: 20, color: C.text },
  readingPanel: { minHeight: 92, borderRadius: 6, paddingHorizontal: 20, paddingVertical: 16, backgroundColor: C.inputBg, justifyContent: 'center' },
  readingText: { fontSize: 14, lineHeight: 22, color: C.text },
  readingHint: { marginTop: 8, fontSize: 12, lineHeight: 18, color: C.faint },
  recordingMetaRow: { height: 40, marginTop: 4, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  recordingState: { fontSize: 14, lineHeight: 20, color: C.sub },
  timer: { fontSize: 14, lineHeight: 20, color: C.sub, fontVariant: ['tabular-nums'] },
  levelTrack: { width: '100%', height: 5, flexDirection: 'row', gap: 4 },
  levelSegment: { flex: 1, height: 5, borderRadius: 2, backgroundColor: C.border },
  levelSegmentActive: { backgroundColor: C.primary },
  statusSlot: { minHeight: 44, width: '100%', alignItems: 'flex-start', justifyContent: 'center' },
  statusText: { fontSize: 14, lineHeight: 20, color: C.sub },
  errorText: { color: C.red },
  bottomBar: { minHeight: 65, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 9, backgroundColor: C.body, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border },
  readyActions: { height: 48, flexDirection: 'row', gap: 12 },
  recordAction: { height: 48, borderRadius: 6, backgroundColor: C.primary, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  recordActionStop: { backgroundColor: C.body, borderWidth: 1, borderColor: C.border },
  recordActionText: { fontSize: 17, lineHeight: 24, color: '#fff', fontWeight: '600' },
  recordActionStopText: { color: C.text },
  secondaryButton: { flex: 1, height: 48, borderRadius: 6, borderWidth: 1, borderColor: C.border, backgroundColor: C.body, alignItems: 'center', justifyContent: 'center' },
  secondaryButtonText: { fontSize: 17, lineHeight: 24, color: C.text, fontWeight: '600' },
  submitButton: { flex: 1, height: 48, borderRadius: 6, backgroundColor: C.primary, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  submitText: { fontSize: 17, lineHeight: 24, color: '#fff', fontWeight: '600' },
  buttonDisabled: { opacity: 0.42 },
  centerState: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 10 },
  stateTitle: { fontSize: 16, color: C.text, fontWeight: '600' },
  stateHint: { maxWidth: 300, fontSize: 14, lineHeight: 20, color: C.sub, textAlign: 'center' },
  loadErrorIcon: { width: 54, height: 54, borderRadius: 27, alignItems: 'center', justifyContent: 'center', backgroundColor: withAlpha(C.red, 0.08), marginBottom: 2 },
  retryButton: { minWidth: 112, height: 40, borderRadius: 6, backgroundColor: C.primary, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, marginTop: 6 },
  retryButtonText: { fontSize: 14, lineHeight: 20, color: '#fff', fontWeight: '500' },
});
