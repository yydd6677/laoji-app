import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { Audio } from 'expo-av';
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
import { deleteSpeaker, fetchSpeakers, registerSpeaker, renameSpeaker, SpeakerProfile, supplementSpeaker } from '../services/speakers';
import { useAuth } from '../store/AuthStore';
import { Colors as C } from '../theme/colors';
import { RootStackParamList } from '../types';
import { meetingAudioLevelPercent } from '../utils/meetingAudioStatus';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'SpeakerEnrollment'>;
  route: RouteProp<RootStackParamList, 'SpeakerEnrollment'>;
};

const MIN_RECORDING_MS = 2000;
const MAX_RECORDING_MS = 15000;

function clock(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return `00:${String(seconds).padStart(2, '0')}`;
}

export function SpeakerEnrollmentScreen({ navigation, route }: Props) {
  const speakerId = route.params?.speakerId;
  const { accessToken, isGuest } = useAuth();
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
    await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true }).catch(() => {});
  }, []);

  const loadSpeaker = useCallback(async () => {
    if (!speakerId || !accessToken) return;
    setLoading(true);
    setError('');
    try {
      const found = (await fetchSpeakers(accessToken)).find(item => item.speaker_id === speakerId);
      if (!found) throw new Error('讲话人不存在或已被删除');
      setSpeaker(found);
      setName(found.name);
    } catch (reason) {
      setError(readableErrorMessage(reason, '讲话人暂时无法加载。'));
    } finally {
      setLoading(false);
    }
  }, [accessToken, speakerId]);

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
      const permission = await Audio.requestPermissionsAsync();
      if (!mountedRef.current || AppState.currentState !== 'active') return;
      if (!permission.granted) {
        showDialog({ title: '无法录制音色', message: '请允许麦克风权限后再录制。', tone: 'warning' });
        return;
      }
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
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
    if (!accessToken || !audioUri || elapsedMs < MIN_RECORDING_MS || uploadInFlightRef.current) return;
    if (!speakerId && !name.trim()) {
      setError('请先填写讲话人名称。');
      return;
    }
    uploadInFlightRef.current = true;
    setBusy(true);
    setError('');
    try {
      const result = speakerId
        ? await supplementSpeaker(speakerId, audioUri, fileName, accessToken)
        : await registerSpeaker(name, audioUri, fileName, accessToken);
      await discardRecording(audioUri);
      audioUriRef.current = '';
      if (!mountedRef.current) return;
      setAudioUri('');
      showDialog({
        title: speakerId ? '音色已补录' : '讲话人已建立',
        message: `${result.speaker.name} · ${result.speaker.sample_count} 段音色${result.quality_level ? ` · 质量${result.quality_level}` : ''}`,
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
    if (!speaker || !speakerId || !accessToken || !name.trim() || name.trim() === speaker.name) return;
    setBusy(true);
    setError('');
    try {
      const result = await renameSpeaker(speakerId, name, accessToken);
      setSpeaker(result.speaker);
      setName(result.speaker.name);
    } catch (reason) {
      setError(readableErrorMessage(reason, '名称保存失败，请稍后重试。'));
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = () => {
    if (!speakerId || !accessToken) return;
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
              await deleteSpeaker(speakerId, accessToken);
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
    if (recording) return '正在录制音色';
    if (audioUri && elapsedMs >= MIN_RECORDING_MS) return '录音已就绪';
    if (audioUri) return '录音不足 2 秒，请重新录制';
    return '轻触麦克风开始';
  }, [audioUri, elapsedMs, recording, startingRecording]);

  if (isGuest || !accessToken) {
    return (
      <ScreenContainer edges={['top']}>
        <BackHeader title="录制音色" onBack={() => navigation.goBack()} />
        <View style={s.centerState}><Text style={s.stateTitle}>请先登录账号</Text></View>
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer edges={['top']}>
      <BackHeader
        title={speakerId ? '管理讲话人' : '新建讲话人'}
        onBack={() => navigation.goBack()}
        right={speakerId ? (
          <TouchableOpacity style={s.headerButton} onPress={confirmDelete} accessibilityRole="button" accessibilityLabel="删除讲话人">
            <Ionicons name="trash-outline" size={20} color={C.red} />
          </TouchableOpacity>
        ) : null}
      />
      <ScrollView style={s.scroll} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        {loading ? <ActivityIndicator color={C.purple} style={s.loader} /> : null}

        <View style={s.section}>
          <Text style={s.label}>讲话人名称</Text>
          <View style={s.nameRow}>
            <TextInput
              style={s.nameInput}
              value={name}
              onChangeText={setName}
              placeholder="例如：张老师"
              placeholderTextColor={C.faint}
              maxLength={30}
              editable={!busy && !recording}
              accessibilityLabel="讲话人名称"
            />
            {speaker ? (
              <TouchableOpacity
                style={[s.saveNameButton, (busy || !name.trim() || name.trim() === speaker.name) && s.buttonDisabled]}
                onPress={() => void saveName()}
                disabled={busy || !name.trim() || name.trim() === speaker.name}
                accessibilityRole="button"
                accessibilityLabel="保存讲话人名称"
              >
                <Text style={s.saveNameText}>保存</Text>
              </TouchableOpacity>
            ) : null}
          </View>
          {speaker ? <Text style={s.profileMeta}>已保存 {speaker.sample_count} 段音色</Text> : null}
        </View>

        <View style={s.recordingSection}>
          <Text style={s.recordingTitle}>{speakerId ? '补录音色' : '录制音色'}</Text>
          <Text style={s.recordingHint}>自然说话 5 至 10 秒，保持手机与嘴部距离稳定。</Text>
          <Text style={s.timer}>{clock(elapsedMs)}</Text>
          <View style={s.levelTrack}>
            <View style={[s.levelFill, { width: `${audioLevel}%` }]} />
          </View>
          <View style={s.micSlot}>
            <TouchableOpacity
              style={[s.micButton, recording && s.micButtonRecording]}
              onPress={() => recording ? void stopRecording() : void startRecording()}
              disabled={busy || startingRecording}
              activeOpacity={0.82}
              accessibilityRole="button"
              accessibilityLabel={recording ? '停止录制音色' : '开始录制音色'}
            >
              <Ionicons name={recording ? 'stop' : 'mic'} size={32} color="#fff" />
            </TouchableOpacity>
          </View>
          <View style={s.statusSlot}>
            <Text style={[s.statusText, error ? s.errorText : null]} accessibilityRole={error ? 'alert' : undefined}>
              {error || stateText}
            </Text>
          </View>
        </View>

        <TouchableOpacity
          style={[s.submitButton, (!audioUri || elapsedMs < MIN_RECORDING_MS || busy) && s.buttonDisabled]}
          onPress={() => void submit()}
          disabled={!audioUri || elapsedMs < MIN_RECORDING_MS || busy}
          accessibilityRole="button"
          accessibilityLabel={speakerId ? '保存补录音色' : '保存新讲话人音色'}
        >
          {busy ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="checkmark" size={19} color="#fff" />}
          <Text style={s.submitText}>{busy ? '正在保存' : speakerId ? '保存补录音色' : '建立讲话人'}</Text>
        </TouchableOpacity>
      </ScrollView>
    </ScreenContainer>
  );
}

const s = StyleSheet.create({
  headerButton: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  scroll: { flex: 1 },
  content: { padding: 14, paddingBottom: 36 },
  loader: { marginVertical: 10 },
  section: { padding: 16, borderRadius: 16, backgroundColor: C.card, marginBottom: 12 },
  label: { fontSize: 12, color: C.sub, fontWeight: '700', marginBottom: 9 },
  nameRow: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8 },
  nameInput: { flex: 1, minWidth: 0, height: 44, borderRadius: 12, backgroundColor: C.inputBg, paddingHorizontal: 13, fontSize: 14, color: C.text },
  saveNameButton: { width: 62, height: 44, borderRadius: 12, backgroundColor: C.purpleLight, alignItems: 'center', justifyContent: 'center' },
  saveNameText: { fontSize: 13, color: C.purple, fontWeight: '800' },
  profileMeta: { marginTop: 9, fontSize: 11, color: C.sub },
  recordingSection: { borderRadius: 16, backgroundColor: C.card, padding: 18, alignItems: 'center' },
  recordingTitle: { fontSize: 16, color: C.text, fontWeight: '800', marginBottom: 7 },
  recordingHint: { fontSize: 12, lineHeight: 18, color: C.sub, textAlign: 'center' },
  timer: { marginTop: 18, fontSize: 30, color: C.purpleDark, fontWeight: '800' },
  levelTrack: { width: '76%', height: 8, borderRadius: 4, backgroundColor: '#E4DDF4', overflow: 'hidden', marginTop: 12 },
  levelFill: { height: '100%', borderRadius: 4, backgroundColor: C.pink },
  micSlot: { height: 118, alignItems: 'center', justifyContent: 'center' },
  micButton: { width: 82, height: 82, borderRadius: 41, backgroundColor: C.purple, alignItems: 'center', justifyContent: 'center', shadowColor: C.purpleDark, shadowOffset: { width: 0, height: 5 }, shadowOpacity: 0.2, shadowRadius: 10, elevation: 5 },
  micButtonRecording: { backgroundColor: C.pink },
  statusSlot: { minHeight: 44, width: '100%', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  statusText: { fontSize: 12, lineHeight: 18, color: C.sub, textAlign: 'center', fontWeight: '600' },
  errorText: { color: C.red },
  submitButton: { height: 48, borderRadius: 24, backgroundColor: C.purple, marginTop: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  submitText: { fontSize: 14, color: '#fff', fontWeight: '800' },
  buttonDisabled: { opacity: 0.42 },
  centerState: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  stateTitle: { fontSize: 16, color: C.text, fontWeight: '800' },
});
