import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { ManualNoteRevisionConflictError } from '../application/meeting';
import type { ScopeKey } from '../domain/meeting';
import {
  loadMeetingManualNote,
  saveMeetingManualNote,
} from '../services/meetingManualNotes';

const AUTOSAVE_DELAY_MS = 400;
const MAX_MANUAL_NOTE_LENGTH = 200_000;

export interface MeetingManualNoteDraft {
  content: string;
  revision: number;
  loading: boolean;
  saving: boolean;
  enabled: boolean;
  error: string;
  retryable: boolean;
  updateContent(content: string): void;
  flush(): Promise<void>;
  reload(): Promise<void>;
  retry(): Promise<void>;
  snapshot(): { content: string; revision: number };
}

export function useMeetingManualNote(
  scopeKey: ScopeKey | null,
  meetingId: string | undefined,
): MeetingManualNoteDraft {
  const enabled = Boolean(scopeKey && meetingId);
  const [content, setContent] = useState('');
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(enabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const draftRef = useRef('');
  const savedContentRef = useRef('');
  const revisionRef = useRef(0);
  const loadedRef = useRef(false);
  const failureRef = useRef<'load' | 'save' | 'conflict' | null>(null);
  const saveOperationRef = useRef<Promise<void> | null>(null);

  const load = useCallback(async () => {
    const generation = ++generationRef.current;
    loadedRef.current = false;
    saveOperationRef.current = null;
    draftRef.current = '';
    savedContentRef.current = '';
    revisionRef.current = 0;
    setContent('');
    setRevision(0);
    setSaving(false);
    setError('');
    failureRef.current = null;
    if (!scopeKey || !meetingId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const note = await loadMeetingManualNote(scopeKey, meetingId);
      if (!mountedRef.current || generationRef.current !== generation) return;
      draftRef.current = note.content;
      savedContentRef.current = note.content;
      revisionRef.current = note.revision;
      loadedRef.current = true;
      setContent(note.content);
      setRevision(note.revision);
    } catch {
      if (!mountedRef.current || generationRef.current !== generation) return;
      failureRef.current = 'load';
      setError('笔记暂时无法读取，请稍后重试。');
    } finally {
      if (mountedRef.current && generationRef.current === generation) setLoading(false);
    }
  }, [meetingId, scopeKey]);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
    };
  }, [load]);

  const updateContent = useCallback((value: string) => {
    const next = value.replace(/\r\n?/g, '\n').slice(0, MAX_MANUAL_NOTE_LENGTH);
    draftRef.current = next;
    setContent(next);
    setError('');
  }, []);

  const flush = useCallback((): Promise<void> => {
    if (!scopeKey || !meetingId || !loadedRef.current) return Promise.resolve();
    const running = saveOperationRef.current;
    if (running) return running;
    const generation = generationRef.current;
    let operation: Promise<void>;
    operation = (async () => {
      if (mountedRef.current && generationRef.current === generation) setSaving(true);
      while (
        generationRef.current === generation
        && draftRef.current !== savedContentRef.current
      ) {
        const pendingContent = draftRef.current;
        const result = await saveMeetingManualNote(
          scopeKey,
          meetingId,
          pendingContent,
          revisionRef.current,
        );
        if (generationRef.current !== generation) return;
        revisionRef.current = result.note.revision;
        savedContentRef.current = result.note.content;
        if (mountedRef.current) {
          setRevision(result.note.revision);
          setError('');
          failureRef.current = null;
        }
      }
    })().catch(reason => {
      if (!mountedRef.current || generationRef.current !== generation) return;
      failureRef.current = reason instanceof ManualNoteRevisionConflictError ? 'conflict' : 'save';
      setError(reason instanceof ManualNoteRevisionConflictError
        ? '笔记在其他位置发生了更新，本机内容仍保留。'
        : '笔记暂时未保存，请检查存储空间后重试。');
    }).finally(() => {
      if (saveOperationRef.current === operation) saveOperationRef.current = null;
      if (mountedRef.current && generationRef.current === generation) setSaving(false);
    });
    saveOperationRef.current = operation;
    return operation;
  }, [meetingId, scopeKey]);

  useEffect(() => {
    if (!loadedRef.current || content === savedContentRef.current) return undefined;
    const timer = setTimeout(() => { void flush(); }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [content, flush]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') void flush();
    });
    return () => subscription.remove();
  }, [flush]);

  useEffect(() => () => { void flush(); }, [flush]);

  const retry = useCallback((): Promise<void> => (
    failureRef.current === 'load'
      ? load()
      : failureRef.current === 'conflict'
        ? Promise.resolve()
        : flush()
  ), [flush, load]);

  return {
    content,
    revision,
    loading,
    saving,
    enabled: enabled && loadedRef.current,
    error,
    retryable: failureRef.current !== 'conflict',
    updateContent,
    flush,
    reload: load,
    retry,
    snapshot: () => ({ content: draftRef.current, revision: revisionRef.current }),
  };
}
