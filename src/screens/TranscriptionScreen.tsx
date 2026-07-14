import React, { useCallback, useState, useEffect, useRef } from 'react';
import { View, Text, TextInput, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { Colors as C } from '../theme/colors';
import { ScreenContainer } from '../components/ScreenContainer';

import { RootStackParamList, TranscriptLine } from '../types';
import { useMeetings } from '../store/MeetingsStore';
import { fetchMeetingTranscript, fetchMeetingSummary, uploadMeetingAudio } from '../services/api';
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
  shouldDiscardPendingMeetingSummaryTask,
} from '../services/meetingSummary';
import {
  clearPendingMeetingSummaryTask,
  getPendingMeetingSummaryTask,
  meetingSummaryInputFingerprint,
  PendingMeetingSummaryTask,
  savePendingMeetingSummaryTask,
} from '../services/meetingSummaryTasks';
import { MeetingShareKind, meetingShareErrorMessage, shareMeetingArtifact } from '../services/meetingShare';
import { BackHeader, Waveform } from '../components/Common';
import { BottomTabBar, BOTTOM_TAB_BAR_GEOMETRY } from '../components/BottomTabBar';
import { openMeetingsTab, openScheduleTab } from '../navigation/tabTargets';
import { formatDuration, transcriptDurationSec } from '../utils/meetingMedia';
import { useAppDialog } from '../components/AppDialog';
import { useAuth } from '../store/AuthStore';
import { readableErrorMessage } from '../services/errors';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Transcription'>;
  route: RouteProp<RootStackParamList, 'Transcription'>;
};

function SCard({ num, title, badge, children }: {
  num: number; title: string; badge?: string; children: React.ReactNode;
}) {
  return (
    <View style={s.scard}>
      <View style={s.scardHeader}>
        <View style={s.numCircle}>
          <Text style={s.numText}>{num}</Text>
        </View>
        <Text style={s.scardTitle}>{title}</Text>
        {badge && (
          <View style={s.badge}>
            <Text style={s.badgeText}>{badge}</Text>
          </View>
        )}
      </View>
      {children}
    </View>
  );
}

export function TranscriptionScreen({ navigation, route }: Props) {
  const {
    meetings,
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
  const [titleEdit, setTitleEdit] = useState(m?.title ?? '');
  const [transcriptItems, setTranscriptItems] = useState<TranscriptLine[]>([]);
  const [summary, setSummary] = useState('');
  const [loadingTranscript, setLoadingTranscript] = useState(false);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [transcriptExpanded, setTranscriptExpanded] = useState(false);
  const [transcriptError, setTranscriptError] = useState('');
  const [summaryError, setSummaryError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [summaryProgress, setSummaryProgress] = useState('正在提交总结任务');
  const [titleSaving, setTitleSaving] = useState(false);
  const [sharing, setSharing] = useState(false);
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
  const mountedRef = useRef(true);
  const scrollRef = useRef<ScrollView | null>(null);
  const titleInputRef = useRef<TextInput | null>(null);
  const titleYRef = useRef<number | null>(null);
  const transcriptYRef = useRef<number | null>(null);
  const summaryYRef = useRef<number | null>(null);
  const focusHandledRef = useRef(false);
  const recordingStorageScope = isGuest ? 'guest' : session ? `user:${session.user.id}` : 'signed_out';

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
          setPendingAudioError(stillPending?.failureMessage ?? '');
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
            setPendingAudioError(stillPending?.failureMessage ?? '自动同步未完成，录音仍保存在本机');
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
            message: latest?.failureMessage ?? '录音仍保存在本机，可稍后再次重试。',
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
    if (m) setTitleEdit(m.title);
  }, [m?.id, m?.title]);

  useEffect(() => {
    setTranscriptExpanded(false);
  }, [m?.id]);

  useEffect(() => {
    if (!m) return;
    let alive = true;
    const cachedTranscript = getCachedTranscript(m.id);
    const cachedSummary = meetingSummaryToText(getCachedSummary(m.id));
    setTranscriptItems(cachedTranscript);
    setSummary(cachedSummary);
    setTranscriptError('');
    setSummaryError('');

    setLoadingTranscript(true);
    if (isGuest || !accessToken) {
      setLoadingTranscript(false);
    } else {
      fetchMeetingTranscript(m.id, accessToken, { fallbackItems: cachedTranscript })
        .then(items => {
          if (!alive) return;
          if (items.length > 0) {
            setTranscriptItems(items);
            void saveCachedTranscript(m.id, items).catch(() => {
              if (alive) setTranscriptError('转写已同步，但本机缓存写入失败。');
            });
          }
        })
        .catch(() => { if (alive) setTranscriptError('转写同步失败，当前显示本机缓存。'); })
        .finally(() => { if (alive) setLoadingTranscript(false); });
    }

    if (m.hasSummary && !isGuest && accessToken) {
      setLoadingSummary(true);
      setSummaryProgress('正在同步总结');
      fetchMeetingSummary(m.id, accessToken)
        .then(text => {
          if (!alive) return;
          setSummary(text || cachedSummary);
          if (text) {
            void saveCachedSummary(m.id, {
              meeting_id: m.id,
              full_text: text,
              generated_at: new Date().toISOString(),
            }).catch(() => {
              if (alive) setSummaryError('总结已同步，但本机缓存写入失败。');
            });
          }
        })
        .catch(() => { if (alive) setSummaryError('总结同步失败，可重试或重新生成。'); })
        .finally(() => { if (alive) setLoadingSummary(false); });
    }
    return () => { alive = false; };
  }, [
    accessToken,
    getCachedSummary,
    getCachedTranscript,
    isGuest,
    m?.hasSummary,
    m?.id,
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
      setPendingAudioError(pending?.failureMessage ?? '');
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
    focusHandledRef.current = false;
  }, [m?.id, route.params.focus]);

  useEffect(() => {
    autoResumeTaskRef.current = '';
  }, [m?.id, recordingStorageScope]);

  function runSummaryTask(options: {
    automatic?: boolean;
    forceRegenerate?: boolean;
    resumeTask?: PendingMeetingSummaryTask | null;
    transcriptLines?: TranscriptLine[];
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
    const inputFingerprint = meetingSummaryInputFingerprint(lines, currentMeeting.title, meetingDate);
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
        if (pending && (pending.mode !== expectedMode || pending.inputFingerprint !== inputFingerprint)) {
          await clearPendingMeetingSummaryTask(recordingStorageScope, currentMeeting.id).catch(() => {});
          pending = null;
        }
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
            try {
              await savePendingMeetingSummaryTask(recordingStorageScope, {
                meetingId: currentMeeting.id,
                taskId,
                mode: expectedMode,
                inputFingerprint,
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

  useEffect(() => {
    if (!m || loadingTranscript || loadingSummary || summaryInFlightRef.current) return;
    const lines = transcriptItems;
    if (lines.length === 0) return;
    let alive = true;
    const meetingDate = meetingDateForSummary(m.date, m.createdAt);
    const fingerprint = meetingSummaryInputFingerprint(lines, m.title, meetingDate);
    const expectedMode = isGuest ? 'guest' : 'authenticated';
    void getPendingMeetingSummaryTask(recordingStorageScope, m.id).then(pending => {
      if (!alive || !pending || autoResumeTaskRef.current === pending.taskId) return;
      if (pending.mode !== expectedMode || pending.inputFingerprint !== fingerprint) {
        void clearPendingMeetingSummaryTask(recordingStorageScope, m.id).catch(() => {});
        return;
      }
      autoResumeTaskRef.current = pending.taskId;
      void runSummaryTask({ automatic: true, resumeTask: pending, transcriptLines: lines });
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

  const scrollToRequestedSection = () => {
    if (focusHandledRef.current) return;
    const target = route.params.focus === 'title'
      ? titleYRef.current
      : route.params.focus === 'summary'
      ? summaryYRef.current
      : route.params.focus === 'transcript'
        ? transcriptYRef.current
        : null;
    if (target == null) return;
    focusHandledRef.current = true;
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ y: Math.max(0, target - 10), animated: true });
      if (route.params.focus === 'title') {
        requestAnimationFrame(() => titleInputRef.current?.focus());
      }
    });
  };

  if (!m) {
    return (
      <ScreenContainer edges={['top']}>
        <BackHeader title="会议转写" onBack={() => navigation.goBack()} />
        <View style={s.emptyWrap}>
          <Text style={s.emptyTitle}>会议记录不存在</Text>
          <Text style={s.emptyText}>请返回会议列表后重新打开。</Text>
        </View>
        <BottomTabBar
          active="meetings"
          onSchedule={() => openScheduleTab(navigation)}
          onMeetings={() => openMeetingsTab(navigation)}
          onMic={() => navigation.navigate('MeetingLive')}
        />
      </ScreenContainer>
    );
  }

  const transcriptionText = transcriptItems.length > 0
    ? transcriptItems.map(t => `[${t.speaker_label ?? t.speaker_id ?? '发言人'}] ${t.text}`).join('\n')
    : '暂无转写内容';
  const recordingBars = m.audioBars ?? [];
  const transcriptDuration = formatDuration(transcriptDurationSec(transcriptItems));
  const recordingDuration = m.audioDurationSec
    ? formatDuration(m.audioDurationSec)
    : m.duration && m.duration !== '—'
      ? m.duration
      : transcriptDuration;

  const commitTitle = async () => {
    const t = titleEdit.trim();
    if (!t) {
      setTitleEdit(m.title);
      showDialog({ title: '标题不能为空', message: '已恢复原会议标题。', tone: 'warning' });
      return;
    }
    if (t === m.title || titleSaving) return;
    setTitleSaving(true);
    try {
      await updateMeetingTitle(m.id, t);
    } catch {
      showDialog({ title: '保存失败', message: '会议标题更新失败，请稍后重试', tone: 'error' });
    } finally {
      setTitleSaving(false);
    }
  };

  const handleRetryAudioUpload = () => {
    if (!pendingAudioUpload || retryingAudioUpload) return;
    void performPendingAudioUpload(pendingAudioUpload, true);
  };

  const handleGenerateSummary = () => runSummaryTask({ forceRegenerate: Boolean(summary) });

  const runMeetingShare = async (kind: MeetingShareKind) => {
    if (sharing) return;
    setSharing(true);
    try {
      await shareMeetingArtifact(kind, {
        meeting: m,
        transcriptLines: transcriptItems,
        summaryText: summary || meetingSummaryToText(getCachedSummary(m.id)),
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
    const audioAvailable = Boolean(m.audioAvailable || m.audioLocalUri);
    showDialog({
      title: '分享会议文件',
      icon: 'share-outline',
      actions: [
        { text: '完整资料包', role: 'primary', onPress: () => runMeetingShare('bundle') },
        { text: '会议文档', role: 'secondary', onPress: () => runMeetingShare('document') },
        ...(audioAvailable
          ? [{ text: '录音文件', role: 'secondary' as const, onPress: () => runMeetingShare('audio') }]
          : []),
        { text: '取消', role: 'cancel' },
      ],
    });
  };

  return (
    <ScreenContainer edges={['top']}>
      <BackHeader
        title="会议转写"
        onBack={() => navigation.goBack()}
        right={sharing
          ? <ActivityIndicator size="small" color={C.purple} />
          : <TouchableOpacity
            onPress={openShareMenu}
            hitSlop={{ top:8,bottom:8,left:8,right:8 }}
            accessibilityRole="button"
            accessibilityLabel="分享会议资料"
            testID="meeting-share-menu"
          >
            <Ionicons name="share-outline" size={20} color={C.sub} />
          </TouchableOpacity>}
      />
      <ScrollView
        ref={scrollRef}
        style={s.scroll}
        contentContainerStyle={s.content}
        showsVerticalScrollIndicator={false}
        onContentSizeChange={scrollToRequestedSection}
      >

        <SCard num={1} title="日期">
          <Text style={s.bodyText}>{[m.date, m.time].filter(Boolean).join('　')}</Text>
        </SCard>

        <SCard num={2} title="录音">
          <View style={s.miniPlayer}>
            <TouchableOpacity
              style={s.miniPlayBtn}
              onPress={() => navigation.navigate('Recording', { meetingId: m.id })}
              activeOpacity={0.8}
              testID="meeting-audio-open"
              accessibilityLabel={m.audioAvailable || m.audioLocalUri ? '打开会议录音' : '查看会议录音状态'}
            >
              <Ionicons name={m.audioAvailable || m.audioLocalUri ? 'play' : 'mic-off-outline'} size={14} color="#fff" />
            </TouchableOpacity>
            <View style={{ flex: 1 }}>
              {recordingBars.length > 0 ? (
                <Waveform bars={recordingBars} color={C.purple} height={28} />
              ) : (
                <Text style={s.noWaveText}>暂无波形数据</Text>
              )}
            </View>
            <View style={s.miniTime}>
              <Text style={s.miniTimeText}>00:00</Text>
              <Text style={s.miniTimeText}>{recordingDuration}</Text>
            </View>
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
                  ? <ActivityIndicator size="small" color={C.purple} />
                  : <Ionicons name="refresh" size={16} color={C.purple} />}
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
                <Ionicons name="refresh" size={16} color={C.purple} />
              </TouchableOpacity>
            </View>
          ) : null}
        </SCard>

        <View
          onLayout={event => {
            titleYRef.current = event.nativeEvent.layout.y;
            scrollToRequestedSection();
          }}
        >
          <SCard num={3} title="录音标题">
            <View style={s.titleField}>
              <TextInput
                ref={titleInputRef}
                style={[s.titleFieldText, { flex: 1, padding: 0 }]}
                value={titleEdit}
                onChangeText={setTitleEdit}
                onBlur={commitTitle}
                onSubmitEditing={commitTitle}
                editable={!titleSaving}
                returnKeyType="done"
                accessibilityLabel="会议标题"
              />
              <Ionicons name="pencil-outline" size={14} color={C.sub} />
            </View>
          </SCard>
        </View>

        <View
          onLayout={event => {
            transcriptYRef.current = event.nativeEvent.layout.y;
            scrollToRequestedSection();
          }}
        >
          <SCard num={4} title="转写文本">
            {transcriptError ? (
              <TouchableOpacity style={s.syncWarning} onPress={() => setReloadKey(value => value + 1)}>
                <Ionicons name="cloud-offline-outline" size={15} color={C.red} />
                <Text style={s.syncWarningText}>{transcriptError}</Text>
                <Text style={s.retryText}>重试</Text>
              </TouchableOpacity>
            ) : null}
            {loadingTranscript && transcriptItems.length === 0 ? (
              <ActivityIndicator size="small" color={C.purple} style={s.inlineLoading} />
            ) : (
              <>
                {transcriptItems.length > 0 ? (
                  <View style={s.transcriptMetaRow}>
                    <Text style={s.transcriptMeta}>共 {transcriptItems.length} 段 · {transcriptDuration}</Text>
                    <TouchableOpacity
                      style={s.transcriptToggle}
                      onPress={() => setTranscriptExpanded(value => !value)}
                      accessibilityRole="button"
                      accessibilityLabel={transcriptExpanded ? '收起完整转写' : '展开完整转写'}
                      accessibilityState={{ expanded: transcriptExpanded }}
                    >
                      <Text style={s.transcriptToggleText}>{transcriptExpanded ? '收起' : '展开全文'}</Text>
                      <Ionicons
                        name={transcriptExpanded ? 'chevron-up' : 'chevron-down'}
                        size={14}
                        color={C.purple}
                      />
                    </TouchableOpacity>
                  </View>
                ) : null}
                <Text
                  style={s.transcript}
                  numberOfLines={transcriptExpanded ? 0 : 6}
                  ellipsizeMode="tail"
                  testID="meeting-transcript-text"
                >
                  {transcriptionText}
                </Text>
              </>
            )}
          </SCard>
        </View>

        <View
          onLayout={event => {
            summaryYRef.current = event.nativeEvent.layout.y;
            scrollToRequestedSection();
          }}
        >
          <SCard num={5} title="AI 会议总结" badge="AI 生成">
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
                <ActivityIndicator size="small" color={C.purple} />
                <Text style={s.summaryLoadingText}>{summaryProgress}</Text>
                {summaryAbortRef.current ? (
                  <TouchableOpacity onPress={() => summaryAbortRef.current?.abort()} style={s.stopWaitingBtn}>
                    <Text style={s.stopWaitingText}>停止等待</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            ) : summary ? (
              <Text style={s.summaryText}>{summary}</Text>
            ) : (
              <Text style={s.emptyText}>{m.hasSummary ? '暂无总结内容' : '该会议暂未生成总结'}</Text>
            )}
            {!loadingSummary && transcriptItems.length > 0 ? (
              <TouchableOpacity
                style={[s.generateBtn, summary && s.regenerateBtn]}
                onPress={handleGenerateSummary}
                activeOpacity={0.84}
                accessibilityRole="button"
                accessibilityLabel={summary ? '重新生成会议总结' : '生成会议总结'}
              >
                <Ionicons name="sparkles-outline" size={14} color={summary ? C.purple : '#fff'} />
                <Text style={[s.generateText, summary && s.regenerateText]}>{summary ? '重新生成' : '生成总结'}</Text>
              </TouchableOpacity>
            ) : null}
          </SCard>
        </View>

        <View style={{ height: 16 }} />
      </ScrollView>
      <BottomTabBar
        active="meetings"
        onSchedule={() => openScheduleTab(navigation)}
        onMeetings={() => openMeetingsTab(navigation)}
        onMic={() => navigation.navigate('MeetingLive')}
      />
    </ScreenContainer>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.appBg },
  scroll: { flex: 1 },
  content: { padding: 14, paddingBottom: BOTTOM_TAB_BAR_GEOMETRY.scrollContentClearance },
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  emptyTitle: { fontSize: 17, fontWeight: '700', color: C.text, marginBottom: 8 },
  emptyText: { fontSize: 13, color: C.sub, lineHeight: 20 },
  scard: {
    backgroundColor: C.card, borderRadius: 16, padding: 14, paddingHorizontal: 16, marginBottom: 12,
    shadowColor: '#5028A0', shadowOffset: { width:0,height:1 }, shadowOpacity:0.05, shadowRadius:8, elevation:2,
  },
  scardHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  numCircle: { width: 22, height: 22, borderRadius: 11, backgroundColor: C.purpleDark, alignItems: 'center', justifyContent: 'center' },
  numText: { fontSize: 11, fontWeight: '700', color: '#fff' },
  scardTitle: { fontSize: 14, fontWeight: '700', color: C.text },
  badge: { backgroundColor: '#FFE8F0', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 1 },
  badgeText: { fontSize: 10, color: C.pink, fontWeight: '600' },
  bodyText: { fontSize: 14, color: C.text },
  miniPlayer: { backgroundColor: C.purpleLight, borderRadius: 12, padding: 12, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 12 },
  miniPlayBtn: { width: 32, height: 32, borderRadius: 16, backgroundColor: C.purple, alignItems: 'center', justifyContent: 'center' },
  miniTime: { alignItems: 'flex-end' },
  miniTimeText: { fontSize: 11, color: C.sub },
  noWaveText: { fontSize: 11, color: C.faint, textAlign: 'center' },
  uploadPending: { minHeight: 42, marginTop: 10, borderRadius: 10, backgroundColor: '#FFF6E8', paddingLeft: 11, paddingRight: 5, flexDirection: 'row', alignItems: 'center', gap: 8 },
  uploadPendingText: { flex: 1, fontSize: 11, lineHeight: 16, color: C.sub, fontWeight: '600' },
  uploadRetryButton: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  titleField: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#F6F2FF', borderRadius: 10, padding: 10, paddingHorizontal: 14 },
  titleFieldText: { fontSize: 14, fontWeight: '500', color: C.text },
  transcript: { fontSize: 13, color: '#4A4666', lineHeight: 26 },
  transcriptMetaRow: { minHeight: 34, marginBottom: 6, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  transcriptMeta: { fontSize: 11, color: C.sub, fontWeight: '600' },
  transcriptToggle: { minHeight: 34, paddingLeft: 12, flexDirection: 'row', alignItems: 'center', gap: 3 },
  transcriptToggleText: { fontSize: 11, color: C.purple, fontWeight: '800' },
  summaryText: { fontSize: 13, color: '#4A4666', lineHeight: 26 },
  inlineLoading: { marginVertical: 10 },
  syncWarning: { minHeight: 40, borderRadius: 10, backgroundColor: '#FFF3F3', flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 10, marginBottom: 10 },
  syncWarningText: { flex: 1, fontSize: 11, lineHeight: 16, color: C.red },
  retryText: { fontSize: 11, color: C.purple, fontWeight: '800' },
  summaryLoading: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 9 },
  summaryLoadingText: { flex: 1, fontSize: 12, color: C.sub, fontWeight: '600' },
  stopWaitingBtn: { minHeight: 32, justifyContent: 'center', paddingHorizontal: 10, borderRadius: 8, backgroundColor: C.purpleLight },
  stopWaitingText: { fontSize: 11, color: C.purple, fontWeight: '800' },
  generateBtn: { marginTop: 12, alignSelf: 'flex-start', height: 34, borderRadius: 17, paddingHorizontal: 14, backgroundColor: C.purple, flexDirection: 'row', alignItems: 'center', gap: 6 },
  generateText: { fontSize: 12, color: '#fff', fontWeight: '800' },
  regenerateBtn: { backgroundColor: C.purpleLight },
  regenerateText: { color: C.purple },
});
