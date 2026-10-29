import { initialScheduleEditorChanges, initialScheduleEditorDate, type ScheduleEditorDraft, type ScheduleInputMode } from '../domain/scheduleEditor';
import { parseText } from './scheduleParsing';
import { editScheduleDraftV1 } from './scheduleEditV1';

export function defaultScheduleEditorInputMode(draft: ScheduleEditorDraft): ScheduleInputMode {
  return draft.mode === 'create' && !draft.title.trim() && !draft.location.trim() && !draft.notes.trim()
    && draft.time.precision === 'unspecified' && draft.repeat === 'once' && draft.reminderMinutes === null
    && !Object.values(draft.fieldOrigins).some(origin => origin === 'manual' || origin === 'explicit')
    ? 'initial' : 'patch';
}

export async function observeScheduleEditorInput(draft: ScheduleEditorDraft, signal?: AbortSignal) {
  const op = draft.pendingInput;
  if (!op?.text.trim()) throw new Error('未识别到清晰语音，可重新输入');
  if (op.text.length > 2000) throw new Error('本次内容过长，请缩短后重试');
  if (op.mode !== 'patch') {
    const parsed = await parseText(op.text, { reference_datetime: op.referenceDatetime, timezone: op.timezone });
    // Replacement interprets fresh content, not an edit against old fields.
    // An old manual date is not an entry context for this new input.
    const context = { referenceDatetime: op.referenceDatetime, timezone: op.timezone,
      entryDate: op.mode === 'initial' && ['context', 'manual'].includes(draft.fieldOrigins.startDate ?? '') ? draft.startDate : null };
    return { status: 'patch' as const, changes: initialScheduleEditorChanges(parsed, context),
      origins: { startDate: initialScheduleEditorDate(parsed, context).origin } };
  }
  return editScheduleDraftV1(draft, op, signal);
}
