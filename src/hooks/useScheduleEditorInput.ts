import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, PermissionsAndroid } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import {
  addNativeRecorderTranscriptListener, addNativeRecorderLevelListener, addNativeRecorderErrorListener,
  hasNativeRecorder, startNativeRecorder, stopNativeRecorder, transcribeNativeAudioFile,
  type NativeRecorderStopResult,
} from 'laoji-native-platform';
import {
  applyScheduleEditorInput, beginScheduleEditorInput, cancelScheduleEditorInput, finishScheduleEditorTranscript,
  undoScheduleEditorInput, writeScheduleEditorInputText, type ScheduleInputMode,
} from '../domain/scheduleEditor';
import type { useScheduleEditorDraft } from './useScheduleEditorDraft';
import { createClientRequestState } from '../services/clientRequestId';
import { getLocalDeviceRealtimeAuth } from '../services/deviceApi';
import { getApiConfig } from '../services/config';
import { buildRealtimeAsrUrl, createRealtimeMeetingId } from '../services/realtimeAsr';
import { appendScheduleTranscriptSegment, scheduleTranscriptText, type ScheduleTranscriptSegment } from '../services/scheduleTranscript';
import { defaultScheduleEditorInputMode, observeScheduleEditorInput } from '../services/scheduleEditorParsing';
import { readableErrorMessage } from '../services/errors';
import { diagnosticAudit, diagnosticWarn } from '../services/diagnostics';

type Editor = Pick<ReturnType<typeof useScheduleEditorDraft>, 'current' | 'change' | 'flush'>;
type Capture = { operationId: string; sessionId: string; segments: ScheduleTranscriptSegment[] };
const recoverStop = (error: unknown) => (error as { result?: NativeRecorderStopResult } | null)?.result;
async function deleteInputAudio(uri?: string | null) {
  if (uri) await FileSystem.deleteAsync(uri.includes('://') ? uri : `file://${uri}`, { idempotent: true })
    .catch(reason => diagnosticWarn('delete schedule input audio failed', reason));
}

/** One draft owns phase/revision/text. Refs here own only cancellable transport lifetimes. */
export function useScheduleEditorInput({ current, change, flush }: Editor) {
  const mounted = useRef(true);
  const capture = useRef<Capture | null>(null);
  const starting = useRef<Promise<void> | null>(null);
  const stopping = useRef<Promise<void> | null>(null);
  const abort = useRef<AbortController | null>(null);
  const stopRequested = useRef(false);
  const [error, setError] = useState('');
  const [level, setLevel] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const stopAfterStart = useRef<() => void>(() => {});
  const owns = useCallback((id: string) => mounted.current && current.current.pendingInput?.id === id,
    [current]);

  const fail = useCallback((id: string, reason: unknown) => {
    if (!owns(id)) return;
    change(value => value.pendingInput?.id === id ? cancelScheduleEditorInput(value) : value);
    setError(readableErrorMessage(reason, '暂时无法处理这次输入，请重试'));
    void flush().catch(reason => diagnosticWarn('persist schedule input failure failed', reason));
  }, [change, flush, owns]);

  const observe = useCallback(async (id: string, text: string) => {
    if (!owns(id)) return;
    const snapshot = change(value => finishScheduleEditorTranscript(value, id, text));
    const op = snapshot.pendingInput;
    if (!op || op.id !== id) return;
    if (snapshot.revision !== op.baseRevision) {
      fail(id, new Error('日程已修改，可重新应用这次输入'));
      return;
    }
    const controller = new AbortController(); abort.current = controller;
    try {
      await flush();
      if (!owns(id)) return;
      const observed = await observeScheduleEditorInput(snapshot, controller.signal);
      if (!owns(id)) return;
      if (observed.status === 'unsupported' || observed.status === 'ambiguous') {
        throw new Error(observed.status === 'ambiguous' ? '这次修改还不够明确，可直接编辑日程' : '这次输入不能修改当前日程');
      }
      let accepted = false;
      change(value => {
        const result = applyScheduleEditorInput(value, { id, baseRevision: op.baseRevision, sequence: op.sequence }, observed.changes,
          'origins' in observed ? observed.origins : undefined);
        accepted = result.accepted;
        return result.draft;
      });
      if (mounted.current) setError(accepted ? '' : '日程已修改，可重新应用这次输入');
      await flush();
    } catch (reason) { fail(id, reason); }
    finally { if (abort.current === controller) abort.current = null; }
  }, [change, fail, flush, owns]);

  const stopCapture = useCallback((discard: boolean): Promise<void> => {
    if (stopping.current) return stopping.current;
    const active = capture.current;
    if (!active) return Promise.resolve();
    const stoppedAt = Date.now();
    let operation!: Promise<void>;
    operation = (async () => {
      let uri: string | null = null;
      try {
        let result: NativeRecorderStopResult;
        try { result = await stopNativeRecorder(active.sessionId); }
        catch (reason) { const recovered = recoverStop(reason); if (!recovered?.localSaved) throw reason; result = recovered; }
        uri = result.localUri;
        for (const segment of result.transcriptSegments ?? []) active.segments = appendScheduleTranscriptSegment(active.segments, {
          segmentId: segment.segmentId, isFinal: true, text: segment.text, receivedAt: segment.receivedAtMs,
          startTime: segment.startMs == null ? undefined : segment.startMs / 1000,
          endTime: segment.endMs == null ? undefined : segment.endMs / 1000,
        });
        if (capture.current === active) capture.current = null;
        // Native microphone ownership is released before semantic work. An
        // aborted old request must not hold a rapid re-record behind a model.
        if (stopping.current === operation) stopping.current = null;
        if (discard || !owns(active.operationId)) return;
        let text = scheduleTranscriptText(active.segments);
        diagnosticAudit('schedule_editor_capture_finished', {
          audio_ms: Math.round(result.snapshot.bytesRecorded / 32),
          stop_drain_ms: Date.now() - stoppedAt,
          segment_count: active.segments.length,
          final_segment_count: active.segments.filter(segment => segment.isFinal).length,
          transcript_chars: text.length,
          source_end_ms: Math.round(Math.max(0, ...active.segments.map(segment => segment.endTime ?? 0)) * 1000),
          recovery_required: result.snapshot.transcriptRecoveryRequired,
        });
        if (result.snapshot.transcriptRecoveryRequired && uri) {
          const auth = await getLocalDeviceRealtimeAuth();
          if (!owns(active.operationId)) return;
          const config = getApiConfig(); const sessionId = createRealtimeMeetingId();
          text = await transcribeNativeAudioFile(uri, { sessionId, purpose: 'schedule', ...auth,
            websocketUrl: buildRealtimeAsrUrl({ meetingId: sessionId, purpose: 'schedule', realtimeAsrBase: config.realtimeAsrBase }),
            allowInsecureDevelopment: !config.isProduction && !config.realtimeAsrBase.startsWith('wss://') });
        }
        await observe(active.operationId, text);
      } catch (reason) { fail(active.operationId, reason); }
      finally {
        await deleteInputAudio(uri);
        if (capture.current === active) capture.current = null;
      }
    })().finally(() => { if (stopping.current === operation) stopping.current = null; });
    stopping.current = operation;
    return operation;
  }, [fail, observe, owns]);

  const cancel = useCallback(() => {
    abort.current?.abort(); abort.current = null;
    change(cancelScheduleEditorInput);
    if (mounted.current) { setError(''); setLevel(0); }
    // Fence first, then release native capture. Leaving never waits for remote
    // finalization, but a subsequent capture awaits the same release promise.
    void (starting.current ?? Promise.resolve()).then(() => stopCapture(true))
      .catch(reason => diagnosticWarn('cancel schedule input failed', reason));
  }, [change, stopCapture]);

  const start = useCallback((mode?: ScheduleInputMode) => {
    if (starting.current || current.current.phase !== 'editing') return;
    if (!hasNativeRecorder()) { setError('当前设备暂不支持录音，可输入文字'); return; }
    const pressedAt = Date.now();
    const id = createClientRequestState('schedule-editor-input').id;
    const snapshot = change(value => beginScheduleEditorInput(value, { id,
      mode: mode ?? defaultScheduleEditorInputMode(value), recording: true,
      referenceDatetime: new Date(pressedAt).toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai' }));
    if (snapshot.pendingInput?.id !== id) return;
    stopRequested.current = false; setError(''); setLevel(0); setDurationMs(0);
    let operation!: Promise<void>;
    operation = (async () => {
      try {
        if (stopping.current) await stopping.current;
        const granted = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO)
          || await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO) === PermissionsAndroid.RESULTS.GRANTED;
        if (!owns(id)) return;
        if (!granted) throw new Error('请在系统设置中允许使用麦克风');
        const auth = await getLocalDeviceRealtimeAuth();
        if (!owns(id)) return;
        const config = getApiConfig(); const sessionId = createRealtimeMeetingId();
        capture.current = { operationId: id, sessionId, segments: [] };
        const result = await startNativeRecorder({ sessionId, purpose: 'schedule', ...auth,
          websocketUrl: buildRealtimeAsrUrl({ meetingId: sessionId, purpose: 'schedule', realtimeAsrBase: config.realtimeAsrBase }),
          allowInsecureDevelopment: !config.isProduction && !config.realtimeAsrBase.startsWith('wss://'), levelIntervalMs: 120 });
        diagnosticAudit('schedule_editor_capture_started', { latency_ms: Math.max(0, (result.captureStartedAtMs ?? Date.now()) - pressedAt) });
        if (!owns(id)) return;
      } catch (reason) { fail(id, reason); }
      finally {
        if (starting.current === operation) starting.current = null;
        if (!owns(id)) void stopCapture(true);
        else if (stopRequested.current) stopAfterStart.current();
      }
    })();
    starting.current = operation;
    void flush().catch(reason => diagnosticWarn('persist schedule capture failed', reason));
  }, [change, current, fail, flush, owns, stopCapture]);

  const stop = useCallback(() => {
    stopRequested.current = true;
    if (starting.current) return;
    const op = current.current.pendingInput;
    if (!op || current.current.phase !== 'recording') return;
    setLevel(0);
    change(value => finishScheduleEditorTranscript(value, op.id, value.latestInputText));
    void stopCapture(false);
  }, [change, current, stopCapture]);
  stopAfterStart.current = stop;

  const submit = useCallback((text: string) => {
    if (current.current.phase !== 'editing' || !text.trim()) return;
    const id = createClientRequestState('schedule-editor-input').id;
    const next = change(value => beginScheduleEditorInput(value, { id, mode: defaultScheduleEditorInputMode(value),
      referenceDatetime: new Date().toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai', text }));
    if (next.pendingInput?.id === id) { setError(''); void observe(id, text); }
  }, [change, current, observe]);

  const setText = useCallback((text: string) => { change(value => writeScheduleEditorInputText(value, text)); setError(''); }, [change]);
  const undo = useCallback(() => { change(undoScheduleEditorInput); setError(''); void flush().catch(reason => diagnosticWarn('persist schedule undo failed', reason)); }, [change, flush]);

  useEffect(() => {
    mounted.current = true;
    // Manual/text editing must not acquire unavailable native capabilities at
    // mount. The same capability boundary already guards starting capture.
    const subscriptions = hasNativeRecorder() ? [
      addNativeRecorderTranscriptListener(event => {
        const active = capture.current;
        if (!active || event.sessionId !== active.sessionId || !owns(active.operationId)) return;
        active.segments = appendScheduleTranscriptSegment(active.segments, { segmentId: event.segmentId,
          isFinal: event.isFinal, text: event.text, receivedAt: event.receivedAtMs,
          startTime: event.startMs == null ? undefined : event.startMs / 1000,
          endTime: event.endMs == null ? undefined : event.endMs / 1000 });
        change(value => writeScheduleEditorInputText(value, scheduleTranscriptText(active.segments), active.operationId));
      }),
      addNativeRecorderLevelListener(event => {
        if (event.sessionId !== capture.current?.sessionId || !mounted.current) return;
        setLevel(event.normalized); setDurationMs(event.durationMs);
      }),
      addNativeRecorderErrorListener(event => {
        if (event.sessionId !== capture.current?.sessionId || event.recoverable) return;
        const id = capture.current?.operationId;
        if (id) { fail(id, new Error('录音未能继续，可重新输入')); void stopCapture(true); }
      }),
    ] : [];
    const appState = AppState.addEventListener('change', state => { if (state !== 'active') cancel(); });
    return () => {
      mounted.current = false; subscriptions.forEach(s => s.remove()); appState.remove(); cancel();
    };
  }, [cancel, change, fail, owns, stopCapture]);

  return { error, level, durationMs, start, stop, cancel, submit, setText, undo };
}
