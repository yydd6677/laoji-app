import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  StyleSheet,
  View,
} from 'react-native';
import type { RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  LaojiMinutesView,
  type MinutesDetailTab,
  type MinutesPlayerSourceSnapshot,
  type MinutesSemanticAction,
} from 'laoji-native-platform';
import { AppActionSheet, type AppActionSheetItem } from '../components/AppActionSheet';
import { ScreenContainer } from '../components/ScreenContainer';
import { useAppDialog } from '../components/AppDialog';
import { useAuth } from '../store/AuthStore';
import { MeetingDeletionCleanupError, useMeetings } from '../store/MeetingsStore';
import {
  fetchMeetingAudioInfo,
  fetchMeetingSummary,
  fetchMeetingTranscript,
  uploadMeetingAudio,
} from '../services/api';
import { readableErrorMessage } from '../services/errors';
import {
  canAutomaticallyRetryPendingMeetingAudioUpload,
  getPendingMeetingAudioUpload,
  retryPendingMeetingAudioUpload,
  type PendingMeetingAudioUpload,
} from '../services/meetingRecording';
import {
  generateSummaryForMeeting,
  meetingDateForSummary,
  meetingSummaryProgressLabel,
  meetingSummaryToText,
  shouldDiscardPendingMeetingSummaryTask,
} from '../services/meetingSummary';
import {
  clearPendingMeetingSummaryTask,
  getPendingMeetingSummaryTask,
  meetingSummaryInputFingerprint,
  savePendingMeetingSummaryTask,
  type PendingMeetingSummaryTask,
} from '../services/meetingSummaryTasks';
import {
  meetingShareErrorMessage,
  shareMeetingArtifact,
  type MeetingShareKind,
} from '../services/meetingShare';
import { openMeetingsTab } from '../navigation/tabTargets';
import {
  buildNativeMinutesDetailSnapshot,
  nativeMinutesDetailRetryPlan,
  type NativeMinutesPageGenerations,
} from '../native/nativeMinutesSnapshots';
import {
  NativeMinutesRequestCoordinator,
  NativeMinutesTabSelectionOwner,
  type NativeMinutesRequestToken,
} from '../native/nativeMinutesRequestCoordinator';
import type { RootStackParamList, TranscriptLine } from '../types';
import { transcriptDurationSec } from '../utils/meetingMedia';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Transcription'>;
  route: RouteProp<RootStackParamList, 'Transcription'>;
};

function compactMeetingDateTime(date: string, time?: string): string {
  const currentYearPrefix = `${new Date().getFullYear()}年`;
  const compactDate = date.startsWith(currentYearPrefix) ? date.slice(currentYearPrefix.length) : date;
  return [compactDate, time].filter(Boolean).join(' ');
}

function localPlayerSource(
  meetingId: string,
  title: string,
  uri: string,
  storageScope: 'guest' | `user:${string}`,
  durationSec?: number,
): MinutesPlayerSourceSnapshot {
  return {
    sourceId: `local:${meetingId}`,
    uri,
    title,
    durationMsHint: durationSec ? Math.round(durationSec * 1000) : undefined,
    retainForBackground: true,
    storageScope,
  };
}

/** MIN-DETAIL-001 / MIN-SUMMARY-001 / MIN-GUEST-001 / MIN-PLAYER-001. */
export function TranscriptionScreen({ navigation, route }: Props) {
  const {
    meetings,
    deleteMeeting,
    getCachedTranscript,
    saveCachedTranscript,
    getCachedSummary,
    saveCachedSummary,
    refreshMeetings,
    updateMeetingTitle,
  } = useMeetings();
  const { accessToken, isGuest, session } = useAuth();
  const { showDialog } = useAppDialog();
  const meeting = meetings.find(item => item.id === route.params.meetingId);
  const [activeTab, setActiveTab] = useState<MinutesDetailTab>(
    route.params.focus === 'summary' ? 'summary' : 'transcript',
  );
  const [tabGeneration, setTabGeneration] = useState(0);
  const [transcript, setTranscript] = useState<TranscriptLine[]>(
    () => meeting ? getCachedTranscript(meeting.id) : [],
  );
  const [summary, setSummary] = useState(() => meeting ? meetingSummaryToText(getCachedSummary(meeting.id)) : '');
  const [loadingTranscript, setLoadingTranscript] = useState(false);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [transcriptError, setTranscriptError] = useState('');
  const [summaryError, setSummaryError] = useState('');
  const [summaryProgress, setSummaryProgress] = useState('正在提交总结任务');
  const [transcriptCached, setTranscriptCached] = useState(() => Boolean(meeting && getCachedTranscript(meeting.id).length));
  const [summaryCached, setSummaryCached] = useState(() => Boolean(meeting && getCachedSummary(meeting.id)));
  const requestCoordinatorRef = useRef(new NativeMinutesRequestCoordinator());
  const [pageGenerations, setPageGenerations] = useState<NativeMinutesPageGenerations>(
    () => requestCoordinatorRef.current.snapshot(),
  );
  const [reloadKey, setReloadKey] = useState(0);
  const [playerSource, setPlayerSource] = useState<MinutesPlayerSourceSnapshot | null>(null);
  const [sharing, setSharing] = useState(false);
  const [moreVisible, setMoreVisible] = useState(false);
  const [pendingAudioUpload, setPendingAudioUpload] = useState<PendingMeetingAudioUpload | null>(null);
  const [pendingAudioError, setPendingAudioError] = useState('');
  const [playerSourceError, setPlayerSourceError] = useState('');
  const [loadingAudio, setLoadingAudio] = useState(false);
  const [retryingAudioUpload, setRetryingAudioUpload] = useState(false);
  const mountedRef = useRef(true);
  const summaryAbortRef = useRef<AbortController | null>(null);
  const silentSummaryAbortRef = useRef(new WeakSet<AbortController>());
  const summaryScopeRef = useRef<string | null>(null);
  const summaryInFlightRef = useRef<Promise<void> | null>(null);
  const uploadInFlightRef = useRef<Promise<void> | null>(null);
  const automaticAudioUploadKeyRef = useRef('');
  const autoResumeTaskRef = useRef('');
  const recordingStorageScope = isGuest ? 'guest' : session ? `user:${session.user.id}` : 'signed_out';
  const playbackStorageScope: 'guest' | `user:${string}` | null = isGuest
    ? 'guest'
    : session
      ? `user:${session.user.id}`
      : null;
  const routeMeetingIdRef = useRef(route.params.meetingId);
  routeMeetingIdRef.current = route.params.meetingId;
  const initialTab = route.params.focus === 'summary' ? 'summary' : 'transcript';
  const tabOwnerRef = useRef(new NativeMinutesTabSelectionOwner({
    meetingId: route.params.meetingId,
    tab: initialTab,
    generation: 0,
  }));

  const advancePageGenerations = useCallback((...tabs: readonly MinutesDetailTab[]) => {
    const next = requestCoordinatorRef.current.advance(...tabs);
    setPageGenerations(next);
    return next;
  }, []);

  const beginPageRequest = useCallback((meetingId: string, ...tabs: readonly MinutesDetailTab[]) => {
    const request = requestCoordinatorRef.current.begin(meetingId, ...tabs);
    setPageGenerations(request.generations);
    return request.token;
  }, []);

  const isCurrentPageRequest = useCallback((token: NativeMinutesRequestToken) => (
    mountedRef.current && requestCoordinatorRef.current.isCurrent(token, routeMeetingIdRef.current)
  ), []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      summaryAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    const previousScope = summaryScopeRef.current;
    summaryScopeRef.current = recordingStorageScope;
    if (previousScope == null || previousScope === recordingStorageScope) return;
    const controller = summaryAbortRef.current;
    if (!controller) return;
    silentSummaryAbortRef.current.add(controller);
    controller.abort();
  }, [recordingStorageScope]);

  useEffect(() => {
    if (!meeting) {
      advancePageGenerations('transcript', 'summary', 'speakers');
      setTranscript([]);
      setSummary('');
      setTranscriptCached(false);
      setSummaryCached(false);
      setLoadingTranscript(false);
      setLoadingSummary(false);
      setTranscriptError('');
      setSummaryError('');
      return;
    }
    let alive = true;
    const cachedTranscript = getCachedTranscript(meeting.id);
    const cachedSummary = meetingSummaryToText(getCachedSummary(meeting.id));
    const transcriptRequest = beginPageRequest(meeting.id, 'transcript', 'speakers');
    setTranscript(cachedTranscript);
    setTranscriptCached(cachedTranscript.length > 0);
    setSummary(cachedSummary);
    setSummaryCached(Boolean(cachedSummary));
    setTranscriptError('');
    setSummaryError('');
    setLoadingSummary(false);

    setLoadingTranscript(true);
    if (isGuest || !accessToken) {
      setLoadingTranscript(false);
    } else {
      fetchMeetingTranscript(meeting.id, accessToken, { fallbackItems: cachedTranscript })
        .then(items => {
          if (!alive || !isCurrentPageRequest(transcriptRequest)) return;
          if (items.length > 0) {
            setTranscript(items);
            setTranscriptCached(false);
            void saveCachedTranscript(meeting.id, items).catch(() => {
              if (alive && isCurrentPageRequest(transcriptRequest)) {
                setTranscriptError('转写已同步，但本机缓存写入失败。');
              }
            });
          }
        })
        .catch(() => {
          if (alive && isCurrentPageRequest(transcriptRequest)) {
            setTranscriptCached(cachedTranscript.length > 0);
            setTranscriptError('转写同步失败，当前显示本机缓存。');
          }
        })
        .finally(() => {
          if (alive && isCurrentPageRequest(transcriptRequest)) setLoadingTranscript(false);
        });
    }

    if (meeting.hasSummary && !isGuest && accessToken) {
      const summaryRequest = beginPageRequest(meeting.id, 'summary');
      setLoadingSummary(true);
      setSummaryProgress('正在同步总结');
      fetchMeetingSummary(meeting.id, accessToken)
        .then(text => {
          if (!alive || !isCurrentPageRequest(summaryRequest)) return;
          setSummary(text || cachedSummary);
          setSummaryCached(!text && Boolean(cachedSummary));
          if (text) {
            void saveCachedSummary(meeting.id, {
              meeting_id: meeting.id,
              full_text: text,
              generated_at: new Date().toISOString(),
            }).catch(() => {
              if (alive && isCurrentPageRequest(summaryRequest)) {
                setSummaryError('总结已同步，但本机缓存写入失败。');
              }
            });
          }
        })
        .catch(() => {
          if (alive && isCurrentPageRequest(summaryRequest)) {
            setSummaryCached(Boolean(cachedSummary));
            setSummaryError('总结同步失败，可重试或重新生成。');
          }
        })
        .finally(() => {
          if (alive && isCurrentPageRequest(summaryRequest)) setLoadingSummary(false);
        });
    }
    return () => { alive = false; };
  }, [accessToken, advancePageGenerations, beginPageRequest, getCachedSummary, getCachedTranscript, isCurrentPageRequest, isGuest, meeting?.hasSummary, meeting?.id, reloadKey, saveCachedSummary, saveCachedTranscript]);

  useEffect(() => {
    if (!meeting) {
      setPlayerSource(null);
      setPlayerSourceError('');
      setLoadingAudio(false);
      return;
    }
    let alive = true;
    setPlayerSourceError('');
    if (meeting.audioLocalUri) {
      if (!playbackStorageScope) {
        setPlayerSource(null);
        setLoadingAudio(false);
        return () => { alive = false; };
      }
      setLoadingAudio(false);
      setPlayerSource(localPlayerSource(
        meeting.id,
        meeting.title,
        meeting.audioLocalUri,
        playbackStorageScope,
        meeting.audioDurationSec ?? transcriptDurationSec(transcript),
      ));
      return () => { alive = false; };
    }
    setPlayerSource(null);
    if (isGuest || !accessToken) {
      setLoadingAudio(false);
      return () => { alive = false; };
    }
    setLoadingAudio(true);
    void fetchMeetingAudioInfo(meeting.id, accessToken)
      .then(info => {
        if (!alive || !info) return;
        if (!playbackStorageScope) return;
        const parsedExpiry = info.expires_at ? Date.parse(info.expires_at) : Number.NaN;
        setPlayerSource({
          sourceId: `cloud:${meeting.id}`,
          uri: info.url,
          headers: info.requires_auth ? { Authorization: `Bearer ${accessToken}` } : undefined,
          title: meeting.title,
          durationMsHint: info.duration_sec ? Math.round(info.duration_sec * 1000) : undefined,
          retainForBackground: true,
          storageScope: playbackStorageScope,
          expiresAt: Number.isFinite(parsedExpiry) ? parsedExpiry : undefined,
        });
        setPlayerSourceError('');
      })
      .catch(() => {
        if (alive) {
          setPlayerSource(null);
          setPlayerSourceError('录音信息获取失败，请稍后重试。');
        }
      })
      .finally(() => { if (alive) setLoadingAudio(false); });
    return () => { alive = false; };
  }, [accessToken, isGuest, meeting?.audioDurationSec, meeting?.audioLocalUri, meeting?.id, meeting?.title, playbackStorageScope, reloadKey, transcript]);

  const performPendingAudioUpload = useCallback((
    pending: PendingMeetingAudioUpload,
    notifyUser: boolean,
  ): Promise<void> => {
    if (!accessToken) return Promise.resolve();
    if (uploadInFlightRef.current) return uploadInFlightRef.current;
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
            item.meetingId,
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
        if (notifyUser && mountedRef.current) {
          showDialog(uploaded
            ? { title: '上传完成', message: '本机录音已同步到会议服务。', tone: 'success' }
            : { title: '正在后台同步', message: '录音将在后台继续上传。', tone: 'info' });
        }
      } catch {
        const latest = await getPendingMeetingAudioUpload(recordingStorageScope, pending.meetingId).catch(() => null);
        if (mountedRef.current) {
          setPendingAudioUpload(latest);
          setPendingAudioError(readableErrorMessage(
            latest?.failureMessage,
            '自动同步未完成，录音仍保存在本机',
          ));
          if (notifyUser) {
            showDialog({
              title: latest?.uploadState === 'blocked' ? '录音上传受阻' : '上传失败',
              message: readableErrorMessage(
                latest?.failureMessage,
                '录音仍保存在本机，可稍后再次重试。',
              ),
              tone: 'error',
            });
          }
        }
      } finally {
        if (mountedRef.current) setRetryingAudioUpload(false);
        if (uploadInFlightRef.current === operation) uploadInFlightRef.current = null;
      }
    })();
    uploadInFlightRef.current = operation;
    return operation;
  }, [accessToken, recordingStorageScope, refreshMeetings, showDialog]);

  useEffect(() => {
    let alive = true;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    if (!meeting || isGuest) {
      setPendingAudioUpload(null);
      setPendingAudioError('');
      return () => { alive = false; };
    }
    void getPendingMeetingAudioUpload(recordingStorageScope, meeting.id).then(pending => {
      if (!alive) return;
      setPendingAudioUpload(pending);
      setPendingAudioError(pending?.failureMessage
        ? readableErrorMessage(pending.failureMessage, '自动同步未完成，录音仍保存在本机')
        : '');
      if (!pending || !accessToken) return;
      const key = `${recordingStorageScope}:${pending.meetingId}:${pending.attemptCount}:${pending.nextAttemptAt ?? ''}`;
      if (automaticAudioUploadKeyRef.current === key) return;
      automaticAudioUploadKeyRef.current = key;
      if (canAutomaticallyRetryPendingMeetingAudioUpload(pending)) {
        void performPendingAudioUpload(pending, false);
      } else if (pending.uploadState !== 'blocked' && pending.nextAttemptAt) {
        const retryAt = Date.parse(pending.nextAttemptAt);
        if (!Number.isNaN(retryAt)) {
          retryTimer = setTimeout(() => setReloadKey(value => value + 1), Math.max(0, retryAt - Date.now()));
        }
      }
    }).catch(() => {
      if (alive) setPendingAudioError('无法读取录音待上传状态，请重试。');
    });
    return () => {
      alive = false;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [accessToken, isGuest, meeting?.id, performPendingAudioUpload, recordingStorageScope, reloadKey]);

  useEffect(() => { autoResumeTaskRef.current = ''; }, [meeting?.id, recordingStorageScope]);

  function runSummaryTask(options: {
    automatic?: boolean;
    forceRegenerate?: boolean;
    resumeTask?: PendingMeetingSummaryTask | null;
    transcriptLines?: TranscriptLine[];
  } = {}): Promise<void> {
    if (!meeting) return Promise.resolve();
    if (summaryInFlightRef.current) return summaryInFlightRef.current;
    const currentMeeting = meeting;
    const lines = options.transcriptLines ?? transcript;
    if (lines.length === 0) {
      if (!options.automatic) {
        showDialog({ title: '暂无转写', message: '需要先有会议转写内容，才能生成总结。', tone: 'info' });
      }
      return Promise.resolve();
    }

    const meetingDate = meetingDateForSummary(currentMeeting.date, currentMeeting.createdAt);
    const fingerprint = meetingSummaryInputFingerprint(lines, currentMeeting.title, meetingDate);
    const expectedMode = isGuest ? 'guest' : 'authenticated';
    let operation: Promise<void> | null = null;
    operation = (async () => {
      const summaryRequest = beginPageRequest(currentMeeting.id, 'summary');
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
            if (!isCurrentPageRequest(summaryRequest)) return;
          } catch {
            throw new Error('无法读取上次总结任务，未提交新任务。请检查本机存储后重试。');
          }
        }
        if (pending && (pending.mode !== expectedMode || pending.inputFingerprint !== fingerprint)) {
          await clearPendingMeetingSummaryTask(recordingStorageScope, currentMeeting.id).catch(() => {});
          if (!isCurrentPageRequest(summaryRequest)) return;
          pending = null;
        }
        if (!isCurrentPageRequest(summaryRequest)) return;
        setSummaryProgress(pending ? '正在恢复上次总结任务' : '正在提交总结任务');
        const generated = await generateSummaryForMeeting({
          meetingId: currentMeeting.id,
          title: currentMeeting.title,
          meetingDate,
          transcriptLines: lines,
          isGuest,
          accessToken,
          resumeTaskId: pending?.taskId,
          forceRegenerate: Boolean(options.forceRegenerate),
          signal: controller.signal,
          onTaskSubmitted: async taskId => {
            if (!isCurrentPageRequest(summaryRequest)) return;
            try {
              await savePendingMeetingSummaryTask(recordingStorageScope, {
                meetingId: currentMeeting.id,
                taskId,
                mode: expectedMode,
                inputFingerprint: fingerprint,
              });
              if (!isCurrentPageRequest(summaryRequest)) return;
              autoResumeTaskRef.current = taskId;
            } catch {
              if (isCurrentPageRequest(summaryRequest)) {
                setSummaryError('任务已提交，但本机无法保存恢复状态，请保持当前页面打开。');
              }
            }
          },
          onProgress: progress => {
            if (isCurrentPageRequest(summaryRequest)) {
              setSummaryProgress(meetingSummaryProgressLabel(progress));
            }
          },
        });
        if (!isCurrentPageRequest(summaryRequest)) return;
        const text = meetingSummaryToText(generated);
        setSummary(text || '暂无总结内容');
        setSummaryCached(false);
        setSummaryError('');
        let cached = false;
        try {
          await saveCachedSummary(currentMeeting.id, generated);
          if (!isCurrentPageRequest(summaryRequest)) return;
          cached = true;
        } catch {
          if (isCurrentPageRequest(summaryRequest)) {
            setSummaryError('总结已生成，但本机缓存写入失败。');
            showDialog({
              title: '总结已生成，保存失败',
              message: '当前页面仍可查看总结，但退出后可能无法离线恢复。',
              tone: 'warning',
            });
          }
        }
        if (isCurrentPageRequest(summaryRequest) && (cached || !isGuest)) {
          await clearPendingMeetingSummaryTask(recordingStorageScope, currentMeeting.id).catch(() => {});
        }
      } catch (reason) {
        if (isCurrentPageRequest(summaryRequest) && shouldDiscardPendingMeetingSummaryTask(reason)) {
          await clearPendingMeetingSummaryTask(recordingStorageScope, currentMeeting.id).catch(() => {});
        }
        if (!isCurrentPageRequest(summaryRequest)) return;
        if ((reason as Error)?.name === 'AbortError') {
          if (!options.automatic && !silentSummaryAbortRef.current.has(controller)) {
            showDialog({
              title: '已停止等待',
              message: '任务会继续在后台生成，再次打开会议即可恢复。',
              tone: 'info',
            });
          }
        } else {
          const message = readableErrorMessage(
            reason,
            options.automatic ? '上次会议总结暂时无法恢复，点击重试可继续获取。' : '会议总结暂时无法生成，请稍后重试。',
          );
          setSummaryError(message);
          if (!options.automatic) showDialog({ title: '生成失败', message, tone: 'error' });
        }
      } finally {
        if (summaryAbortRef.current === controller) {
          summaryAbortRef.current = null;
          if (isCurrentPageRequest(summaryRequest)) setLoadingSummary(false);
        }
        if (summaryInFlightRef.current === operation) summaryInFlightRef.current = null;
      }
    })();
    summaryInFlightRef.current = operation;
    return operation;
  }

  useEffect(() => {
    if (!meeting || loadingTranscript || loadingSummary || summaryInFlightRef.current || transcript.length === 0) return;
    let alive = true;
    const date = meetingDateForSummary(meeting.date, meeting.createdAt);
    const fingerprint = meetingSummaryInputFingerprint(transcript, meeting.title, date);
    const expectedMode = isGuest ? 'guest' : 'authenticated';
    const pendingRequest = requestCoordinatorRef.current.capture(meeting.id, 'summary');
    void getPendingMeetingSummaryTask(recordingStorageScope, meeting.id).then(pending => {
      if (
        !alive ||
        !isCurrentPageRequest(pendingRequest) ||
        !pending ||
        autoResumeTaskRef.current === pending.taskId
      ) return;
      if (pending.mode !== expectedMode || pending.inputFingerprint !== fingerprint) {
        void clearPendingMeetingSummaryTask(recordingStorageScope, meeting.id).catch(() => {});
        return;
      }
      autoResumeTaskRef.current = pending.taskId;
      void runSummaryTask({ automatic: true, resumeTask: pending, transcriptLines: transcript });
    }).catch(() => {
      if (alive && isCurrentPageRequest(pendingRequest)) {
        setSummaryError('无法读取上次总结任务，点击重试可重新生成。');
      }
    });
    return () => { alive = false; };
  }, [isCurrentPageRequest, isGuest, loadingSummary, loadingTranscript, meeting?.createdAt, meeting?.date, meeting?.id, meeting?.title, recordingStorageScope, transcript]);

  useEffect(() => {
    if (route.params.focus === 'summary') {
      setTabGeneration(value => {
        const next = value + 1;
        tabOwnerRef.current.accept({ meetingId: route.params.meetingId, tab: 'summary', generation: next });
        return next;
      });
      setActiveTab('summary');
    }
    if (route.params.focus === 'transcript') {
      setTabGeneration(value => {
        const next = value + 1;
        tabOwnerRef.current.accept({ meetingId: route.params.meetingId, tab: 'transcript', generation: next });
        return next;
      });
      setActiveTab('transcript');
    }
  }, [route.params.focus, route.params.meetingId]);

  const runShare = useCallback(async (kind: MeetingShareKind) => {
    if (!meeting || sharing) return;
    setSharing(true);
    try {
      await shareMeetingArtifact(kind, {
        meeting,
        transcriptLines: transcript,
        summaryText: summary || meetingSummaryToText(getCachedSummary(meeting.id)),
        isGuest,
        accessToken,
      });
    } catch (reason) {
      showDialog({ title: '分享失败', message: meetingShareErrorMessage(reason), tone: 'error' });
    } finally {
      if (mountedRef.current) setSharing(false);
    }
  }, [accessToken, getCachedSummary, isGuest, meeting, sharing, showDialog, summary, transcript]);

  const confirmDelete = useCallback(() => {
    if (!meeting) return;
    showDialog({
      title: '确认删除',
      message: '确定要删除这条会议记录吗？',
      tone: 'danger',
      actions: [
        {
          text: '删除',
          role: 'destructive',
          onPress: async () => {
            try {
              await deleteMeeting(meeting.id);
              openMeetingsTab(navigation);
            } catch (reason) {
              if (reason instanceof MeetingDeletionCleanupError) {
                openMeetingsTab(navigation);
                showDialog({
                  title: '会议已删除，清理未完成',
                  message: readableErrorMessage(reason, '会议已删除，但本机清理尚未完成。'),
                  tone: 'warning',
                });
              } else {
                showDialog({
                  title: '删除失败',
                  message: readableErrorMessage(reason, '请检查网络后重试。'),
                  tone: 'error',
                });
              }
            }
          },
        },
        { text: '取消', role: 'cancel' },
      ],
    });
  }, [deleteMeeting, meeting, navigation, showDialog]);

  const manageSpeaker = useCallback((speakerId?: string) => {
    if (isGuest || !accessToken) {
      showDialog({ title: '登录后管理讲话人', message: '游客会议保留转写中的讲话人标签，但不上传声纹资料。', tone: 'info' });
      return;
    }
    if (speakerId && speakerId !== 'unknown') {
      navigation.navigate('SpeakerEnrollment', { speakerId });
    } else {
      navigation.navigate('SpeakerManager');
    }
  }, [accessToken, isGuest, navigation, showDialog]);

  const handleAction = useCallback((action: MinutesSemanticAction) => {
    switch (action.type) {
      case 'back':
        navigation.goBack();
        break;
      case 'share':
        void runShare('document');
        break;
      case 'more':
        if (meeting) setMoreVisible(true);
        break;
      case 'saveTitle':
        if (!meeting || action.meetingId !== meeting.id) break;
        void updateMeetingTitle(meeting.id, action.title).catch(() => {
          showDialog({ title: '保存失败', message: '会议标题更新失败，请稍后重试。', tone: 'error' });
        });
        break;
      case 'selectDetailTab':
        if (action.meetingId !== route.params.meetingId) break;
        if (action.selectionGeneration < tabOwnerRef.current.current().generation) break;
        if (!tabOwnerRef.current.accept({
          meetingId: action.meetingId,
          tab: action.tab,
          generation: action.selectionGeneration,
        })) break;
        setTabGeneration(action.selectionGeneration);
        setActiveTab(action.tab);
        break;
      case 'retryDetailContent':
        if (action.meetingId !== route.params.meetingId) break;
        const retryPlan = nativeMinutesDetailRetryPlan(action.tab, Boolean(summary));
        if (retryPlan.kind === 'generateSummary') {
          void runSummaryTask({ forceRegenerate: retryPlan.forceRegenerate });
        } else {
          setReloadKey(value => value + 1);
        }
        break;
      case 'generateSummary':
        if (action.meetingId !== route.params.meetingId) break;
        void runSummaryTask({ forceRegenerate: Boolean(summary) });
        break;
      case 'manageSpeaker':
        manageSpeaker(action.speakerId);
        break;
      default:
        break;
    }
  }, [manageSpeaker, meeting, navigation, route.params.meetingId, runShare, showDialog, summary]);

  const snapshot = useMemo(() => buildNativeMinutesDetailSnapshot({
    meetingId: meeting?.id ?? route.params.meetingId,
    available: Boolean(meeting),
    title: meeting?.title ?? '会议记录不存在',
    dateTimeLabel: meeting ? compactMeetingDateTime(meeting.date, meeting.time) : '',
    activeTab,
    tabGeneration,
    activeTabIsExplicit: route.params.focus === 'summary' || route.params.focus === 'transcript',
    transcript,
    summaryText: summary,
    transcriptLoading: Boolean(meeting && loadingTranscript),
    summaryLoading: Boolean(meeting && loadingSummary),
    transcriptError: meeting ? transcriptError : '请返回会议列表后重新打开。',
    summaryError,
    summaryProgress,
    canShare: Boolean(meeting && !sharing),
    canManageSpeakers: Boolean(meeting && !isGuest && accessToken),
    canGenerateSummary: Boolean(meeting && transcript.length > 0),
    summaryGenerating: loadingSummary,
    titleEditRequestId: route.params.focus === 'title' ? 1 : 0,
    pageGenerations,
    pageCached: {
      transcript: transcriptCached,
      summary: summaryCached,
      speakers: transcriptCached,
    },
    playerSource,
    audioStatusMessage: loadingAudio ? '正在加载录音' : (!playerSource ? '仅有转写，无录音文件' : ''),
    audioErrorMessage: pendingAudioError || playerSourceError,
  }), [accessToken, activeTab, isGuest, loadingAudio, loadingSummary, loadingTranscript, meeting, pageGenerations, pendingAudioError, playerSource, playerSourceError, route.params.focus, route.params.meetingId, sharing, summary, summaryCached, summaryError, summaryProgress, tabGeneration, transcript, transcriptCached, transcriptError]);

  const moreItems = useMemo<AppActionSheetItem[]>(() => {
    if (!meeting) return [];
    return [
      ...(!isGuest && accessToken
        ? [{ key: 'speakers', label: '管理讲话人', onPress: () => manageSpeaker() }]
        : []),
      ...(pendingAudioUpload
        ? [{
            key: 'retry-upload',
            label: retryingAudioUpload ? '录音正在后台同步' : '重试录音同步',
            disabled: retryingAudioUpload,
            onPress: () => { void performPendingAudioUpload(pendingAudioUpload, true); },
          }]
        : []),
      { key: 'delete', label: '删除会议', destructive: true, onPress: confirmDelete },
    ];
  }, [accessToken, confirmDelete, isGuest, manageSpeaker, meeting, pendingAudioUpload, performPendingAudioUpload, retryingAudioUpload]);

  return (
    <ScreenContainer edges={['top', 'bottom']} bg="#FFFFFF">
      <View
        style={styles.root}
        testID="meeting-detail-native-root"
        collapsable={false}
        collapsableChildren={false}
      >
        <LaojiMinutesView
          style={styles.surface}
          surface="detail"
          snapshot={snapshot}
          onMinutesAction={event => handleAction(event.nativeEvent)}
          testID="meeting-detail-native-surface"
        />
      </View>
      <AppActionSheet
        visible={moreVisible}
        title={meeting?.title ?? '会议记录'}
        items={moreItems}
        onClose={() => setMoreVisible(false)}
      />
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  surface: { flex: 1 },
});
