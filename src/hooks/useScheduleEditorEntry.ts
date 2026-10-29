import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useScheduleInputs } from '../components/ScheduleInputProvider';
import { findScheduleEditorFollowup, listUnfinishedScheduleEditorDrafts, loadStoredScheduleEditorDraft,
  openScheduleInputEditorDraft } from '../data/repositories/scheduleEditorRepository';
import { isScheduleEditorResumeCandidate, type ScheduleEditorDraft } from '../domain/scheduleEditor';
import { retryScheduleInput } from '../data/repositories/scheduleInputRepository';
import type { ScheduleInputJob } from '../services/scheduleInput';
import type { RootStackParamList } from '../types';
import { diagnosticWarn } from '../services/diagnostics';
import { useAppDialog } from '../components/AppDialog';

type EditorEntry = RootStackParamList['AddEvent'];
export type ScheduleEditorResumeSelection = { entry: EditorEntry; drafts: ScheduleEditorDraft[]; epoch: number; sequence: number };

/** Entry handoff owns navigation only. The existing job and editor
 * repositories remain the only durable owners of recognition and edits. */
export function useScheduleEditorEntry(
  navigation: Pick<NativeStackNavigationProp<RootStackParamList>, 'navigate'>,
  enabled: boolean,
  receiveHardwareInputs = true,
) {
  const inputs = useScheduleInputs();
  const { showDialog } = useAppDialog();
  const active = useRef(enabled);
  const epoch = useRef(0);
  if (active.current !== enabled) epoch.current++;
  active.current = enabled;
  const opening = useRef<string | null>(null);
  const offered = useRef(new Set<string>());
  const sequence = useRef(0);
  const [resume, setResume] = useState<ScheduleEditorResumeSelection | null>(null);
  const resumeRef = useRef<ScheduleEditorResumeSelection | null>(null);
  const dismissResume = useCallback(() => { resumeRef.current = null; setResume(null); }, []);
  useEffect(() => {
    active.current = enabled;
    const state = AppState.addEventListener('change', value => {
      if (value !== 'active') { epoch.current++; dismissResume(); }
    });
    return () => { active.current = false; epoch.current++; state.remove(); };
  }, [dismissResume, enabled]);
  useEffect(() => { if (!enabled) dismissResume(); }, [dismissResume, enabled]);

  const valid = useCallback((owner: number) => active.current && epoch.current === owner
    && AppState.currentState === 'active', []);

  const create = useCallback(async (entry: EditorEntry = {}): Promise<void> => {
    if (!valid(epoch.current) || opening.current || resumeRef.current) return;
    opening.current = 'editor-entry';
    const owner = epoch.current, request = ++sequence.current;
    try {
      const adopted = entry.followup ? await findScheduleEditorFollowup(entry.followup) : null;
      if (!valid(owner)) return;
      if (adopted?.phase === 'saved' && adopted.savedEventRef) {
        navigation.navigate('EventDetail', { eventRef: adopted.savedEventRef });
        return;
      }
      const drafts = adopted ? [adopted] : (await listUnfinishedScheduleEditorDrafts())
        .filter(draft => isScheduleEditorResumeCandidate(draft, entry));
      if (!valid(owner)) return;
      if (drafts.length) {
        const selection = { entry, drafts, epoch: owner, sequence: request };
        resumeRef.current = selection; setResume(selection);
      } else navigation.navigate('AddEvent', entry);
    } catch (reason) {
      diagnosticWarn('open schedule editor entry failed', reason);
      if (valid(owner)) showDialog({ title: '日程暂时无法打开', actions: [
        { text: '取消', role: 'cancel' }, { text: '重试', onPress: () => { void create(entry); } },
      ] });
    } finally { opening.current = null; }
  }, [navigation, showDialog, valid]);

  const chooseResume = useCallback(async (selection: ScheduleEditorResumeSelection, id: string | null): Promise<void> => {
    if (!valid(selection.epoch) || sequence.current !== selection.sequence || opening.current) return;
    // A received/adopted input has one save identity; it is not a new blank entry.
    if (id === null && (selection.entry.followup || selection.entry.draft)) return;
    sequence.current++; dismissResume();
    if (id === null) { navigation.navigate('AddEvent', selection.entry); return; }
    if (!selection.drafts.some(draft => draft.id === id)) return;
    opening.current = id;
    try {
      const draft = await loadStoredScheduleEditorDraft(id, selection.entry.followup);
      if (!valid(selection.epoch)) return;
      if (!draft) throw new Error('草稿已不存在');
      if (draft.phase === 'saved' && draft.savedEventRef) navigation.navigate('EventDetail', { eventRef: draft.savedEventRef });
      else navigation.navigate('AddEvent', { ...selection.entry, editorDraftId: draft.id });
    } catch (reason) {
      diagnosticWarn('resume schedule editor failed', reason);
      if (valid(selection.epoch)) showDialog({ title: '草稿暂时无法打开', actions: [
        { text: '取消', role: 'cancel' }, { text: '重试', onPress: () => { void create(selection.entry); } },
      ] });
    } finally { opening.current = null; }
  }, [create, dismissResume, navigation, valid]);
  const open = useCallback(async (job: ScheduleInputJob): Promise<void> => {
    if (!active.current || opening.current || resumeRef.current || AppState.currentState !== 'active' || job.state === 'pending') return;
    opening.current = job.id;
    const owner = epoch.current;
    try {
      if (job.state === 'failed') {
        await retryScheduleInput(job.id);
        offered.current.delete(job.id);
        inputs.refresh();
        return;
      }
      const draft = await openScheduleInputEditorDraft(job);
      if (!active.current || epoch.current !== owner || AppState.currentState !== 'active') return;
      offered.current.add(job.id);
      if (draft.phase === 'saved' && draft.savedEventRef) navigation.navigate('EventDetail', { eventRef: draft.savedEventRef });
      else navigation.navigate('AddEvent', { editorDraftId: draft.id });
    } catch (reason) {
      offered.current.add(job.id); // Remains available for an explicit retry; no poll-driven error loop.
      diagnosticWarn('open received schedule editor failed', reason);
      if (active.current && epoch.current === owner) showDialog({ title: '日程暂时无法打开', actions: [
        { text: '取消', role: 'cancel' }, { text: '重试', onPress: () => { void open(job); } },
      ] });
    } finally { opening.current = null; }
  }, [inputs.refresh, navigation, showDialog]);
  useEffect(() => {
    if (!enabled || !receiveHardwareInputs) return;
    const next = inputs.jobs.find(job => job.state === 'ready' && !offered.current.has(job.id));
    if (next) void open(next);
  }, [enabled, inputs.jobs, open, receiveHardwareInputs]);
  return { ...inputs, open, create, resume, chooseResume, dismissResume };
}
