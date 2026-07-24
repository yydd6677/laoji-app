import React, { useCallback, useState, useEffect, useMemo, useRef } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  PanResponder,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { Colors as C } from '../theme/colors';
import { ScreenContainer } from '../components/ScreenContainer';

import { RootStackParamList, TranscriptLine } from '../types';
import { MeetingDeletionCleanupError, useMeetings } from '../store/MeetingsStore';
import { fetchMeetingTranscriptSnapshot, fetchMeetingSummaryDetail, uploadMeetingAudio } from '../services/api';
import {
  canAutomaticallyRetryPendingMeetingAudioUpload,
  getPendingMeetingAudioUpload,
  PendingMeetingAudioUpload,
  retryPendingMeetingAudioUpload,
} from '../services/meetingRecording';
import {
  generateSummaryForMeeting,
  meetingDateForSummary,
  meetingSummaryProgressLabel,
  meetingSummaryToText,
  normalizeMeetingSummaryResult,
  shouldDiscardPendingMeetingSummaryTask,
} from '../services/meetingSummary';
import {
  clearPendingMeetingSummaryTask,
  getPendingMeetingSummaryTask,
  meetingSummaryInputFingerprint,
  PendingMeetingSummaryTask,
  savePendingMeetingSummaryTask,
} from '../services/meetingSummaryTasks';
import {
  meetingShareErrorMessage,
  shareMeetingContent,
  type MeetingShareAvailability,
  type MeetingShareSelection,
} from '../services/meetingShare';
import { useAppDialog } from '../components/AppDialog';
import { useAuth } from '../store/AuthStore';
import { readableErrorMessage } from '../services/errors';
import { meetingDeletionPresentation } from '../services/meetingDeletionPresentation';
import { MinutesDetailTitleBar } from '../components/MinutesDetailTitleBar';
import { AppActionSheet } from '../components/AppActionSheet';
import { MeetingAudioPlayerDock } from '../components/MeetingAudioPlayerDock';
import { MeetingSummaryContent } from '../components/MeetingSummaryContent';
import { MeetingShareSheet } from '../components/MeetingShareSheet';
import { MeetingTemplateSheet } from '../components/MeetingTemplateSheet';
import { MeetingSummaryCarryForwardSheet } from '../components/MeetingSummaryCarryForwardSheet';
import { openMeetingsTab } from '../navigation/tabTargets';
import {
  meetingRemoteIdentity,
  requireMeetingRemoteIdentity,
  transcriptDurationSec,
} from '../utils/meetingMedia';
import { speakerDisplayLabel } from '../utils/speakerLabels';
import { displayMeetingTitle } from '../utils/meetingTitle';
import { evaluateTranscriptLineCandidate } from '../services/transcriptCompleteness';
import { meetingSummaryDocumentForLegacy } from '../services/meetingSummaryDocument';
import {
  DEFAULT_MEETING_TEMPLATE,
  meetingTemplateById,
  type MeetingSummaryCarryForwardAuthorization,
  type MeetingTemplate,
  type ScopeKey,
} from '../domain/meeting';
import {
  authorizeMeetingSummaryCarryForward,
  resolveMeetingSummaryCarryForwardMemory,
} from '../services/meetingSummaryCarryForward';
import type { MeetingSeriesMemoryProjection } from '../services/meetingSeriesMemory';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Transcription'>;
  route: RouteProp<RootStackParamList, 'Transcription'>;
};

function transcriptTimestamp(seconds?: number): string {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds ?? 0) : 0;
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = Math.floor(safeSeconds % 60);
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

const MEETING_DETAIL_TAB_GEOMETRY = Object.freeze({
  startInset: 10,
  transcriptWidth: 76,
  summaryWidth: 60,
  transcriptIndicatorLeft: 20,
  summaryIndicatorLeft: 102,
  transcriptIndicatorWidth: 56,
  summaryIndicatorWidth: 28,
});

const SPEAKER_AVATAR_TONES = [
  { backgroundColor: '#E8F3FF', foregroundColor: '#3370FF' },
  { backgroundColor: '#E4F7ED', foregroundColor: '#20A162' },
  { backgroundColor: '#F0EBFF', foregroundColor: '#7F5AF0' },
  { backgroundColor: '#FFF0E2', foregroundColor: '#F07C2B' },
  { backgroundColor: '#E1F6F5', foregroundColor: '#169C96' },
  { backgroundColor: '#FDEAF2', foregroundColor: '#D64F82' },
] as const;

function speakerAvatarTone(line: TranscriptLine) {
  const key = line.speaker_id || line.speaker_label || 'unknown';
  let hash = 0;
  for (let position = 0; position < key.length; position += 1) {
    hash = ((hash * 31) + key.charCodeAt(position)) >>> 0;
  }
  return SPEAKER_AVATAR_TONES[hash % SPEAKER_AVATAR_TONES.length];
}

export function TranscriptionScreen({ navigation, route }: Props) {
  const {
    meetings,
    deleteMeeting,
    updateMeetingTitle,
    getCachedTranscript,
    saveCachedTranscript,
    getCachedSummary,
    saveCachedSummary,
    refreshMeetings,
  } = useMeetings();
  const { accessToken, isGuest, session } = useAuth();
  const { showDialog } = useAppDialog();
  const m = meetings.find(x => x.id === route.params.meetingId);
  const remoteMeetingId = m ? meetingRemoteIdentity(m) : null;
  const [titleEdit, setTitleEdit] = useState(m?.title ?? '');
  const [transcriptItems, setTranscriptItems] = useState<TranscriptLine[]>([]);
  const [summary, setSummary] = useState('');
  const [summaryTemplate, setSummaryTemplate] = useState<MeetingTemplate>(() => {
    const cached = m ? meetingSummaryDocumentForLegacy(m.id, getCachedSummary(m.id) ?? {}) : null;
    return meetingTemplateById(cached?.templateId, cached?.templateRevision) ?? DEFAULT_MEETING_TEMPLATE;
  });
  const [templateSheetVisible, setTemplateSheetVisible] = useState(false);
  const [summaryCarryForwardRequest, setSummaryCarryForwardRequest] = useState<{
    meetingId: string;
    scopeKey: ScopeKey;
    template: MeetingTemplate;
    forceRegenerate: boolean;
    memory: MeetingSeriesMemoryProjection;
  } | null>(null);
  const [loadingTranscript, setLoadingTranscript] = useState(false);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [activeTab, setActiveTab] = useState<'transcript' | 'summary'>(
    route.params.focus === 'summary' ? 'summary' : 'transcript',
  );
  const [transcriptError, setTranscriptError] = useState('');
  const [summaryError, setSummaryError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [summaryProgress, setSummaryProgress] = useState('正在提交总结任务');
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleSaving, setTitleSaving] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [shareVisible, setShareVisible] = useState(false);
  const [moreVisible, setMoreVisible] = useState(false);
  const [pendingAudioUpload, setPendingAudioUpload] = useState<PendingMeetingAudioUpload | null>(null);
  const [pendingAudioError, setPendingAudioError] = useState('');
  const [retryingAudioUpload, setRetryingAudioUpload] = useState(false);
  const summaryAbortRef = useRef<AbortController | null>(null);
  const silentSummaryAbortRef = useRef(new WeakSet<AbortController>());
  const summaryStorageScopeRef = useRef<string | null>(null);
  const summaryInFlightRef = useRef<Promise<void> | null>(null);
  const audioUploadUiPromiseRef = useRef<Promise<void> | null>(null);
  const automaticAudioUploadKeyRef = useRef('');
  const autoResumeTaskRef = useRef('');
  const summaryCarryLookupGenerationRef = useRef(0);
  const activeMeetingIdRef = useRef(m?.id ?? null);
  const activeMeetingScopeRef = useRef<ScopeKey | null>(null);
  const mountedRef = useRef(true);
  const titleInputRef = useRef<TextInput | null>(null);
  const titleFocusHandledRef = useRef(false);
  const activeTabRef = useRef(activeTab);
  const tabDirectionRef = useRef<1 | -1>(1);
  const tabPageProgress = useRef(new Animated.Value(1)).current;
  const tabIndicatorPosition = useRef(new Animated.Value(activeTab === 'summary' ? 1 : 0)).current;
  const recordingStorageScope = isGuest ? 'guest' : session ? `user:${session.user.id}` : 'signed_out';
  const meetingScopeKey: ScopeKey | null = isGuest
    ? 'guest'
    : session
      ? `user:${session.user.id}`
      : null;
  activeMeetingIdRef.current = m?.id ?? null;
  activeMeetingScopeRef.current = meetingScopeKey;
  const focusTitleInput = useCallback(() => {
    setTimeout(() => titleInputRef.current?.focus?.(), 0);
  }, []);

  const selectDetailTab = useCallback((next: 'transcript' | 'summary') => {
    const current = activeTabRef.current;
    if (current === next) return;
    tabDirectionRef.current = next === 'summary' ? 1 : -1;
    activeTabRef.current = next;
    tabPageProgress.stopAnimation();
    tabPageProgress.setValue(0);
    setActiveTab(next);
    Animated.parallel([
      Animated.timing(tabPageProgress, {
        toValue: 1,
        duration: 180,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }),
      Animated.timing(tabIndicatorPosition, {
        toValue: next === 'summary' ? 1 : 0,
        duration: 300,
        easing: Easing.out(Easing.ease),
        useNativeDriver: false,
      }),
    ]).start();
  }, [tabIndicatorPosition, tabPageProgress]);

  const detailPagerPanResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_event, gesture) => (
      Math.abs(gesture.dx) > 16
      && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.35
    ),
    onPanResponderRelease: (_event, gesture) => {
      if (gesture.dx < -48) selectDetailTab('summary');
      if (gesture.dx > 48) selectDetailTab('transcript');
    },
  }), [selectDetailTab]);

  const performPendingAudioUpload = useCallback((
    pending: PendingMeetingAudioUpload,
    notifyUser: boolean,
  ): Promise<void> => {
    if (!accessToken) return Promise.resolve();
    if (audioUploadUiPromiseRef.current) return audioUploadUiPromiseRef.current;
    setRetryingAudioUpload(true);
    setPendingAudioError('');
    let operation: Promise<void> | null = null;
    operation = (async () => {
      try {
        const uploaded = await retryPendingMeetingAudioUpload(
          recordingStorageScope,
          pending.meetingId,
          accessToken,
          (item, token) => uploadMeetingAudio(
            item.remoteMeetingId ?? item.meetingId,
            item.audioUri,
            token,
            { fileName: item.fileName, mimeType: item.mimeType },
          ),
          { automatic: !notifyUser },
        );
        const stillPending = uploaded
          ? null
          : await getPendingMeetingAudioUpload(recordingStorageScope, pending.meetingId);
        if (mountedRef.current) {
          setPendingAudioUpload(stillPending);
          setPendingAudioError(stillPending?.failureMessage
            ? readableErrorMessage(stillPending.failureMessage, '自动同步未完成，录音仍保存在本机')
            : '');
        }
        if (uploaded) await refreshMeetings();
        if (uploaded && notifyUser && mountedRef.current) {
          showDialog({ title: '上传完成', message: '本机录音已同步到会议服务。', tone: 'success' });
        }
      } catch {
        try {
          const stillPending = await getPendingMeetingAudioUpload(recordingStorageScope, pending.meetingId);
          if (mountedRef.current) {
            setPendingAudioUpload(stillPending);
            setPendingAudioError(readableErrorMessage(
              stillPending?.failureMessage,
              '自动同步未完成，录音仍保存在本机',
            ));
          }
        } catch {
          if (mountedRef.current) {
            setPendingAudioUpload(null);
            setPendingAudioError('无法读取录音待上传状态，请重试。');
          }
        }
        if (notifyUser && mountedRef.current) {
          const latest = await getPendingMeetingAudioUpload(recordingStorageScope, pending.meetingId).catch(() => null);
          showDialog({
            title: latest?.uploadState === 'blocked' ? '录音上传受阻' : '上传失败',
            message: readableErrorMessage(
              latest?.failureMessage,
              '录音仍保存在本机，可稍后再次重试。',
            ),
            tone: 'error',
          });
        }
      } finally {
        if (mountedRef.current) setRetryingAudioUpload(false);
        if (audioUploadUiPromiseRef.current === operation) audioUploadUiPromiseRef.current = null;
      }
    })();
    audioUploadUiPromiseRef.current = operation;
    return operation;
  }, [accessToken, recordingStorageScope, refreshMeetings, showDialog]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      summaryAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    const previousScope = summaryStorageScopeRef.current;
    summaryStorageScopeRef.current = recordingStorageScope;
    if (previousScope == null || previousScope === recordingStorageScope) return;
    const controller = summaryAbortRef.current;
    if (!controller) return;
    silentSummaryAbortRef.current.add(controller);
    controller.abort();
  }, [recordingStorageScope]);

  useEffect(() => {
    if (m && !titleEditing) setTitleEdit(m.title);
  }, [m?.id, m?.title, titleEditing]);

  useEffect(() => {
    if (!m) return;
    let alive = true;
    const cachedTranscript = getCachedTranscript(m.id);
    const cachedSummaryValue = getCachedSummary(m.id);
    const cachedSummary = meetingSummaryToText(cachedSummaryValue);
    const cachedDocument = cachedSummaryValue
      ? meetingSummaryDocumentForLegacy(m.id, cachedSummaryValue)
      : null;
    setTranscriptItems(cachedTranscript);
    setSummary(cachedSummary);
    setSummaryTemplate(
      meetingTemplateById(cachedDocument?.templateId, cachedDocument?.templateRevision)
        ?? DEFAULT_MEETING_TEMPLATE,
    );
    setTemplateSheetVisible(false);
    setTranscriptError('');
    setSummaryError('');

    setLoadingTranscript(true);
    if (isGuest || !accessToken) {
      setLoadingTranscript(false);
    } else if (remoteMeetingId) {
      fetchMeetingTranscriptSnapshot(remoteMeetingId, accessToken)
        .then(async remote => {
          if (!alive) return;
          const candidateKind = remote.completeness === 'incomplete' ? 'realtime_draft' : 'final';
          const decision = evaluateTranscriptLineCandidate(cachedTranscript, remote.items, {
            candidateKind,
            serverCompleteness: remote.completeness,
          });
          setTranscriptItems(decision.useCandidate ? remote.items : cachedTranscript);
          await saveCachedTranscript(m.id, remote.items, {
            candidateKind,
            serverCompleteness: remote.completeness,
          });
        })
        .catch(() => { if (alive) setTranscriptError('转写同步失败，当前显示本机缓存。'); })
        .finally(() => { if (alive) setLoadingTranscript(false); });
    } else {
      setLoadingTranscript(false);
      setTranscriptError('会议正在同步，当前显示本机缓存。');
    }

    if (m.hasSummary && !isGuest && accessToken && remoteMeetingId) {
      setLoadingSummary(true);
      setSummaryProgress('正在同步总结');
      fetchMeetingSummaryDetail(remoteMeetingId, accessToken)
        .then(value => {
          if (!alive) return;
          const normalized = normalizeMeetingSummaryResult(m.id, value);
          const text = meetingSummaryToText(normalized);
          setSummary(text || cachedSummary);
          const document = normalized?.structured_document;
          const template = meetingTemplateById(document?.templateId, document?.templateRevision);
          if (template) setSummaryTemplate(template);
          if (normalized && text) {
            void saveCachedSummary(m.id, normalized).catch(() => {
              if (alive) setSummaryError('总结已同步，但本机缓存写入失败。');
            });
          }
        })
        .catch(() => { if (alive) setSummaryError('总结同步失败，可重试或重新生成。'); })
        .finally(() => { if (alive) setLoadingSummary(false); });
    } else if (m.hasSummary && !isGuest && accessToken) {
      setSummaryError('会议正在同步，当前显示本机缓存。');
    }
    return () => { alive = false; };
  }, [
    accessToken,
    getCachedSummary,
    getCachedTranscript,
    isGuest,
    m?.hasSummary,
    m?.id,
    remoteMeetingId,
    reloadKey,
    saveCachedSummary,
    saveCachedTranscript,
  ]);

  useEffect(() => {
    let alive = true;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    if (!m || isGuest) {
      setPendingAudioUpload(null);
      setPendingAudioError('');
      return () => { alive = false; };
    }
    setPendingAudioError('');
    void getPendingMeetingAudioUpload(recordingStorageScope, m.id).then(pending => {
      if (!alive) return;
      setPendingAudioUpload(pending);
      setPendingAudioError(pending?.failureMessage
        ? readableErrorMessage(pending.failureMessage, '自动同步未完成，录音仍保存在本机')
        : '');
      if (pending && accessToken) {
        const automaticKey = `${recordingStorageScope}:${pending.meetingId}:${pending.attemptCount}:${pending.nextAttemptAt ?? ''}`;
        if (automaticAudioUploadKeyRef.current !== automaticKey) {
          automaticAudioUploadKeyRef.current = automaticKey;
          if (canAutomaticallyRetryPendingMeetingAudioUpload(pending)) {
            void performPendingAudioUpload(pending, false);
          } else if (pending.uploadState !== 'blocked' && pending.nextAttemptAt) {
            const retryAt = Date.parse(pending.nextAttemptAt);
            if (!Number.isNaN(retryAt)) {
              retryTimer = setTimeout(
                () => setReloadKey(value => value + 1),
                Math.max(0, retryAt - Date.now()),
              );
            }
          }
        }
      }
    }).catch(() => {
      if (alive) {
        setPendingAudioUpload(null);
        setPendingAudioError('无法读取录音待上传状态，请重试。');
      }
    });
    return () => {
      alive = false;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [accessToken, isGuest, m?.id, performPendingAudioUpload, recordingStorageScope, reloadKey]);

  useEffect(() => {
    autoResumeTaskRef.current = '';
  }, [m?.id, recordingStorageScope]);

  useEffect(() => {
    summaryCarryLookupGenerationRef.current += 1;
    setSummaryCarryForwardRequest(null);
  }, [m?.id, meetingScopeKey]);

  function runSummaryTask(options: {
    automatic?: boolean;
    forceRegenerate?: boolean;
    resumeTask?: PendingMeetingSummaryTask | null;
    transcriptLines?: TranscriptLine[];
    template?: MeetingTemplate;
    carryForward?: MeetingSummaryCarryForwardAuthorization | null;
  } = {}): Promise<void> {
    if (!m) return Promise.resolve();
    if (summaryInFlightRef.current) return summaryInFlightRef.current;
    const currentMeeting = m;
    const lines = options.transcriptLines ?? transcriptItems;
    if (lines.length === 0) {
      if (!options.automatic) {
        showDialog({ title: '暂无转写', message: '需要先有会议转写内容，才能生成总结。', tone: 'info' });
      }
      return Promise.resolve();
    }

    const meetingDate = meetingDateForSummary(currentMeeting.date, currentMeeting.createdAt);
    const resumedTemplate = options.resumeTask
      ? meetingTemplateById(options.resumeTask.templateId, options.resumeTask.templateRevision)
      : null;
    const requestedTemplate = options.template ?? resumedTemplate ?? summaryTemplate;
    const hasExplicitCarryForward = Object.prototype.hasOwnProperty.call(options, 'carryForward');
    const requestedCarryForward = options.resumeTask
      ? options.resumeTask.carryForward
      : hasExplicitCarryForward
        ? options.carryForward ?? null
        : null;
    const expectedMode = isGuest ? 'guest' : 'authenticated';
    let operation: Promise<void> | null = null;
    operation = (async () => {
      setLoadingSummary(true);
      setSummaryError('');
      setSummaryProgress('正在检查上次总结任务');
      const controller = new AbortController();
      summaryAbortRef.current?.abort();
      summaryAbortRef.current = controller;
      try {
        let pending = options.resumeTask ?? null;
        if (options.forceRegenerate) {
          pending = null;
        } else if (options.resumeTask === undefined) {
          try {
            pending = await getPendingMeetingSummaryTask(recordingStorageScope, currentMeeting.id);
          } catch {
            throw new Error('无法读取上次总结任务，未提交新任务。请检查本机存储后重试。');
          }
        }
        let carryForward = options.resumeTask
          ? options.resumeTask.carryForward
          : hasExplicitCarryForward
            ? options.carryForward ?? null
            : pending?.carryForward ?? null;
        let inputFingerprint = meetingSummaryInputFingerprint(
          lines,
          currentMeeting.title,
          meetingDate,
          requestedTemplate,
          carryForward,
        );
        if (pending && (
          pending.mode !== expectedMode
          || pending.templateId !== requestedTemplate.id
          || pending.templateRevision !== requestedTemplate.revision
          || pending.inputFingerprint !== inputFingerprint
        )) {
          await clearPendingMeetingSummaryTask(recordingStorageScope, currentMeeting.id).catch(() => {});
          pending = null;
          carryForward = requestedCarryForward;
          inputFingerprint = meetingSummaryInputFingerprint(
            lines,
            currentMeeting.title,
            meetingDate,
            requestedTemplate,
            carryForward,
          );
        }
        setSummaryProgress(pending ? '正在恢复上次总结任务' : '正在提交总结任务');
        const generated = await generateSummaryForMeeting({
          meetingId: isGuest
            ? currentMeeting.id
            : requireMeetingRemoteIdentity(currentMeeting),
          title: currentMeeting.title,
          meetingDate,
          transcriptLines: lines,
          template: requestedTemplate,
          carryForward,
          isGuest,
          accessToken,
          resumeTaskId: pending?.taskId,
          forceRegenerate: Boolean(options.forceRegenerate),
          signal: controller.signal,
          onTaskSubmitted: async taskId => {
            try {
              await savePendingMeetingSummaryTask(recordingStorageScope, {
                meetingId: currentMeeting.id,
                taskId,
                mode: expectedMode,
                templateId: requestedTemplate.id,
                templateRevision: requestedTemplate.revision,
                inputFingerprint,
                carryForward,
              });
              autoResumeTaskRef.current = taskId;
            } catch {
              if (mountedRef.current) {
                setSummaryError('任务已提交，但本机无法保存恢复状态，请保持当前页面打开。');
              }
            }
          },
          onProgress: progress => {
            if (mountedRef.current) setSummaryProgress(meetingSummaryProgressLabel(progress));
          },
        });
        const text = meetingSummaryToText(generated);
        if (mountedRef.current) {
          setSummary(text || '暂无总结内容');
          setSummaryError('');
        }

        let cacheSaved = false;
        try {
          await saveCachedSummary(currentMeeting.id, generated);
          cacheSaved = true;
        } catch {
          if (mountedRef.current) {
            setSummaryError('总结已生成，但本机缓存写入失败。');
            showDialog({
              title: '总结已生成，保存失败',
              message: '当前页面仍可查看总结，但退出后可能无法离线恢复。请释放存储空间后重试。',
              tone: 'warning',
            });
          }
        }
        if (cacheSaved || !isGuest) {
          await clearPendingMeetingSummaryTask(recordingStorageScope, currentMeeting.id).catch(() => {});
        }
      } catch (error) {
        if (shouldDiscardPendingMeetingSummaryTask(error)) {
          await clearPendingMeetingSummaryTask(recordingStorageScope, currentMeeting.id).catch(() => {});
        }
        if (!mountedRef.current) return;
        if ((error as Error)?.name === 'AbortError') {
          if (!options.automatic && !silentSummaryAbortRef.current.has(controller)) {
            showDialog({
              title: '已停止等待',
              message: '页面已停止刷新进度；任务会继续在后台生成，再次打开会议即可恢复。',
              tone: 'info',
            });
          }
        } else {
          const fallback = options.automatic
            ? '上次会议总结暂时无法恢复，点击重试可继续获取。'
            : '会议总结暂时无法生成，请稍后重试。';
          const message = readableErrorMessage(error, fallback);
          setSummaryError(message);
          if (!options.automatic) showDialog({ title: '生成失败', message, tone: 'error' });
        }
      } finally {
        if (summaryAbortRef.current === controller) {
          summaryAbortRef.current = null;
          if (mountedRef.current) setLoadingSummary(false);
        }
        if (summaryInFlightRef.current === operation) summaryInFlightRef.current = null;
      }
    })();
    summaryInFlightRef.current = operation;
    return operation;
  }

  function isActiveSummaryCarryLookup(
    generation: number,
    meetingId: string,
    scopeKey: ScopeKey,
  ): boolean {
    return mountedRef.current
      && summaryCarryLookupGenerationRef.current === generation
      && activeMeetingIdRef.current === meetingId
      && activeMeetingScopeRef.current === scopeKey;
  }

  async function prepareSummaryGeneration(template: MeetingTemplate): Promise<void> {
    if (!m) return;
    const currentMeetingId = m.id;
    const currentScopeKey = meetingScopeKey;
    const forceRegenerate = Boolean(summary);
    setSummaryTemplate(template);
    setSummaryCarryForwardRequest(null);

    if (!currentScopeKey) {
      await runSummaryTask({ forceRegenerate, template, carryForward: null });
      return;
    }

    const generation = summaryCarryLookupGenerationRef.current + 1;
    summaryCarryLookupGenerationRef.current = generation;
    try {
      const memory = await resolveMeetingSummaryCarryForwardMemory(currentScopeKey, currentMeetingId);
      if (!isActiveSummaryCarryLookup(generation, currentMeetingId, currentScopeKey)) return;
      if (!memory || (memory.decisions.length === 0 && memory.pendingActions.length === 0)) {
        await runSummaryTask({ forceRegenerate, template, carryForward: null });
        return;
      }
      setSummaryCarryForwardRequest({
        meetingId: currentMeetingId,
        scopeKey: currentScopeKey,
        template,
        forceRegenerate,
        memory,
      });
    } catch {
      if (!isActiveSummaryCarryLookup(generation, currentMeetingId, currentScopeKey)) return;
      showDialog({
        title: '无法读取上次会议内容',
        message: '暂时无法检查可引用的决定和未完成事项。',
        tone: 'warning',
        actions: [
          {
            text: '不引用，继续',
            role: 'primary',
            onPress: () => {
              if (
                activeMeetingIdRef.current === currentMeetingId
                && activeMeetingScopeRef.current === currentScopeKey
              ) {
                void runSummaryTask({ forceRegenerate, template, carryForward: null });
              }
            },
          },
          { text: '取消', role: 'cancel' },
        ],
      });
    }
  }

  useEffect(() => {
    if (!m || loadingTranscript || loadingSummary || summaryInFlightRef.current) return;
    const lines = transcriptItems;
    if (lines.length === 0) return;
    let alive = true;
    const meetingDate = meetingDateForSummary(m.date, m.createdAt);
    const expectedMode = isGuest ? 'guest' : 'authenticated';
    void getPendingMeetingSummaryTask(recordingStorageScope, m.id).then(pending => {
      if (!alive || !pending || autoResumeTaskRef.current === pending.taskId) return;
      const pendingTemplate = meetingTemplateById(pending.templateId, pending.templateRevision);
      const fingerprint = pendingTemplate
        ? meetingSummaryInputFingerprint(
          lines,
          m.title,
          meetingDate,
          pendingTemplate,
          pending.carryForward,
        )
        : '';
      if (
        !pendingTemplate
        || pending.mode !== expectedMode
        || pending.inputFingerprint !== fingerprint
      ) {
        void clearPendingMeetingSummaryTask(recordingStorageScope, m.id).catch(() => {});
        return;
      }
      setSummaryTemplate(pendingTemplate);
      autoResumeTaskRef.current = pending.taskId;
      void runSummaryTask({
        automatic: true,
        resumeTask: pending,
        transcriptLines: lines,
        template: pendingTemplate,
      });
    }).catch(() => {
      if (alive) setSummaryError('无法读取上次总结任务，点击重试可重新生成。');
    });
    return () => { alive = false; };
  }, [
    isGuest,
    loadingSummary,
    loadingTranscript,
    m?.createdAt,
    m?.date,
    m?.id,
    m?.title,
    recordingStorageScope,
    transcriptItems,
  ]);

  useEffect(() => {
    if (route.params.focus === 'summary') selectDetailTab('summary');
    if (route.params.focus === 'transcript') selectDetailTab('transcript');
    if (route.params.focus !== 'title') {
      titleFocusHandledRef.current = false;
      return;
    }
    if (m && !titleFocusHandledRef.current) {
      titleFocusHandledRef.current = true;
      setTitleEdit(m.title);
      setTitleEditing(true);
      focusTitleInput();
    }
  }, [focusTitleInput, m?.id, route.params.focus, selectDetailTab]);

  useEffect(() => {
    setShareVisible(false);
  }, [route.params.meetingId]);

  const shareSummaryDocument = useMemo(() => {
    if (!m) return null;
    const cached = getCachedSummary(m.id);
    return cached ? meetingSummaryDocumentForLegacy(m.id, cached) : null;
  }, [getCachedSummary, m?.id, summary]);
  const shareSummaryText = m
    ? summary || meetingSummaryToText(getCachedSummary(m.id))
    : '';
  const shareActions = useMemo(
    () => shareSummaryDocument?.actionItemCandidates ?? [],
    [shareSummaryDocument],
  );
  const shareAvailability = useMemo<MeetingShareAvailability>(() => ({
    info: Boolean(m),
    summary: shareSummaryDocument
      ? shareSummaryDocument.sections.some(section => (
        section.kind !== 'action_items'
        && section.stableKey !== 'action_items'
        && Boolean(section.title?.trim() || section.content.trim())
      ))
      : Boolean(shareSummaryText.trim()),
    actions: shareActions.some(action => Boolean(action.content.trim())),
    transcript: transcriptItems.some(line => Boolean(line.text.trim())),
    audio: Boolean(m?.audioAvailable || m?.audioLocalUri),
    manualNote: false,
  }), [m?.audioAvailable, m?.audioLocalUri, m?.id, shareActions, shareSummaryDocument, shareSummaryText, transcriptItems]);

  if (!m) {
    return (
      <ScreenContainer edges={['top', 'bottom']}>
        <MinutesDetailTitleBar onBack={() => navigation.goBack()} />
        <View style={s.emptyWrap}>
          <Text style={s.emptyTitle}>会议记录不存在</Text>
          <Text style={s.emptyText}>请返回会议列表后重新打开。</Text>
        </View>
      </ScreenContainer>
    );
  }

  const beginTitleEdit = () => {
    setTitleEdit(m.title);
    setTitleEditing(true);
    focusTitleInput();
  };

  const commitTitle = async () => {
    const t = titleEdit.trim();
    if (titleSaving) return false;
    if (t === m.title) {
      setTitleEditing(false);
      return true;
    }
    setTitleSaving(true);
    try {
      await updateMeetingTitle(m.id, t);
      setTitleEditing(false);
      return true;
    } catch {
      setTitleEdit(m.title);
      setTitleEditing(false);
      showDialog({ title: '保存失败', message: '会议标题更新失败，请稍后重试', tone: 'error' });
      return false;
    } finally {
      setTitleSaving(false);
    }
  };

  const handleRetryAudioUpload = () => {
    if (!pendingAudioUpload || retryingAudioUpload) return;
    void performPendingAudioUpload(pendingAudioUpload, true);
  };

  const handleGenerateSummary = () => setTemplateSheetVisible(true);

  const runMeetingShare = async (selection: MeetingShareSelection) => {
    if (sharing) return;
    setSharing(true);
    try {
      await shareMeetingContent(selection, {
        meeting: m,
        transcriptLines: transcriptItems,
        summaryText: shareSummaryText,
        summaryDocument: shareSummaryDocument,
        actionItems: shareActions,
        summaryVersionId: shareSummaryDocument?.remoteVersionId,
        isGuest,
        accessToken,
      });
    } catch (error) {
      showDialog({ title: '分享失败', message: meetingShareErrorMessage(error), tone: 'error' });
    } finally {
      setSharing(false);
    }
  };

  const openShareMenu = () => {
    if (sharing) return;
    setShareVisible(true);
  };

  const confirmDelete = () => {
    const presentation = meetingDeletionPresentation(m);
    if (presentation.blocked) {
      showDialog({
        title: presentation.title,
        message: presentation.message,
        tone: 'warning',
      });
      return;
    }
    showDialog({
      title: presentation.title,
      message: presentation.message,
      tone: 'danger',
      actions: [
        {
          text: presentation.confirmText,
          role: 'destructive',
          onPress: async () => {
            try {
              await deleteMeeting(m.id);
              openMeetingsTab(navigation);
            } catch (deleteError) {
              if (deleteError instanceof MeetingDeletionCleanupError) {
                openMeetingsTab(navigation);
                showDialog({
                  title: '会议已删除，清理未完成',
                  message: deleteError.message,
                  tone: 'warning',
                });
              } else {
                showDialog({
                  title: '删除失败',
                  message: readableErrorMessage(deleteError, '请检查网络后重试。'),
                  tone: 'error',
                });
              }
            }
          },
        },
        { text: '取消', role: 'cancel' },
      ],
    });
  };

  return (
    <ScreenContainer edges={['top', 'bottom']} bg={C.body}>
      <MinutesDetailTitleBar
        onBack={() => navigation.goBack()}
        onShare={openShareMenu}
        onMore={() => setMoreVisible(true)}
        sharing={sharing}
        shareTestID="meeting-share-menu"
        backgroundColor={C.body}
      />
      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        stickyHeaderIndices={[1]}
      >
        <View style={s.meetingHeader}>
          {titleEditing ? (
            <TextInput
              ref={titleInputRef}
              style={s.titleInput}
              value={titleEdit}
              onChangeText={setTitleEdit}
              onBlur={() => { void commitTitle(); }}
              onSubmitEditing={() => titleInputRef.current?.blur?.()}
              editable={!titleSaving}
              autoFocus
              blurOnSubmit
              returnKeyType="done"
              accessibilityLabel="会议标题"
              testID="meeting-title-input"
            />
          ) : (
            <TouchableOpacity
              style={s.titleDisplayButton}
              onPress={beginTitleEdit}
              activeOpacity={0.72}
              accessibilityRole="button"
              accessibilityLabel="编辑会议标题"
              accessibilityValue={{ text: displayMeetingTitle(m.title) }}
              testID="meeting-title-display"
            >
              <Text style={s.titleDisplay} numberOfLines={2}>{displayMeetingTitle(m.title)}</Text>
            </TouchableOpacity>
          )}
          <View style={s.metaRow}>
            <Ionicons name="time-outline" size={12} color={C.sub} />
            <Text style={s.metaText}>{[m.date, m.time].filter(Boolean).join(' ')}</Text>
          </View>
          {pendingAudioUpload ? (
            <View style={s.uploadPending} testID="meeting-audio-upload-pending">
              <Ionicons
                name={pendingAudioUpload.uploadState === 'blocked' ? 'alert-circle-outline' : 'cloud-upload-outline'}
                size={16}
                color={pendingAudioUpload.uploadState === 'blocked' ? C.red : C.orange}
              />
              <Text style={s.uploadPendingText}>
                {pendingAudioError || (retryingAudioUpload ? '录音正在后台同步' : '录音已保存在本机，尚未同步到云端')}
              </Text>
              <TouchableOpacity
                style={s.uploadRetryButton}
                onPress={handleRetryAudioUpload}
                disabled={retryingAudioUpload}
                accessibilityRole="button"
                accessibilityLabel="重试上传会议录音"
                testID="meeting-audio-upload-retry"
              >
                {retryingAudioUpload
                  ? <ActivityIndicator size="small" color={C.primary} />
                  : <Ionicons name="refresh" size={16} color={C.primary} />}
              </TouchableOpacity>
            </View>
          ) : pendingAudioError ? (
            <View style={s.uploadPending} accessibilityRole="alert">
              <Ionicons name="alert-circle-outline" size={16} color={C.red} />
              <Text style={s.uploadPendingText}>{pendingAudioError}</Text>
              <TouchableOpacity
                style={s.uploadRetryButton}
                onPress={() => setReloadKey(value => value + 1)}
                accessibilityRole="button"
                accessibilityLabel="重试读取录音待上传状态"
              >
                <Ionicons name="refresh" size={16} color={C.primary} />
              </TouchableOpacity>
            </View>
          ) : null}
        </View>

        <View
          style={s.tabs}
          testID="meeting-detail-tabs"
        >
          <TouchableOpacity
            style={[s.tab, s.transcriptTab]}
            onPress={() => selectDetailTab('transcript')}
            accessibilityRole="button"
            accessibilityLabel="查看会议转写"
            accessibilityState={{ selected: activeTab === 'transcript' }}
          >
            <Text style={[s.tabText, activeTab === 'transcript' && s.tabTextActive]}>文字记录</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.tab, s.summaryTab]}
            onPress={() => selectDetailTab('summary')}
            accessibilityRole="button"
            accessibilityLabel="查看会议纪要"
            accessibilityState={{ selected: activeTab === 'summary' }}
          >
            <Text style={[s.tabText, activeTab === 'summary' && s.tabTextActive]}>纪要</Text>
          </TouchableOpacity>
          <View style={s.tabDivider} />
          <Animated.View
            testID="meeting-detail-tab-indicator"
            style={[
              s.tabIndicator,
              {
                left: tabIndicatorPosition.interpolate({
                  inputRange: [0, 1],
                  outputRange: [
                    MEETING_DETAIL_TAB_GEOMETRY.transcriptIndicatorLeft,
                    MEETING_DETAIL_TAB_GEOMETRY.summaryIndicatorLeft,
                  ],
                }),
                width: tabIndicatorPosition.interpolate({
                  inputRange: [0, 1],
                  outputRange: [
                    MEETING_DETAIL_TAB_GEOMETRY.transcriptIndicatorWidth,
                    MEETING_DETAIL_TAB_GEOMETRY.summaryIndicatorWidth,
                  ],
                }),
              },
            ]}
          />
        </View>

        <Animated.View
          testID="meeting-detail-tab-page"
          style={{
            opacity: tabPageProgress,
            transform: [{
              translateX: tabPageProgress.interpolate({
                inputRange: [0, 1],
                outputRange: [tabDirectionRef.current * 24, 0],
              }),
            }],
          }}
          {...detailPagerPanResponder.panHandlers}
        >
          {activeTab === 'transcript' ? (
            <View style={s.tabContent} testID="meeting-transcript-list">
            {transcriptError ? (
              <TouchableOpacity
                style={s.syncWarning}
                onPress={() => setReloadKey(value => value + 1)}
                accessibilityRole="button"
                accessibilityLabel="重试同步会议转写"
              >
                <Ionicons name="cloud-offline-outline" size={15} color={C.red} />
                <Text style={s.syncWarningText}>{transcriptError}</Text>
                <Text style={s.retryText}>重试</Text>
              </TouchableOpacity>
            ) : null}
            {loadingTranscript && transcriptItems.length === 0 ? (
              <View style={s.loadingState}>
                <ActivityIndicator size="small" color={C.primary} />
                <Text style={s.loadingText}>正在同步文字记录</Text>
              </View>
            ) : transcriptItems.length > 0 ? (
              transcriptItems.map((line, index) => (
                <View
                  key={line.id || `${line.start_time ?? index}-${index}`}
                  style={s.transcriptItem}
                  testID={`meeting-transcript-line-${line.id || index}`}
                >
                  <View
                    style={s.transcriptMetaRow}
                    testID={`meeting-transcript-meta-${line.id || index}`}
                  >
                    <View
                      style={[
                        s.speakerAvatar,
                        { backgroundColor: speakerAvatarTone(line).backgroundColor },
                      ]}
                      testID={`meeting-speaker-avatar-${line.id || index}`}
                    >
                      <Ionicons
                        name="person"
                        size={14}
                        color={speakerAvatarTone(line).foregroundColor}
                      />
                    </View>
                    <Text style={s.transcriptSpeaker} numberOfLines={1}>
                      {speakerDisplayLabel(line.speaker_label, line.speaker_id, '讲话人')}
                    </Text>
                    <View style={s.transcriptDot} />
                    <Text style={s.transcriptTime}>{transcriptTimestamp(line.start_time)}</Text>
                  </View>
                  <Text
                    style={s.transcriptText}
                    testID={`meeting-transcript-text-${line.id || index}`}
                  >
                    {line.text}
                  </Text>
                </View>
              ))
            ) : (
              <View style={s.emptyState}>
                <Text style={s.emptyStateText}>暂无文字记录</Text>
              </View>
            )}
            </View>
          ) : (
            <View style={s.summaryContent} testID="meeting-summary-content">
            {summaryError ? (
              <TouchableOpacity
                style={s.syncWarning}
                onPress={summary ? () => setReloadKey(value => value + 1) : handleGenerateSummary}
                accessibilityRole="button"
                accessibilityLabel="重试会议总结"
              >
                <Ionicons name="cloud-offline-outline" size={15} color={C.red} />
                <Text style={s.syncWarningText}>{summaryError}</Text>
                <Text style={s.retryText}>重试</Text>
              </TouchableOpacity>
            ) : null}
            {loadingSummary ? (
              <View style={s.summaryLoading}>
                <ActivityIndicator size="small" color={C.primary} />
                <Text style={s.summaryLoadingText}>{summaryProgress}</Text>
                {summaryAbortRef.current ? (
                  <TouchableOpacity onPress={() => summaryAbortRef.current?.abort()} style={s.stopWaitingBtn}>
                    <Text style={s.stopWaitingText}>停止等待</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            ) : summary ? (
              <MeetingSummaryContent markdown={summary} />
            ) : (
              <View style={s.emptyState}>
                <Text style={s.emptyStateText}>{m.hasSummary ? '暂无总结内容' : '该会议暂未生成总结'}</Text>
              </View>
            )}
            {!loadingSummary && !summaryError && transcriptItems.length > 0 ? (
              <TouchableOpacity
                style={[s.generateBtn, summary && s.regenerateBtn]}
                onPress={handleGenerateSummary}
                activeOpacity={0.84}
                accessibilityRole="button"
                accessibilityLabel={summary ? '重新生成会议总结' : '生成会议总结'}
              >
                <Ionicons name="sparkles-outline" size={16} color={summary ? C.primary : '#fff'} />
                <Text style={[s.generateText, summary && s.regenerateText]}>{summary ? '重新生成' : '生成总结'}</Text>
              </TouchableOpacity>
            ) : null}
            </View>
          )}
        </Animated.View>
      </ScrollView>

      <MeetingAudioPlayerDock
        meeting={m}
        accessToken={accessToken}
        isGuest={isGuest}
        fallbackDurationSec={transcriptDurationSec(transcriptItems)}
      />

      <MeetingShareSheet
        visible={shareVisible}
        availability={shareAvailability}
        onClose={() => setShareVisible(false)}
        onShare={selection => { void runMeetingShare(selection); }}
      />

      <MeetingTemplateSheet
        visible={templateSheetVisible}
        selectedTemplate={summaryTemplate}
        busy={loadingSummary}
        onClose={() => setTemplateSheetVisible(false)}
        onSelect={template => {
          void prepareSummaryGeneration(template);
        }}
      />

      <MeetingSummaryCarryForwardSheet
        visible={summaryCarryForwardRequest !== null}
        memory={summaryCarryForwardRequest?.memory ?? null}
        onClose={() => setSummaryCarryForwardRequest(null)}
        onSkip={() => {
          const request = summaryCarryForwardRequest;
          setSummaryCarryForwardRequest(null);
          if (
            request
            && activeMeetingIdRef.current === request.meetingId
            && activeMeetingScopeRef.current === request.scopeKey
          ) {
            void runSummaryTask({
              forceRegenerate: request.forceRegenerate,
              template: request.template,
              carryForward: null,
            });
          }
        }}
        onAuthorize={selection => {
          const request = summaryCarryForwardRequest;
          if (
            !request
            || activeMeetingIdRef.current !== request.meetingId
            || activeMeetingScopeRef.current !== request.scopeKey
          ) {
            return Promise.reject(new Error('summary carry-forward request is no longer active'));
          }
          return authorizeMeetingSummaryCarryForward({
            scopeKey: request.scopeKey,
            meetingId: request.meetingId,
            selection,
          });
        }}
        onCompleted={carryForward => {
          const request = summaryCarryForwardRequest;
          setSummaryCarryForwardRequest(null);
          if (
            request
            && activeMeetingIdRef.current === request.meetingId
            && activeMeetingScopeRef.current === request.scopeKey
          ) {
            void runSummaryTask({
              forceRegenerate: request.forceRegenerate,
              template: request.template,
              carryForward,
            });
          }
        }}
      />

      {moreVisible ? (
        <AppActionSheet
          visible
          title={displayMeetingTitle(m.title)}
          onClose={() => setMoreVisible(false)}
          items={[
            {
              key: 'delete',
              label: '删除会议',
              destructive: true,
              onPress: confirmDelete,
            },
          ]}
        />
      ) : null}
    </ScreenContainer>
  );
}

const s = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: C.body },
  content: { paddingBottom: 32 },
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: C.body },
  emptyTitle: { fontSize: 17, fontWeight: '600', color: C.text, marginBottom: 8 },
  emptyText: { fontSize: 14, color: C.sub, lineHeight: 20 },
  meetingHeader: { paddingTop: 20, paddingBottom: 16 },
  titleDisplayButton: {
    minHeight: 44,
    marginHorizontal: 20,
    justifyContent: 'center',
  },
  titleDisplay: {
    fontSize: 24,
    lineHeight: 36,
    fontWeight: '700',
    color: C.text,
  },
  titleInput: {
    minHeight: 44,
    marginHorizontal: 20,
    padding: 0,
    fontSize: 24,
    lineHeight: 36,
    fontWeight: '700',
    color: C.text,
  },
  metaRow: { height: 22, marginLeft: 20, marginTop: 6, flexDirection: 'row', alignItems: 'center' },
  metaText: { marginLeft: 4, fontSize: 14, lineHeight: 22, color: C.sub },
  uploadPending: {
    minHeight: 44,
    marginTop: 12,
    paddingLeft: 20,
    paddingRight: 8,
    backgroundColor: '#FFF7E8',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  uploadPendingText: { flex: 1, fontSize: 13, lineHeight: 20, color: C.sub },
  uploadRetryButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  tabs: {
    height: 41,
    flexDirection: 'row',
    paddingLeft: MEETING_DETAIL_TAB_GEOMETRY.startInset,
    backgroundColor: C.body,
  },
  tab: { height: 41, alignItems: 'center', justifyContent: 'center' },
  transcriptTab: { width: MEETING_DETAIL_TAB_GEOMETRY.transcriptWidth },
  summaryTab: { width: MEETING_DETAIL_TAB_GEOMETRY.summaryWidth },
  tabText: { fontSize: 14, lineHeight: 20, color: C.sub },
  tabTextActive: { color: C.text, fontWeight: '600' },
  tabDivider: {
    position: 'absolute',
    left: 10,
    right: 10,
    bottom: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: C.border,
  },
  tabIndicator: {
    position: 'absolute',
    bottom: 0,
    height: 2,
    borderTopLeftRadius: 2,
    borderTopRightRadius: 2,
    backgroundColor: C.primary,
  },
  tabContent: { minHeight: 320, paddingBottom: 20 },
  transcriptItem: { paddingTop: 20, paddingBottom: 12 },
  speakerAvatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
    marginRight: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  transcriptMetaRow: { minHeight: 24, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center' },
  transcriptSpeaker: { maxWidth: '55%', fontSize: 14, lineHeight: 20, color: C.sub },
  transcriptDot: { width: 3, height: 3, borderRadius: 1.5, marginHorizontal: 12, backgroundColor: C.faint },
  transcriptTime: { fontSize: 14, lineHeight: 20, color: C.sub },
  transcriptText: { marginTop: 10, marginHorizontal: 20, fontSize: 16, lineHeight: 28, color: C.text },
  summaryContent: { minHeight: 320, paddingTop: 10, paddingBottom: 24 },
  loadingState: { minHeight: 220, alignItems: 'center', justifyContent: 'center', gap: 10 },
  loadingText: { fontSize: 14, lineHeight: 20, color: C.sub },
  emptyState: { minHeight: 220, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20 },
  emptyStateText: { fontSize: 14, lineHeight: 20, color: C.sub },
  syncWarning: {
    minHeight: 44,
    backgroundColor: '#FFF3F3',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 20,
  },
  syncWarningText: { flex: 1, fontSize: 13, lineHeight: 20, color: C.red },
  retryText: { fontSize: 13, lineHeight: 20, color: C.primary, fontWeight: '500' },
  summaryLoading: { minHeight: 220, paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center', gap: 10 },
  summaryLoadingText: { fontSize: 14, lineHeight: 20, color: C.sub },
  stopWaitingBtn: { minHeight: 36, justifyContent: 'center', paddingHorizontal: 12 },
  stopWaitingText: { fontSize: 14, lineHeight: 20, color: C.primary, fontWeight: '500' },
  generateBtn: {
    alignSelf: 'center',
    height: 40,
    marginTop: 20,
    borderRadius: 6,
    paddingHorizontal: 16,
    backgroundColor: C.primary,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  generateText: { fontSize: 14, lineHeight: 20, color: '#fff', fontWeight: '500' },
  regenerateBtn: { backgroundColor: C.primaryLight },
  regenerateText: { color: C.primary },
});
