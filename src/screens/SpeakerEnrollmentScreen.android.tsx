import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, StyleSheet, ToastAndroid, View } from 'react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import { requestRecordingPermissionsAsync, setAudioModeAsync } from 'expo-audio';
import {
  LaojiSpeakerView,
  type NativeSpeakerAction,
  type SpeakerEnrollmentPhase,
} from 'laoji-native-platform';
import { ScreenContainer } from '../components/ScreenContainer';
import { useAppDialog } from '../components/AppDialog';
import { readableErrorMessage } from '../services/errors';
import {
  deleteLocalWavRecording,
  startLocalWavRecording,
  type LocalWavRecordingSession,
  type RealtimeAsrAudioStats,
} from '../services/realtimeAsr';
import {
  deleteSpeaker,
  fetchLatestSpeakerReprocess,
  fetchDeviceSpeakerProfiles,
  fetchSpeakerReprocess,
  fetchSpeakers,
  registerSpeaker,
  registerDeviceSpeaker,
  renameSpeaker,
  renameDeviceSpeaker,
  retrySpeakerReprocess,
  startSpeakerReprocess,
  supplementSpeaker,
  supplementDeviceSpeaker,
  deleteDeviceSpeakerProfile,
  type SpeakerProfile,
  type SpeakerReprocessJob,
} from '../services/speakers';
import { useAuth } from '../store/AuthStore';
import type { RootStackParamList } from '../types';
import { meetingAudioLevelPercent } from '../utils/meetingAudioStatus';
import { buildNativeSpeakerEnrollmentSnapshot } from '../native/nativeSpeakerSnapshots';
import { secureClientIdFactory } from '../domain/meeting';
import { Colors as C } from '../theme/colors';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'SpeakerEnrollment'>;
  route: RouteProp<RootStackParamList, 'SpeakerEnrollment'>;
};

const MIN_RECORDING_MS = 2_000;
const MAX_RECORDING_MS = 15_000;

// MIN-SPEAKER-001 / MIN-AUDIO-001: native AudioRecord owns samples; TS coordinates CRUD only.
export function SpeakerEnrollmentScreen({ navigation, route }: Props) {
  const speakerId = route.params?.speakerId;
  const { accessToken, isGuest } = useAuth();
  const deviceMode = isGuest || !accessToken;
  const { showDialog } = useAppDialog();
  const [speaker, setSpeaker] = useState<SpeakerProfile | null>(null);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(Boolean(speakerId));
  const [loadError, setLoadError] = useState('');
  const [enrollmentPhase, setEnrollmentPhase] = useState<SpeakerEnrollmentPhase>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [level, setLevel] = useState(0);
  const [audioUri, setAudioUri] = useState('');
  const [fileName, setFileName] = useState('voice.wav');
  const [error, setError] = useState('');
  const [voiceprintConsentAccepted, setVoiceprintConsentAccepted] = useState(false);
  const [reprocessJob, setReprocessJob] = useState<SpeakerReprocessJob | null>(null);
  const [reprocessBusy, setReprocessBusy] = useState(false);
  const sessionRef = useRef<LocalWavRecordingSession | null>(null);
  const stopPromiseRef = useRef<Promise<void> | null>(null);
  const startedAtRef = useRef(0);
  const audioUriRef = useRef('');
  const mountedRef = useRef(true);
  const uploadRef = useRef(false);

  const discard = useCallback(async (uri?: string) => {
    await deleteLocalWavRecording(uri).catch(() => {});
  }, []);

  const restoreAudioMode = useCallback(async () => {
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    if (!speakerId) return;
    setLoading(true);
    setLoadError('');
    try {
      const profiles = deviceMode
        ? await fetchDeviceSpeakerProfiles()
        : await fetchSpeakers(accessToken!);
      const found = profiles.find(item => item.speaker_id === speakerId);
      if (!found) throw new Error('讲话人不存在或已被删除');
      const latestReprocess = deviceMode
        ? null
        : await fetchLatestSpeakerReprocess(speakerId, accessToken!).catch(() => null);
      if (!mountedRef.current) return;
      setSpeaker(found);
      setName(found.name);
      setReprocessJob(latestReprocess);
    } catch (reason) {
      if (mountedRef.current) setLoadError(readableErrorMessage(reason, '讲话人暂时无法加载。'));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [accessToken, deviceMode, speakerId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (
      !speakerId || !accessToken || !reprocessJob
      || (reprocessJob.status !== 'queued' && reprocessJob.status !== 'running')
    ) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const next = await fetchSpeakerReprocess(speakerId, reprocessJob.job_id, accessToken);
        if (cancelled || !mountedRef.current) return;
        setReprocessJob(previous => {
          if (
            previous
            && previous.job_id === next.job_id
            && previous.status !== 'completed'
            && next.status === 'completed'
          ) {
            ToastAndroid.show(
              next.matched_segments > 0
                ? `已重新匹配 ${next.matched_segments} 段发言`
                : '旧会议匹配已完成',
              ToastAndroid.SHORT,
            );
          }
          return next;
        });
        if (next.status === 'queued' || next.status === 'running') {
          timer = setTimeout(() => { void poll(); }, 1_000);
        }
      } catch (reason) {
        if (!cancelled && mountedRef.current) {
          setError(readableErrorMessage(reason, '重新匹配进度暂时无法更新。'));
        }
      }
    };
    timer = setTimeout(() => { void poll(); }, 600);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [accessToken, reprocessJob?.job_id, reprocessJob?.status, speakerId]);

  const stopRecording = useCallback((): Promise<void> => {
    if (stopPromiseRef.current) return stopPromiseRef.current;
    const session = sessionRef.current;
    if (!session) return Promise.resolve();
    setEnrollmentPhase('stopping');
    const operation = (async () => {
      try {
        const uri = await session.stop();
        if (!mountedRef.current) {
          await discard(uri);
          return;
        }
        audioUriRef.current = uri;
        setAudioUri(uri);
        setFileName(session.fileName);
        const duration = Math.min(MAX_RECORDING_MS, Date.now() - startedAtRef.current);
        setElapsedMs(duration);
        if (duration < MIN_RECORDING_MS) {
          setError('录音不足 2 秒，请重新录制。');
          setEnrollmentPhase('error');
        } else {
          setEnrollmentPhase('ready');
        }
      } catch (reason) {
        if (mountedRef.current) {
          setError(readableErrorMessage(reason, '录音没有正确保存，请重新录制。'));
          setEnrollmentPhase('error');
        }
      } finally {
        sessionRef.current = null;
        await restoreAudioMode();
      }
    })().finally(() => { stopPromiseRef.current = null; });
    stopPromiseRef.current = operation;
    return operation;
  }, [discard, restoreAudioMode]);

  useEffect(() => {
    if (enrollmentPhase !== 'recording') return;
    const timer = setInterval(() => {
      const next = Date.now() - startedAtRef.current;
      setElapsedMs(Math.min(MAX_RECORDING_MS, next));
      if (next >= MAX_RECORDING_MS) void stopRecording();
    }, 100);
    return () => clearInterval(timer);
  }, [enrollmentPhase, stopRecording]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active' && sessionRef.current) void stopRecording();
    });
    return () => subscription.remove();
  }, [stopRecording]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const active = sessionRef.current;
      sessionRef.current = null;
      if (active) void active.stop().then(discard).catch(() => {}).finally(() => { void restoreAudioMode(); });
      if (!uploadRef.current) {
        const uri = audioUriRef.current;
        audioUriRef.current = '';
        void discard(uri);
      }
    };
  }, [discard, restoreAudioMode]);

  const startRecording = useCallback(async () => {
    if (sessionRef.current || enrollmentPhase === 'preparing' || enrollmentPhase === 'saving') return;
    setEnrollmentPhase('preparing');
    setError('');
    const prior = audioUriRef.current;
    audioUriRef.current = '';
    setAudioUri('');
    setElapsedMs(0);
    setLevel(0);
    void discard(prior);
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        showDialog({ title: '无法录制音色', message: '请在系统设置中允许老记使用麦克风。', tone: 'warning' });
        setEnrollmentPhase('idle');
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      const session = await startLocalWavRecording(`speaker-${Date.now()}`, (stats: RealtimeAsrAudioStats) => {
        if (mountedRef.current) setLevel(meetingAudioLevelPercent(stats.raw.rms) / 100);
      });
      if (!mountedRef.current || AppState.currentState !== 'active') {
        await session.stop().then(discard).catch(() => {});
        await restoreAudioMode();
        return;
      }
      sessionRef.current = session;
      startedAtRef.current = Date.now();
      setEnrollmentPhase('recording');
    } catch (reason) {
      setError(readableErrorMessage(reason, '启动录音失败，请稍后重试。'));
      setEnrollmentPhase('error');
      await restoreAudioMode();
    }
  }, [discard, enrollmentPhase, restoreAudioMode, showDialog]);

  const submit = useCallback(async () => {
    if (!audioUri || elapsedMs < MIN_RECORDING_MS || uploadRef.current) return;
    if (!voiceprintConsentAccepted) {
      showDialog({
        title: '请先确认声纹用途',
        message: '需要明确同意后，才能上传本次录音并建立或补充讲话人声纹。',
        tone: 'warning',
      });
      return;
    }
    if (!speakerId && !name.trim()) {
      setError('请先填写讲话人名称。');
      return;
    }
    uploadRef.current = true;
    setEnrollmentPhase('saving');
    setError('');
    try {
      const result = speakerId
        ? deviceMode
          ? await supplementDeviceSpeaker(speakerId, audioUri, fileName)
          : await supplementSpeaker(speakerId, audioUri, fileName, accessToken!)
        : deviceMode
          ? await registerDeviceSpeaker(name, audioUri, fileName)
          : await registerSpeaker(name, audioUri, fileName, accessToken!);
      await discard(audioUri);
      audioUriRef.current = '';
      if (!mountedRef.current) return;
      setAudioUri('');
      showDialog({
        title: '声纹采集成功',
        message: speakerId
          ? `已为“${result.speaker.name}”补充声纹。`
          : `已建立“${result.speaker.name}”。`,
        tone: 'success',
        actions: [{ text: '完成', role: 'primary', onPress: () => navigation.goBack() }],
      });
      setEnrollmentPhase('ready');
    } catch (reason) {
      setError(readableErrorMessage(reason, '音色保存失败，请重新录制后再试。'));
      setEnrollmentPhase('error');
    } finally {
      uploadRef.current = false;
    }
  }, [accessToken, audioUri, deviceMode, discard, elapsedMs, fileName, name, navigation, showDialog, speakerId, voiceprintConsentAccepted]);

  const saveName = useCallback(async (nextName: string) => {
    if (!speaker || !speakerId || !nextName.trim() || nextName.trim() === speaker.name) return;
    setEnrollmentPhase('saving');
    setError('');
    try {
      const result = deviceMode
        ? await renameDeviceSpeaker(speakerId, nextName)
        : await renameSpeaker(speakerId, nextName, accessToken!);
      setSpeaker(result.speaker);
      setName(result.speaker.name);
      setEnrollmentPhase(audioUri ? 'ready' : 'idle');
    } catch (reason) {
      setError(readableErrorMessage(reason, '名称保存失败，请稍后重试。'));
      setEnrollmentPhase('error');
    }
  }, [accessToken, audioUri, deviceMode, speaker, speakerId]);

  const runReprocess = useCallback(() => {
    if (deviceMode || !speakerId || !accessToken || reprocessBusy) return;
    const retryable = reprocessJob?.status === 'failed' && reprocessJob.retryable;
    showDialog({
      title: retryable ? '重试旧会议匹配' : '重新匹配旧会议',
      message: '只更新未手动确认的讲话人；已有人工修改会保留。',
      tone: 'info',
      actions: [
        {
          text: retryable ? '重试' : '开始',
          role: 'primary',
          onPress: async () => {
            setReprocessBusy(true);
            setError('');
            try {
              const next = retryable && reprocessJob
                ? await retrySpeakerReprocess(speakerId, reprocessJob.job_id, accessToken)
                : await startSpeakerReprocess(
                  speakerId,
                  secureClientIdFactory.create(),
                  accessToken,
                );
              if (mountedRef.current) setReprocessJob(next);
            } catch (reason) {
              if (mountedRef.current) {
                setError(readableErrorMessage(reason, '旧会议暂时无法重新匹配。'));
              }
            } finally {
              if (mountedRef.current) setReprocessBusy(false);
            }
          },
        },
        { text: '取消', role: 'cancel' },
      ],
    });
  }, [accessToken, deviceMode, reprocessBusy, reprocessJob, showDialog, speakerId]);

  const confirmDelete = useCallback(() => {
    if (!speakerId || enrollmentPhase === 'recording' || enrollmentPhase === 'saving') return;
    showDialog({
      title: '删除讲话人',
      message: `删除“${speaker?.name ?? name}”后，后续会议将不再使用这份音色。`,
      tone: 'danger',
      actions: [
        {
          text: '删除',
          role: 'destructive',
          onPress: async () => {
            setEnrollmentPhase('saving');
            try {
              if (deviceMode) await deleteDeviceSpeakerProfile(speakerId);
              else await deleteSpeaker(speakerId, accessToken!);
              navigation.goBack();
            } catch (reason) {
              setError(readableErrorMessage(reason, '删除失败，请稍后重试。'));
              setEnrollmentPhase('error');
            }
          },
        },
        { text: '取消', role: 'cancel' },
      ],
    });
  }, [accessToken, deviceMode, enrollmentPhase, name, navigation, showDialog, speaker?.name, speakerId]);

  const contentPhase = speakerId && loading ? 'loading'
      : speakerId && !speaker ? 'error'
        : 'ready';
  const snapshot = useMemo(() => buildNativeSpeakerEnrollmentSnapshot({
    guest: false,
    speakerId,
    title: speakerId ? '讲话人详情' : '声纹采集',
    phase: contentPhase,
    message: loadError,
    name,
    nameEditable: enrollmentPhase !== 'recording' && enrollmentPhase !== 'saving',
    nameSaveEnabled: Boolean(speaker && name.trim() && name.trim() !== speaker.name && enrollmentPhase !== 'saving'),
    enrollmentPhase,
    elapsedMs,
    maxDurationMs: MAX_RECORDING_MS,
    level,
    errorMessage: error,
    canDelete: Boolean(speakerId && speaker),
    canRecord: !loading && enrollmentPhase !== 'preparing' && enrollmentPhase !== 'saving',
    canSubmit: Boolean(audioUri && elapsedMs >= MIN_RECORDING_MS && enrollmentPhase === 'ready'),
    voiceprintConsentAccepted,
    reprocessPhase: reprocessJob?.status ?? 'idle',
    reprocessMessage: reprocessJob?.status === 'queued'
      ? '等待重新匹配'
      : reprocessJob?.status === 'running'
        ? '正在重新匹配'
        : reprocessJob?.status === 'failed' && reprocessJob.retryable
          ? '重试旧会议匹配'
          : reprocessJob?.status === 'failed'
            ? '旧会议匹配不可用'
            : '重新匹配旧会议',
    canReprocess: Boolean(
      !deviceMode
      && speakerId
      && speaker
      && !reprocessBusy
      && reprocessJob?.status !== 'queued'
      && reprocessJob?.status !== 'running'
      && (reprocessJob?.status !== 'failed' || reprocessJob.retryable)
      && enrollmentPhase !== 'recording'
      && enrollmentPhase !== 'saving'
    ),
  }), [accessToken, audioUri, contentPhase, deviceMode, elapsedMs, enrollmentPhase, error, level, loadError, loading, name, reprocessBusy, reprocessJob, speaker, speakerId, voiceprintConsentAccepted]);

  const handleAction = useCallback((action: NativeSpeakerAction) => {
    switch (action.type) {
      case 'back':
        navigation.goBack();
        break;
      case 'login':
        void load();
        break;
      case 'retry':
        void load();
        break;
      case 'nameChange':
        setName(action.name);
        break;
      case 'saveName':
        void saveName(action.name);
        break;
      case 'delete':
        confirmDelete();
        break;
      case 'startRecording':
      case 'retake':
        void startRecording();
        break;
      case 'stopRecording':
        void stopRecording();
        break;
      case 'submitRecording':
        void submit();
        break;
      case 'toggleVoiceprintConsent':
        setVoiceprintConsentAccepted(value => !value);
        break;
      case 'reprocess':
        runReprocess();
        break;
      default:
        break;
    }
  }, [confirmDelete, load, navigation, runReprocess, saveName, startRecording, stopRecording, submit]);

  return (
    <ScreenContainer edges={['top', 'bottom']} bg={C.appBg}>
      <View
        style={styles.root}
        testID="speaker-enrollment-native-root"
        collapsable={false}
        collapsableChildren={false}
      >
        <LaojiSpeakerView
          style={styles.surface}
          surface="enrollment"
          snapshot={snapshot}
          onSpeakerAction={event => handleAction(event.nativeEvent)}
          testID="speaker-enrollment-native-surface"
        />
      </View>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  surface: { flex: 1 },
});
