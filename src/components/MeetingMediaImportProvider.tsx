import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  acknowledgeIngestedMeetingMedia,
  acknowledgeMeetingMediaImportIntent,
  addMeetingMediaImportIntentListener,
  getPendingMeetingMediaImportIntent,
  hasNativeMeetingMediaImport,
  ingestMeetingMedia,
  inspectMeetingMediaSource,
  pickMeetingMedia,
  recoverPendingMeetingMediaImports,
  type IngestedMeetingMedia,
  type MeetingMediaImportOrigin,
  type PendingMeetingMediaImportIntent,
} from 'laoji-native-platform';
import { secureClientIdFactory, type ScopeKey } from '../domain/meeting';
import { recoverPreparedMeetingRecordingMerge } from '../application/meeting';
import { getFeatureFlags } from '../config/featureFlags';
import { loadMeetingCapabilities } from '../data/api/v2';
import { navigationRef } from '../navigation/notificationNavigation';
import { useAuth } from '../store/AuthStore';
import { useEvents } from '../store/EventsStore';
import { useMeetings } from '../store/MeetingsStore';
import {
  isMeetingMediaPickerCancellation,
  LOCAL_MEETING_MEDIA_IMPORT_MAX_BYTES,
  meetingMediaImportErrorMessage,
  meetingMediaIntentErrorMessage,
  suggestedMeetingTitleFromFileName,
} from '../services/meetingMediaImport';
import {
  deleteMeetingMediaImportDraft,
  loadMeetingMediaImportDraft,
  saveMeetingMediaImportDraft,
  type MeetingMediaImportDraft,
} from '../services/meetingMediaImportDrafts';
import {
  calendarMeetingContext,
  resolveOccurrenceMeeting,
} from '../services/occurrenceMeeting';
import { eventRefForEvent } from '../utils/eventIdentity';
import { useAppDialog } from './AppDialog';
import { MeetingImportSheet, type MeetingImportDraft } from './MeetingImportSheet';

interface MeetingMediaImportContextValue {
  busy: boolean;
  selectMeetingMedia: () => Promise<void>;
}

const MeetingMediaImportContext = createContext<MeetingMediaImportContextValue | null>(null);

type ImportSource = {
  uri: string;
  fileName: string | null;
  byteSize: number | null;
  lastModifiedMs: number | null;
  receivedAtMs: number | null;
  origin: MeetingMediaImportOrigin;
  mimeType?: string | null;
  maximumBytes?: number;
  intentToken?: string;
  meetingId?: string;
  assetId?: string;
  readyMedia?: IngestedMeetingMedia;
};

type ImportRequest = ImportSource & {
  draft: MeetingMediaImportDraft;
};

type ImportConfirmation = {
  source: ImportSource;
  initialTitle: string;
  initialRecordedAtMs: number;
};

function defaultRecordedAtMs(source: Pick<ImportSource, 'lastModifiedMs' | 'receivedAtMs'>): number {
  const nowMs = Date.now();
  const candidate = source.lastModifiedMs ?? source.receivedAtMs;
  return candidate && candidate > 0 && candidate <= nowMs + 60_000 ? candidate : nowMs;
}

function navigateToMeeting(meetingId: string): void {
  if (!navigationRef.isReady()) return;
  navigationRef.navigate('Transcription', { meetingId });
}

export function MeetingMediaImportProvider({ children }: { children: React.ReactNode }) {
  const { accessToken, initializing, mode, session } = useAuth();
  const { searchableEvents } = useEvents();
  const { importMeetingMedia, meetings } = useMeetings();
  const { showDialog } = useAppDialog();
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<ImportConfirmation | null>(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const promptActiveRef = useRef(false);
  const recoveryRunningRef = useRef(false);
  const recoveryGenerationRef = useRef(0);
  const activeIntentTokenRef = useRef<string | null>(null);
  const handledIntentTokensRef = useRef(new Set<string>());
  const runImportRef = useRef<(source: ImportRequest) => Promise<void>>(async () => {});
  const handleIntentRef = useRef<(intent: PendingMeetingMediaImportIntent) => void>(() => {});
  const drainIntentInboxRef = useRef<() => void>(() => {});
  const scopeKey = useMemo<ScopeKey | null>(() => {
    if (mode === 'guest') return 'guest';
    if (mode === 'authenticated' && session) return `user:${session.user.id}`;
    return null;
  }, [mode, session]);

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  const setImportBusy = useCallback((value: boolean) => {
    busyRef.current = value;
    if (mountedRef.current) setBusy(value);
  }, []);

  const releasePrompt = useCallback(() => {
    promptActiveRef.current = false;
    drainIntentInboxRef.current();
  }, []);

  const finishIntent = useCallback(async (token: string) => {
    let acknowledged = false;
    for (let attempt = 0; attempt < 2 && !acknowledged; attempt += 1) {
      acknowledged = await acknowledgeMeetingMediaImportIntent(token).catch(() => false);
    }
    const firstPending = acknowledged
      ? null
      : await getPendingMeetingMediaImportIntent().catch(() => null);
    const remainsAtHead = firstPending?.token === token;
    if (activeIntentTokenRef.current === token) activeIntentTokenRef.current = null;
    promptActiveRef.current = false;
    if (!remainsAtHead) handledIntentTokensRef.current.delete(token);
    drainIntentInboxRef.current();
  }, []);

  const persistIngestedMedia = useCallback(async (
    media: IngestedMeetingMedia,
    draft: MeetingMediaImportDraft,
  ) => {
    const meeting = await importMeetingMedia(media, {
      title: draft.title,
      recordedAtMs: draft.recordedAtMs,
      calendarContext: draft.calendarContext,
      targetMeetingId: draft.targetMeetingId,
    });
    const acknowledged = await acknowledgeIngestedMeetingMedia(media.meetingId, media.assetId);
    if (acknowledged) await deleteMeetingMediaImportDraft(media.meetingId);
    return meeting;
  }, [importMeetingMedia]);

  const runImport = useCallback(async (source: ImportRequest) => {
    if (busyRef.current) {
      return;
    }
    const request = {
      ...source,
      meetingId: source.meetingId ?? secureClientIdFactory.create(),
      assetId: source.assetId ?? secureClientIdFactory.create(),
    };
    promptActiveRef.current = false;
    setImportBusy(true);
    let copied = Boolean(source.readyMedia);
    let ingestedMedia = source.readyMedia ?? null;
    try {
      await saveMeetingMediaImportDraft(request.meetingId, request.draft);
      const media = source.readyMedia ?? await ingestMeetingMedia({
        sourceUri: request.uri,
        meetingId: request.meetingId,
        assetId: request.assetId,
        origin: request.origin,
        maximumBytes: Math.min(
          LOCAL_MEETING_MEDIA_IMPORT_MAX_BYTES,
          request.maximumBytes ?? LOCAL_MEETING_MEDIA_IMPORT_MAX_BYTES,
        ),
      });
      ingestedMedia = media;
      copied = true;
      const meeting = await persistIngestedMedia(media, request.draft);
      if (request.intentToken) await finishIntent(request.intentToken);
      else releasePrompt();
      navigateToMeeting(meeting.id);
    } catch (reason) {
      promptActiveRef.current = true;
      const code = reason && typeof reason === 'object'
        ? (reason as { code?: unknown }).code
        : null;
      const closeFailure = () => {
        void (async () => {
          if (!copied) await deleteMeetingMediaImportDraft(request.meetingId).catch(() => {});
          if (request.intentToken) await finishIntent(request.intentToken);
          else releasePrompt();
        })();
      };
      const chooseAnotherTarget = () => {
        if (!ingestedMedia) {
          closeFailure();
          return;
        }
        promptActiveRef.current = true;
        setConfirmation({
          source: {
            uri: ingestedMedia.localUri,
            fileName: ingestedMedia.fileName,
            byteSize: ingestedMedia.byteSize,
            lastModifiedMs: ingestedMedia.sourceLastModifiedMs,
            receivedAtMs: null,
            origin: request.origin,
            mimeType: ingestedMedia.mimeType,
            maximumBytes: request.maximumBytes,
            intentToken: request.intentToken,
            meetingId: ingestedMedia.meetingId,
            assetId: ingestedMedia.assetId,
            readyMedia: ingestedMedia,
          },
          initialTitle: request.draft.title,
          initialRecordedAtMs: request.draft.recordedAtMs,
        });
      };
      showDialog({
        title: '导入失败',
        message: copied
          ? `录音已保存在本机。${meetingMediaImportErrorMessage(reason)}`
          : meetingMediaImportErrorMessage(reason),
        tone: 'error',
        onDismiss: closeFailure,
        actions: [
          {
            text: code === 'ERR_MEDIA_IMPORT_TARGET_UNAVAILABLE' ? '重新选择' : '重试',
            role: 'primary',
            onPress: code === 'ERR_MEDIA_IMPORT_TARGET_UNAVAILABLE' ? chooseAnotherTarget : () => {
              promptActiveRef.current = false;
              void runImportRef.current(request);
            },
          },
          {
            text: copied ? '稍后处理' : '关闭',
            role: 'cancel',
            onPress: closeFailure,
          },
        ],
      });
    } finally {
      setImportBusy(false);
      drainIntentInboxRef.current();
    }
  }, [finishIntent, persistIngestedMedia, releasePrompt, setImportBusy, showDialog]);
  runImportRef.current = runImport;

  const presentImportConfirmation = useCallback((source: ImportSource) => {
    promptActiveRef.current = true;
    setConfirmation({
      source,
      initialTitle: suggestedMeetingTitleFromFileName(source.fileName),
      initialRecordedAtMs: defaultRecordedAtMs(source),
    });
  }, []);

  const closeImportConfirmation = useCallback(() => {
    const source = confirmation?.source;
    setConfirmation(null);
    if (!source) {
      releasePrompt();
      return;
    }
    if (source.intentToken) void finishIntent(source.intentToken);
    else releasePrompt();
  }, [confirmation, finishIntent, releasePrompt]);

  const validateImportDraft = useCallback(async (draft: MeetingImportDraft): Promise<string | null> => {
    if (!scopeKey) return '当前账号状态已变化，请取消后重试。';
    if (draft.targetMeetingId) {
      const target = meetings.find(meeting => meeting.id === draft.targetMeetingId);
      if (!target) return '所选会议已不可用，请重新选择。';
      if (target.status === 'recording' || target.status === 'paused') {
        return '该会议正在录音，请结束录音后再加入。';
      }
      return null;
    }
    if (!Number.isSafeInteger(draft.recordedAtMs) || draft.recordedAtMs < 0) {
      return '录制时间无效，请重新选择。';
    }
    if (draft.recordedAtMs > Date.now() + 60_000) return '录制时间不能晚于当前时间。';
    if (!draft.calendarEvent) return null;
    const existing = await resolveOccurrenceMeeting(
      scopeKey,
      eventRefForEvent(draft.calendarEvent),
    );
    return existing ? '该日程已有会议记录，请选择其他日程或不关联。' : null;
  }, [meetings, scopeKey]);

  const startConfirmedImport = useCallback((draft: MeetingImportDraft) => {
    const current = confirmation;
    if (!current || !scopeKey) {
      setConfirmation(null);
      if (current?.source.intentToken) void finishIntent(current.source.intentToken);
      else releasePrompt();
      return;
    }
    const persistentDraft: MeetingMediaImportDraft = {
      scopeKey,
      title: draft.title,
      recordedAtMs: draft.recordedAtMs,
      calendarContext: !draft.targetMeetingId && draft.calendarEvent
        ? calendarMeetingContext(draft.calendarEvent, scopeKey)
        : null,
      targetMeetingId: draft.targetMeetingId,
    };
    setConfirmation(null);
    promptActiveRef.current = false;
    void runImportRef.current({
      ...current.source,
      meetingId: current.source.readyMedia?.meetingId
        ?? draft.targetMeetingId
        ?? current.source.meetingId,
      draft: persistentDraft,
    });
  }, [confirmation, finishIntent, releasePrompt, scopeKey]);

  const handleIntent = useCallback((intent: PendingMeetingMediaImportIntent) => {
    if (
      initializing
      || mode === 'signed_out'
      || recoveryRunningRef.current
      || busyRef.current
      || promptActiveRef.current
      || activeIntentTokenRef.current !== null
    ) return;
    if (handledIntentTokensRef.current.has(intent.token)) return;
    handledIntentTokensRef.current.add(intent.token);
    activeIntentTokenRef.current = intent.token;
    const message = meetingMediaIntentErrorMessage(intent);
    if (message || !intent.uri) {
      promptActiveRef.current = true;
      const closeInvalidIntent = () => { void finishIntent(intent.token); };
      showDialog({
        title: '无法导入',
        message: message ?? '分享内容中没有可导入的录音文件。',
        tone: 'warning',
        onDismiss: closeInvalidIntent,
        actions: [{
          text: '知道了',
          role: 'primary',
          onPress: closeInvalidIntent,
        }],
      });
      return;
    }
    const present = (maximumBytes = LOCAL_MEETING_MEDIA_IMPORT_MAX_BYTES) => {
      presentImportConfirmation({
        uri: intent.uri!,
        fileName: intent.fileName,
        byteSize: intent.byteSize,
        lastModifiedMs: intent.lastModifiedMs,
        receivedAtMs: intent.receivedAtMs,
        origin: 'share_intent',
        mimeType: intent.mimeType,
        maximumBytes,
        intentToken: intent.token,
      });
    };
    if (!intent.mimeType?.toLowerCase().startsWith('video/')) {
      present();
      return;
    }
    promptActiveRef.current = true;
    void loadMeetingCapabilities({
      accessToken,
      forceRefresh: true,
      allowStaleOnError: false,
    }).then(state => {
      if (activeIntentTokenRef.current !== intent.token) return;
      const mediaImport = state.source === 'remote' ? state.capabilities.mediaImport : null;
      const supported = mediaImport?.mimeTypes.some(
        mimeType => mimeType.toLowerCase() === intent.mimeType?.toLowerCase(),
      );
      if (supported && mediaImport) {
        present(Math.min(LOCAL_MEETING_MEDIA_IMPORT_MAX_BYTES, mediaImport.maxBytes));
        return;
      }
      const closeUnsupportedVideo = () => { void finishIntent(intent.token); };
      showDialog({
        title: '无法导入',
        message: '当前服务暂不支持导入这个视频。',
        tone: 'warning',
        onDismiss: closeUnsupportedVideo,
        actions: [{ text: '知道了', role: 'primary', onPress: closeUnsupportedVideo }],
      });
    }).catch(() => {
      if (activeIntentTokenRef.current !== intent.token) return;
      const closeUnavailableVideo = () => { void finishIntent(intent.token); };
      showDialog({
        title: '无法导入',
        message: '暂时无法确认视频处理能力，请联网后重试。',
        tone: 'warning',
        onDismiss: closeUnavailableVideo,
        actions: [{ text: '知道了', role: 'primary', onPress: closeUnavailableVideo }],
      });
    });
  }, [accessToken, finishIntent, initializing, mode, presentImportConfirmation, showDialog]);
  handleIntentRef.current = handleIntent;

  const drainIntentInbox = useCallback(() => {
    if (
      initializing
      || mode === 'signed_out'
      || recoveryRunningRef.current
      || busyRef.current
      || promptActiveRef.current
      || activeIntentTokenRef.current !== null
      || !hasNativeMeetingMediaImport()
    ) return;
    void getPendingMeetingMediaImportIntent().then(intent => {
      if (intent) handleIntentRef.current(intent);
    }).catch(() => {});
  }, [initializing, mode]);
  drainIntentInboxRef.current = drainIntentInbox;

  useEffect(() => {
    if (!hasNativeMeetingMediaImport()) return undefined;
    const subscription = addMeetingMediaImportIntentListener(intent => {
      handleIntentRef.current(intent);
    });
    drainIntentInboxRef.current();
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (initializing || mode === 'signed_out' || !scopeKey || !hasNativeMeetingMediaImport()) return;
    let cancelled = false;
    const generation = recoveryGenerationRef.current + 1;
    recoveryGenerationRef.current = generation;
    recoveryRunningRef.current = true;
    void recoverPendingMeetingMediaImports().then(async pending => {
      if (pending.length > 0 && !cancelled) setImportBusy(true);
      for (const media of pending) {
        if (cancelled) return;
        try {
          if (media.origin === 'recording_merge') {
            const recovered = await recoverPreparedMeetingRecordingMerge(scopeKey, media);
            if (recovered) {
              await acknowledgeIngestedMeetingMedia(media.meetingId, media.assetId).catch(() => false);
            }
            continue;
          }
          const savedDraft = await loadMeetingMediaImportDraft(media.meetingId);
          if (savedDraft && savedDraft.scopeKey !== scopeKey) {
            promptActiveRef.current = true;
            const closeScopeMismatch = () => releasePrompt();
            showDialog({
              title: '导入尚未完成',
              message: '这条未完成导入属于其他账号，请切换后继续。',
              tone: 'warning',
              onDismiss: closeScopeMismatch,
              actions: [{ text: '知道了', role: 'primary', onPress: closeScopeMismatch }],
            });
            return;
          }
          const draft: MeetingMediaImportDraft = savedDraft ?? {
            scopeKey,
            title: suggestedMeetingTitleFromFileName(media.fileName),
            recordedAtMs: defaultRecordedAtMs({
              lastModifiedMs: media.sourceLastModifiedMs,
              receivedAtMs: null,
            }),
            calendarContext: null,
            targetMeetingId: null,
          };
          await persistIngestedMedia(media, draft);
        } catch (reason) {
          const code = reason && typeof reason === 'object'
            ? (reason as { code?: unknown }).code
            : null;
          if (code === 'ERR_MEDIA_IMPORT_TARGET_UNAVAILABLE' && !cancelled) {
            const savedDraft = await loadMeetingMediaImportDraft(media.meetingId).catch(() => null);
            promptActiveRef.current = true;
            setConfirmation({
              source: {
                uri: media.localUri,
                fileName: media.fileName,
                byteSize: media.byteSize,
                lastModifiedMs: media.sourceLastModifiedMs,
                receivedAtMs: null,
                origin: media.origin as MeetingMediaImportOrigin,
                mimeType: media.mimeType,
                meetingId: media.meetingId,
                assetId: media.assetId,
                readyMedia: media,
              },
              initialTitle: savedDraft?.title ?? suggestedMeetingTitleFromFileName(media.fileName),
              initialRecordedAtMs: savedDraft?.recordedAtMs ?? defaultRecordedAtMs({
                lastModifiedMs: media.sourceLastModifiedMs,
                receivedAtMs: null,
              }),
            });
            return;
          }
          if (!cancelled) {
            promptActiveRef.current = true;
            const closeRecoveryFailure = () => releasePrompt();
            showDialog({
              title: '导入尚未完成',
              message: meetingMediaImportErrorMessage(reason),
              tone: 'warning',
              onDismiss: closeRecoveryFailure,
              actions: [{ text: '知道了', role: 'primary', onPress: closeRecoveryFailure }],
            });
          }
          return;
        }
      }
    }).catch(() => {}).finally(() => {
      if (recoveryGenerationRef.current !== generation) return;
      recoveryRunningRef.current = false;
      setImportBusy(false);
      drainIntentInboxRef.current();
    });
    return () => {
      cancelled = true;
      if (recoveryGenerationRef.current === generation) {
        recoveryGenerationRef.current += 1;
        recoveryRunningRef.current = false;
        setImportBusy(false);
      }
    };
  }, [initializing, mode, persistIngestedMedia, releasePrompt, scopeKey, setImportBusy, showDialog]);

  const selectMeetingMedia = useCallback(async () => {
    if (busyRef.current || promptActiveRef.current || recoveryRunningRef.current) return;
    if (!hasNativeMeetingMediaImport()) {
      showDialog({
        title: '暂时无法导入',
        message: '当前设备暂不支持导入会议录音。',
        tone: 'warning',
      });
      return;
    }
    promptActiveRef.current = true;
    try {
      const capability = await loadMeetingCapabilities({
        accessToken,
        forceRefresh: true,
        allowStaleOnError: false,
      }).catch(() => null);
      const mediaImport = capability?.source === 'remote'
        ? capability.capabilities.mediaImport
        : null;
      const includeVideo = mediaImport?.mimeTypes.some(
        mimeType => mimeType.toLowerCase().startsWith('video/'),
      ) === true;
      const selectedUri = await pickMeetingMedia(includeVideo);
      const sourceInfo = await inspectMeetingMediaSource(selectedUri);
      presentImportConfirmation({
        uri: selectedUri,
        fileName: sourceInfo.fileName,
        byteSize: sourceInfo.byteSize,
        lastModifiedMs: sourceInfo.lastModifiedMs,
        receivedAtMs: Date.now(),
        origin: 'file_import',
        mimeType: sourceInfo.mimeType,
        maximumBytes: mediaImport
          ? Math.min(LOCAL_MEETING_MEDIA_IMPORT_MAX_BYTES, mediaImport.maxBytes)
          : LOCAL_MEETING_MEDIA_IMPORT_MAX_BYTES,
      });
    } catch (reason) {
      if (isMeetingMediaPickerCancellation(reason)) {
        releasePrompt();
        return;
      }
      const closePickerFailure = () => releasePrompt();
      showDialog({
        title: '无法选择文件',
        message: meetingMediaImportErrorMessage(reason),
        tone: 'error',
        onDismiss: closePickerFailure,
        actions: [{ text: '知道了', role: 'primary', onPress: closePickerFailure }],
      });
    }
  }, [accessToken, presentImportConfirmation, releasePrompt, showDialog]);

  const value = useMemo<MeetingMediaImportContextValue>(() => ({
    busy,
    selectMeetingMedia,
  }), [busy, selectMeetingMedia]);

  return (
    <MeetingMediaImportContext.Provider value={value}>
      {children}
      <MeetingImportSheet
        visible={confirmation !== null}
        requestKey={confirmation?.source.intentToken ?? confirmation?.source.uri ?? ''}
        fileName={confirmation?.source.fileName?.trim().slice(0, 240) || '会议录音'}
        mimeType={confirmation?.source.mimeType ?? null}
        byteSize={confirmation?.source.byteSize ?? null}
        initialTitle={confirmation?.initialTitle ?? ''}
        initialRecordedAtMs={confirmation?.initialRecordedAtMs ?? Date.now()}
        events={searchableEvents}
        meetings={meetings}
        allowExistingMeeting={getFeatureFlags().meetingMediaImportExistingV1}
        onClose={closeImportConfirmation}
        onValidate={validateImportDraft}
        onImport={startConfirmedImport}
      />
    </MeetingMediaImportContext.Provider>
  );
}

export function useMeetingMediaImport(): MeetingMediaImportContextValue {
  const value = useContext(MeetingMediaImportContext);
  if (!value) throw new Error('useMeetingMediaImport must be used inside MeetingMediaImportProvider');
  return value;
}
