import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState } from 'react-native';
import {
  acknowledgeIngestedMeetingMedia,
  acknowledgeHardwareRecording,
  acknowledgeMeetingMediaImportIntent,
  addMeetingMediaImportIntentListener,
  addHardwareRecordingListener,
  listPendingHardwareRecordings,
  hasNativeHardwareSupport,
  discardIngestedMeetingMedia,
  getPendingMeetingMediaImportIntent,
  hasNativeMeetingMediaImport,
  ingestMeetingMedia,
  inspectMeetingMediaSource,
  pickMeetingMedia,
  recoverPendingMeetingMediaImports,
  stageMeetingMediaImport,
  type IngestedMeetingMedia,
  type MeetingMediaImportOrigin,
  type PendingHardwareRecording,
  type PendingMeetingMediaImportIntent,
} from 'laoji-native-platform';
import { secureClientIdFactory, type ScopeKey } from '../domain/meeting';
import { recoverPreparedMeetingRecordingMerge } from '../application/meeting';
import { sqliteMeetingNoteRepository } from '../data/repositories/sqliteMeetingNoteRepository';
import { isLocalDataErasing, localDataEraseRevision } from '../services/localDataEraseState';
import { diagnosticAudit } from '../services/diagnostics';
import { recoverMeetingMediaImportBatch } from '../services/meetingMediaImportRecovery';
import { planHardwareRecordingImport } from '../services/hardwareRecordingImport';
import { loadDeviceServiceCapabilities } from '../services/deviceApi';
import { navigationRef } from '../navigation/notificationNavigation';
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
  blocked: boolean;
  blockedLabel: string | null;
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
  maximumBytesPromise?: Promise<number>;
  intentToken?: string;
  meetingId?: string;
  assetId?: string;
  readyMedia?: IngestedMeetingMedia;
};

type ImportRequest = ImportSource & {
  draft: MeetingMediaImportDraft;
  presentNavigation?: boolean;
  background?: boolean;
};

type PreparedImportRequest = Omit<ImportRequest, 'meetingId' | 'assetId'> & {
  meetingId: string;
  assetId: string;
};

type ImportConfirmation = {
  source: ImportSource;
  initialTitle: string;
  initialRecordedAtMs: number;
};

// Every confirmed import is journaled and receives a visible meeting shell
// immediately.  Only the expensive copy/extract step is bounded: allowing an
// arbitrary number of MediaCodec jobs to run at once can exhaust vendor codec
// instances or race disk reservations, while rejecting the third selection
// made perfectly recoverable work look unavailable to the user.
const MAX_ACTIVE_MEDIA_PREPARATIONS = 3;

function defaultRecordedAtMs(source: Pick<ImportSource, 'lastModifiedMs' | 'receivedAtMs'>): number {
  const nowMs = Date.now();
  const candidate = source.lastModifiedMs ?? source.receivedAtMs;
  return candidate && candidate > 0 && candidate <= nowMs + 60_000 ? candidate : nowMs;
}

function navigateToMeeting(meetingId: string): void {
  if (!navigationRef.isReady()) return;
  navigationRef.navigate('Transcription', { meetingId });
}

function saveImportDraftBestEffort(
  meetingId: string,
  draft: MeetingMediaImportDraft,
  checkpoint: 'initial' | 'shell',
): void {
  void saveMeetingMediaImportDraft(meetingId, draft).catch(reason => {
    const code = reason && typeof reason === 'object'
      ? (reason as { code?: unknown }).code
      : null;
    console.warn('[laoji-audit] meeting_media_import_draft_write_failed', JSON.stringify({
      checkpoint,
      code: typeof code === 'string' && code.trim() ? code.trim() : 'unknown',
    }));
  });
}

export function MeetingMediaImportProvider({ children }: { children: React.ReactNode }) {
  const { searchableEvents } = useEvents();
  const {
    createMeeting,
    importMeetingMedia,
    meetings,
    updateMeetingStatus,
  } = useMeetings();
  const { showDialog } = useAppDialog();
  const [confirmation, setConfirmation] = useState<ImportConfirmation | null>(null);
  const activePreparationCountRef = useRef(0);
  const preparationWaitersRef = useRef<Array<() => void>>([]);
  const promptActiveRef = useRef(false);
  const recoveryRunningRef = useRef(false);
  const recoveryGenerationRef = useRef(0);
  const activeIntentTokenRef = useRef<string | null>(null);
  const handledIntentTokensRef = useRef(new Set<string>());
  const meetingsRef = useRef(meetings);
  const runImportRef = useRef<(source: ImportRequest) => Promise<boolean>>(async () => false);
  const handleIntentRef = useRef<(intent: PendingMeetingMediaImportIntent) => void>(() => {});
  const drainIntentInboxRef = useRef<() => void>(() => {});
  const scopeKey: ScopeKey = 'guest';
  const activeImportsRef = useRef(new Set<string>());

  useEffect(() => {
    meetingsRef.current = meetings;
  }, [meetings]);

  const acquirePreparationSlot = useCallback(async () => {
    if (activePreparationCountRef.current < MAX_ACTIVE_MEDIA_PREPARATIONS) {
      activePreparationCountRef.current += 1;
      return;
    }
    await new Promise<void>(resolve => {
      preparationWaitersRef.current.push(resolve);
    });
  }, []);

  const releasePreparationSlot = useCallback(() => {
    const next = preparationWaitersRef.current.shift();
    if (next) {
      // Transfer the occupied slot directly to the oldest durable import.
      next();
      return;
    }
    activePreparationCountRef.current = Math.max(0, activePreparationCountRef.current - 1);
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
    // Release the private handoff copy only after canonical persistence. A
    // failed cleanup remains internal retry work, never a manual user inbox.
    const hardwareAcknowledged = draft.hardwareRecordingId
      ? await acknowledgeHardwareRecording(draft.hardwareRecordingId).catch(() => false)
      : true;
    const acknowledged = await acknowledgeIngestedMeetingMedia(media.meetingId, media.assetId);
    if (acknowledged && hardwareAcknowledged) await deleteMeetingMediaImportDraft(media.meetingId);
    return meeting;
  }, [importMeetingMedia]);

  const runImport = useCallback(async (source: ImportRequest) => {
    const request: PreparedImportRequest = {
      ...source,
      meetingId: source.meetingId ?? secureClientIdFactory.create(),
      assetId: source.assetId ?? secureClientIdFactory.create(),
    };
    if (activeImportsRef.current.has(request.meetingId)) return false;
    activeImportsRef.current.add(request.meetingId);
    if (!request.background) promptActiveRef.current = false;
    let copied = Boolean(source.readyMedia);
    let staged = Boolean(source.readyMedia);
    let ingestedMedia = source.readyMedia ?? null;
    let navigatedMeetingId: string | null = request.draft.targetMeetingId ?? null;
    let navigationPresented = false;
    let placeholderCreated = false;
    let preparationAcquired = false;
    let activeDraft = request.draft;
    let importPhase = 'stage_native_media';
    try {
      // The native ingest journal and canonical meeting database are the
      // recovery owners. This small presentation draft preserves title/target
      // choices, but an AsyncStorage failure must never reject a valid local
      // recording or make USB/ADB appear required for import.
      saveImportDraftBestEffort(request.meetingId, activeDraft, 'initial');
      if (!source.readyMedia) {
        await stageMeetingMediaImport({
          sourceUri: request.uri,
          meetingId: request.meetingId,
          assetId: request.assetId,
          origin: request.origin,
          maximumBytes: LOCAL_MEETING_MEDIA_IMPORT_MAX_BYTES,
        });
        staged = true;
      }
      /*
       * A file import is a local-first operation.  Create the lightweight
       * meeting shell and enter its detail page before copying/extracting the
       * media.  The old order made the user wait for the whole ingest + SQLite
       * write + upload kick-off chain while the list upload button spun.
       *
       * The canonical local meeting store attaches the imported asset after
       * preparation without replacing the first-frame shell.
       */
      if (!navigatedMeetingId) {
        importPhase = 'create_meeting_shell';
        const placeholder = await createMeeting(activeDraft.title, {
          id: request.meetingId,
          mode: 'offline',
          recordedAt: new Date(activeDraft.recordedAtMs).toISOString(),
          ...(activeDraft.calendarContext ? { calendarContext: activeDraft.calendarContext } : {}),
          clientRequestId: request.meetingId,
          entryPoint: request.origin === 'share_intent' ? 'share_intent' : 'meeting_tab',
          fastLocalResult: true,
          initialProcessingStatuses: {
            capture: 'preparing',
            upload: 'not_required',
            transcript: 'none',
            summary: 'none',
            speaker: 'none',
          },
        });
        navigatedMeetingId = placeholder.id;
        placeholderCreated = true;
        activeDraft = { ...activeDraft, targetMeetingId: placeholder.id };
        // Enter the durable shell before any auxiliary storage work. The user
        // should see accepted work immediately even if draft persistence is
        // temporarily unavailable.
        if (request.presentNavigation !== false) navigateToMeeting(placeholder.id);
        navigationPresented = true;
        saveImportDraftBestEffort(request.meetingId, activeDraft, 'shell');
        // The shell and native ingest journal intentionally share one stable
        // identity. Recovery can therefore attach the prepared asset to the
        // same record without another mapping lookup or a duplicate shell.
      }

      if (navigatedMeetingId && !navigationPresented) {
        if (request.intentToken) {
          // Keep the share intent pending until the media is durable; only the
          // visual navigation happens early so a process death remains
          // recoverable.
        }
        if (request.presentNavigation !== false) navigateToMeeting(navigatedMeetingId);
        navigationPresented = true;
      }

      // Everything above this point is lightweight and durable.  A fourth or
      // tenth selection is accepted immediately and can recover after process
      // death; it merely waits here for bounded codec / file-I/O capacity.
      await acquirePreparationSlot();
      preparationAcquired = true;
      importPhase = 'prepare_native_media';
      const serviceMaximumBytes = source.maximumBytesPromise
        ? await source.maximumBytesPromise
        : source.maximumBytes;
      const media = source.readyMedia ?? await ingestMeetingMedia({
        sourceUri: request.uri,
        meetingId: request.meetingId,
        assetId: request.assetId,
        origin: request.origin,
        maximumBytes: Math.min(
          LOCAL_MEETING_MEDIA_IMPORT_MAX_BYTES,
          serviceMaximumBytes ?? LOCAL_MEETING_MEDIA_IMPORT_MAX_BYTES,
        ),
      });
      ingestedMedia = media;
      copied = true;
      importPhase = 'persist_canonical_media';
      const meeting = await persistIngestedMedia(media, activeDraft);
      if (request.intentToken) await finishIntent(request.intentToken);
      else if (!request.background) releasePrompt();
      if (!navigatedMeetingId && request.presentNavigation !== false) navigateToMeeting(meeting.id);
      return true;
    } catch (reason) {
      const code = reason && typeof reason === 'object'
        ? (reason as { code?: unknown }).code
        : null;
      console.warn('[laoji-audit] meeting_media_import_failed', JSON.stringify({
        phase: importPhase,
        code: typeof code === 'string' && code.trim() ? code.trim() : 'unknown',
      }));
      // An automatic handoff has no user decision to make. Keep its journal
      // and source intact; the recovery worker will retry without a modal.
      if (request.background) return false;
      promptActiveRef.current = true;
      const closeFailure = () => {
        void (async () => {
          if (!copied) {
            await deleteMeetingMediaImportDraft(request.meetingId).catch(() => {});
            if (staged) {
              await discardIngestedMeetingMedia(request.meetingId, request.assetId).catch(() => false);
            }
          }
          if (request.intentToken) await finishIntent(request.intentToken);
          else releasePrompt();
        })();
      };
      if (placeholderCreated && navigatedMeetingId) {
        // Do not leave a shell permanently looking idle after an ingest error.
        // The durable local asset (when one exists) is retained for the retry
        // or alternate-target flow below.
        void updateMeetingStatus(
          navigatedMeetingId,
          'failed',
          ingestedMedia
            ? {
              audioAvailable: true,
              audioLocalUri: ingestedMedia.localUri,
              audioDurationSec: ingestedMedia.durationMs / 1000,
            }
            : {},
        ).catch(() => false);
      }
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
            maximumBytesPromise: request.maximumBytesPromise,
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
      return false;
    } finally {
      activeImportsRef.current.delete(request.meetingId);
      if (preparationAcquired) releasePreparationSlot();
      drainIntentInboxRef.current();
    }
  }, [
    createMeeting,
    finishIntent,
    meetings,
    persistIngestedMedia,
    releasePrompt,
    acquirePreparationSlot,
    releasePreparationSlot,
    showDialog,
    updateMeetingStatus,
  ]);
  runImportRef.current = runImport;

  // All verified hardware receives share this automatic adoption path. The
  // private handoff index is a crash-safe queue, not a second user workflow.
  useEffect(() => {
    if (!hasNativeHardwareSupport()) return undefined;
    let active = true;
    let draining = false;
    const retries = new Map<string, { count: number; afterMs: number }>();
    const receive = async (recording: PendingHardwareRecording) => {
      if (recording.purpose === 'schedule') return;
      const revision = localDataEraseRevision();
      if (!active || recoveryRunningRef.current || isLocalDataErasing()
        || (retries.get(recording.recordingId)?.afterMs ?? 0) > Date.now()) return;
      try {
        const plan = await planHardwareRecordingImport(recording, sqliteMeetingNoteRepository);
        if (!active || recoveryRunningRef.current || isLocalDataErasing()
          || localDataEraseRevision() !== revision || plan.kind === 'deferred') return;
        if (plan.kind === 'adopted') {
          if (!await acknowledgeHardwareRecording(recording.recordingId)) throw new Error('handoff_cleanup');
          retries.delete(recording.recordingId);
          return;
        }
        const completed = await runImportRef.current({ uri: recording.localUri, fileName: `${plan.title}.wav`,
          byteSize: recording.byteSize, lastModifiedMs: recording.recordedAtMs, receivedAtMs: recording.recordedAtMs,
          origin: 'file_import', mimeType: 'audio/wav', meetingId: plan.meetingId, assetId: recording.recordingId,
          presentNavigation: false, background: true,
          draft: { scopeKey: 'guest', title: plan.title, recordedAtMs: plan.recordedAtMs,
            calendarContext: null, targetMeetingId: plan.targetMeetingId, hardwareRecordingId: recording.recordingId },
        });
        if (!completed) throw new Error('handoff_deferred');
        retries.delete(recording.recordingId);
      } catch (reason) {
        const count = Math.min(5, (retries.get(recording.recordingId)?.count ?? 0) + 1);
        retries.set(recording.recordingId, { count, afterMs: Date.now() + Math.min(300_000, 30_000 * 2 ** (count - 1)) });
        const code = (reason as { code?: unknown } | null)?.code;
        diagnosticAudit('hardware_recording_import_deferred', { code: typeof code === 'string' ? code : 'unknown' });
      }
    };
    const reconcile = async () => {
      if (recoveryRunningRef.current || draining || !active || isLocalDataErasing()) return;
      draining = true;
      try {
        const items = await listPendingHardwareRecordings();
        const ids = new Set(items.map(item => item.recordingId));
        for (const id of retries.keys()) if (!ids.has(id)) retries.delete(id);
        for (const item of items) await receive(item);
      } catch {
        diagnosticAudit('hardware_recording_import_deferred', { code: 'queue_unavailable' });
      } finally { draining = false; }
    };
    const listener = addHardwareRecordingListener(() => { void reconcile(); });
    const timer = setInterval(() => { void reconcile(); }, 3_000);
    void reconcile();
    return () => { active = false; listener.remove(); clearInterval(timer); };
  }, []);

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
    if (!current) {
      setConfirmation(null);
      releasePrompt();
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
      promptActiveRef.current
      || activeIntentTokenRef.current !== null
    ) return;
    if (handledIntentTokensRef.current.has(intent.token)) return;
    handledIntentTokensRef.current.add(intent.token);
    activeIntentTokenRef.current = intent.token;
    const message = meetingMediaIntentErrorMessage(intent);
    if (message || !intent.uri) {
      promptActiveRef.current = true;
      // An invalid share cannot be recovered by a later launch. Acknowledge it
      // before presenting the warning so a process death or upgrade cannot
      // replay the same stale dialog. finishIntent below remains as a retry
      // path if the native acknowledgement is temporarily unavailable.
      void acknowledgeMeetingMediaImportIntent(intent.token).catch(() => false);
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
    /*
     * The native intent inbox has already resolved the URI against the
     * same allow-list used by the importer.  A remote capability probe here
     * can delay or reject a valid local share before the durable uploader has
     * a chance to validate the current service session.
     * Import is local-first, so let the user confirm immediately and let the
     * durable ingest/upload path report a real server rejection if needed.
     */
    present();
  }, [finishIntent, presentImportConfirmation, showDialog]);
  handleIntentRef.current = handleIntent;

  const drainIntentInbox = useCallback(() => {
    if (
      promptActiveRef.current
      || activeIntentTokenRef.current !== null
      || !hasNativeMeetingMediaImport()
    ) return;
    void getPendingMeetingMediaImportIntent().then(intent => {
      if (intent) handleIntentRef.current(intent);
    }).catch(() => {});
  }, []);
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
    if (!hasNativeMeetingMediaImport()) return;
    let cancelled = false;
    const generation = recoveryGenerationRef.current + 1;
    recoveryGenerationRef.current = generation;
    const eraseRevision = localDataEraseRevision();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const active = () => !cancelled && !isLocalDataErasing()
      && localDataEraseRevision() === eraseRevision;
    const report = (phase: 'scan' | 'restore', reason: unknown) => {
      const value = reason as { code?: unknown; name?: unknown } | null;
      diagnosticAudit('meeting_media_import_recovery_deferred', {
        phase,
        code: typeof value?.code === 'string' ? value.code : 'unknown',
        type: typeof value?.name === 'string' ? value.name : 'unknown',
      });
    };
    const restore = async (media: IngestedMeetingMedia) => {
      if (media.origin === 'recording_merge') {
        const recovered = await recoverPreparedMeetingRecordingMerge(scopeKey, media);
        if (recovered) await acknowledgeIngestedMeetingMedia(media.meetingId, media.assetId);
        return;
      }
      const savedDraft = await loadMeetingMediaImportDraft(media.meetingId);
      if (savedDraft && savedDraft.scopeKey !== scopeKey) {
        throw Object.assign(new Error(), { code: 'ERR_MEDIA_IMPORT_SCOPE_MISMATCH' });
      }
      const draft: MeetingMediaImportDraft = savedDraft ?? {
        scopeKey,
        title: suggestedMeetingTitleFromFileName(media.fileName),
        recordedAtMs: defaultRecordedAtMs({ lastModifiedMs: media.sourceLastModifiedMs, receivedAtMs: null }),
        calendarContext: null,
        targetMeetingId: null,
      };
      await persistIngestedMedia(media, draft);
    };
    const recover = async () => {
      if (!active()) return;
      if (recoveryRunningRef.current || activeImportsRef.current.size > 0 || AppState.currentState !== 'active') {
        timer = setTimeout(() => { void recover(); }, 15_000);
        return;
      }
      recoveryRunningRef.current = true;
      try {
        const complete = await recoverMeetingMediaImportBatch({
          list: recoverPendingMeetingMediaImports, restore, active, report,
        });
        failures = complete ? 0 : Math.min(4, failures + 1);
      } finally {
        if (recoveryGenerationRef.current === generation) recoveryRunningRef.current = false;
        drainIntentInboxRef.current();
        if (active()) timer = setTimeout(() => { void recover(); }, Math.min(300_000, 30_000 * 2 ** failures));
      }
    };
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active' || recoveryRunningRef.current || !active()) return;
      if (timer) clearTimeout(timer);
      void recover();
    });
    void recover();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      subscription.remove();
      if (recoveryGenerationRef.current === generation) {
        recoveryGenerationRef.current += 1;
        recoveryRunningRef.current = false;
      }
    };
  }, [persistIngestedMedia, scopeKey]);

  const selectMeetingMedia = useCallback(async () => {
    if (promptActiveRef.current) return;
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
      /*
       * Do not put device registration/capability discovery in front of the
       * system picker.  It is a remote operation and was the source of the
       * first-open ~3s pause.  The native picker already owns the complete,
       * bounded audio/video MIME list; capability discovery remains an
       * optional background concern for the ingest/upload stages.
       */
      // Resolve failures here so cancelling the picker cannot leave an
      // unhandled capability request behind. A failed probe only affects the
      // later size fence; the local safety ceiling remains in force.
      const capabilityPromise = loadDeviceServiceCapabilities().catch(() => null);
      const selectedUri = await pickMeetingMedia(true);
      const sourceInfo = await inspectMeetingMediaSource(selectedUri);
      const maximumBytesPromise = capabilityPromise.then(
        capability => Math.min(
          LOCAL_MEETING_MEDIA_IMPORT_MAX_BYTES,
          capability?.mediaImport?.maxBytes ?? LOCAL_MEETING_MEDIA_IMPORT_MAX_BYTES,
        ),
      );
      presentImportConfirmation({
        uri: selectedUri,
        fileName: sourceInfo.fileName,
        byteSize: sourceInfo.byteSize,
        lastModifiedMs: sourceInfo.lastModifiedMs,
        receivedAtMs: Date.now(),
        origin: 'file_import',
        mimeType: sourceInfo.mimeType,
        maximumBytes: LOCAL_MEETING_MEDIA_IMPORT_MAX_BYTES,
        maximumBytesPromise,
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
  }, [presentImportConfirmation, releasePrompt, showDialog]);

  const value = useMemo<MeetingMediaImportContextValue>(() => ({
    blocked: false,
    blockedLabel: null,
    selectMeetingMedia,
  }), [selectMeetingMedia]);

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
        allowExistingMeeting
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
