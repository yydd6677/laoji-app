import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import {
  assertScheduleEditorDraft, type ScheduleEditorDraft, type ScheduleEditorSaveReceipt,
} from '../domain/scheduleEditor';
import {
  createStoredScheduleEditorDraft, discardStoredScheduleEditorDraft,
  loadStoredScheduleEditorDraft, persistScheduleEditorDraft,
} from '../data/repositories/scheduleEditorRepository';
import { diagnosticWarn } from '../services/diagnostics';

/** Owns one draft; native fields are its projection, not a second saved copy. */
export function useScheduleEditorDraft(seed: ScheduleEditorDraft, restore: boolean) {
  const [draft, setDraft] = useState(seed);
  const [restoring, setRestoring] = useState(restore);
  const [restoreError, setRestoreError] = useState(false);
  const current = useRef(seed);
  const mounted = useRef(true);
  const persistedRevision = useRef(0);
  const initialization = useRef<Promise<void> | null>(null);
  const write = useRef<Promise<void> | null>(null);
  const discarded = useRef(false);

  const initialize = useCallback(() => {
    if (!initialization.current) {
      const operation = (async () => {
        const stored = restore ? await loadStoredScheduleEditorDraft(seed.id, seed.followup?.params)
          : await createStoredScheduleEditorDraft(seed);
        if (!stored) throw new Error('未保存的日程暂时无法读取');
        persistedRevision.current = stored.stateRevision;
        if (restore || JSON.stringify(stored) !== JSON.stringify(seed)) {
          current.current = stored;
          if (mounted.current) setDraft(stored);
        }
        if (mounted.current) { setRestoring(false); setRestoreError(false); }
      })();
      initialization.current = operation;
      void operation.catch(() => {
        if (initialization.current === operation) initialization.current = null;
        if (mounted.current) setRestoreError(true);
      });
    }
    return initialization.current;
  }, [restore, seed]);

  const change = useCallback((update: (previous: ScheduleEditorDraft) => ScheduleEditorDraft) => {
    if (discarded.current || restore && persistedRevision.current === 0) return current.current;
    const next = update(current.current);
    assertScheduleEditorDraft(next);
    if (next !== current.current) {
      current.current = next;
      if (mounted.current) setDraft(next);
    }
    return next;
  }, [restore]);

  const flush = useCallback(async (): Promise<void> => {
    if (discarded.current) return;
    await initialize();
    while (write.current) await write.current;
    if (current.current.stateRevision === persistedRevision.current) return;
    let operation: Promise<void>;
    operation = (async () => {
      while (!discarded.current && current.current.stateRevision > persistedRevision.current) {
        const snapshot = current.current;
        const accepted = await persistScheduleEditorDraft(snapshot, persistedRevision.current);
        if (!accepted) throw new Error('未保存的日程已发生变化，请重新打开');
        persistedRevision.current = snapshot.stateRevision;
      }
    })().finally(() => { if (write.current === operation) write.current = null; });
    write.current = operation;
    await operation;
  }, [initialize]);

  const discard = useCallback(async () => {
    await flush();
    const removed = await discardStoredScheduleEditorDraft(current.current.id, persistedRevision.current);
    if (!removed) throw new Error('日程保存尚未完成，请稍后重试');
    discarded.current = true;
  }, [flush]);

  const acceptSaveReceipt = useCallback((receipt: ScheduleEditorSaveReceipt) => {
    const previous = current.current;
    if (receipt.draftId !== previous.id || receipt.saveRequestId !== previous.saveRequestId
      || previous.phase !== 'saving' || receipt.stateRevision !== previous.stateRevision + 1) {
      throw new Error('日程保存回执不一致');
    }
    const saved: ScheduleEditorDraft = { ...previous, phase: 'saved',
      stateRevision: receipt.stateRevision, savedEventRef: receipt.eventRef };
    assertScheduleEditorDraft(saved);
    persistedRevision.current = receipt.stateRevision;
    current.current = saved;
    if (mounted.current) setDraft(saved);
  }, []);

  useEffect(() => {
    mounted.current = true;
    void initialize().catch(reason => diagnosticWarn('open schedule editor draft failed', reason));
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active' && (!restore || persistedRevision.current > 0)) {
        void flush().catch(reason => diagnosticWarn('flush schedule editor on background failed', reason));
      }
    });
    return () => {
      mounted.current = false;
      subscription.remove();
      if (!restore || persistedRevision.current > 0) {
        void flush().catch(reason => diagnosticWarn('flush schedule editor on leave failed', reason));
      }
    };
  }, [flush, initialize, restore]);

  useEffect(() => {
    if (restoring || restoreError || discarded.current) return;
    const timer = setTimeout(() => {
      void flush().catch(reason => diagnosticWarn('persist schedule editor draft failed', reason));
    }, 150);
    return () => clearTimeout(timer);
  }, [draft.stateRevision, flush, restoreError, restoring]);

  return { draft, current, change, flush, discard, acceptSaveReceipt, restoring, restoreError };
}
