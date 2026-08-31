import type { CalEvent } from '../../types';
import { sqliteMeetingNoteRepository } from "../../data/repositories/sqliteMeetingNoteRepository";
import type { MeetingSeriesCarryImportRecord } from "../../data/repositories/meetingNoteRepository";
import { assertScopeKey, type ScopeKey } from '../../domain/meeting';
import {
  resolveMeetingSeriesMemory,
  type MeetingSeriesMemoryAction,
  type MeetingSeriesMemoryDecision,
} from '../../services/meetingSeriesMemory';
import {
  openOccurrenceMeeting,
  type CreateOccurrenceMeeting,
} from './openOccurrenceMeeting';
import {
  ManualNoteRevisionConflictError,
  SaveManualNoteUseCase,
} from './saveManualNote';

const MAX_CARRY_ITEMS = 8;
const operations = new Map<string, Promise<CarrySeriesMemoryToManualNoteResult>>();
const saveManualNote = new SaveManualNoteUseCase(sqliteMeetingNoteRepository);

export class SeriesMemoryCarrySelectionStaleError extends Error {
  constructor() {
    super('series memory carry selection is stale');
    this.name = 'SeriesMemoryCarrySelectionStaleError';
  }
}

export class SeriesMemoryCarryNoteConflictError extends Error {
  constructor() {
    super('series memory carry target note changed');
    this.name = 'SeriesMemoryCarryNoteConflictError';
  }
}

export interface CarrySeriesMemoryToManualNoteInput {
  scopeKey: ScopeKey;
  event: CalEvent;
  decisionIds: readonly string[];
  actionIds: readonly string[];
  createMeeting: CreateOccurrenceMeeting;
}

export interface CarrySeriesMemoryToManualNoteResult {
  meetingId: string;
  canonicalMeetingId: string;
  noteRevision: number;
  applied: boolean;
}

type SourceGroup = {
  canonicalMeetingId: string;
  sourceMeetingTitle: string;
  occurrenceDate: string;
  decisions: MeetingSeriesMemoryDecision[];
  actions: MeetingSeriesMemoryAction[];
};

function normalizedSelectionIds(values: readonly string[]): string[] {
  const ids = values.map(value => value.trim());
  if (
    ids.some(value => !value || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value))
    || new Set(ids).size !== ids.length
  ) throw new SeriesMemoryCarrySelectionStaleError();
  return ids;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function sourceDateLabel(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  return `${Number(match[1])}年${Number(match[2])}月${Number(match[3])}日`;
}

function actionLine(action: MeetingSeriesMemoryAction): string {
  const metadata: string[] = [];
  if (action.assigneeText?.trim()) metadata.push(`负责人：${singleLine(action.assigneeText)}`);
  if (action.dueAtMs !== null) {
    const due = new Date(action.dueAtMs);
    if (!Number.isNaN(due.getTime())) {
      metadata.push(`截止：${due.getFullYear()}年${due.getMonth() + 1}月${due.getDate()}日`);
    }
  }
  const suffix = metadata.length > 0 ? `（${metadata.join('；')}）` : '';
  return `- ${singleLine(action.content)}${suffix}`;
}

function carryBlock(
  decisions: readonly MeetingSeriesMemoryDecision[],
  actions: readonly MeetingSeriesMemoryAction[],
): string {
  const groups = new Map<string, SourceGroup>();
  const groupFor = (
    item: MeetingSeriesMemoryDecision | MeetingSeriesMemoryAction,
  ): SourceGroup => {
    const key = `${item.canonicalMeetingId}\u0000${item.occurrenceDate}`;
    const current = groups.get(key);
    if (current) return current;
    const created: SourceGroup = {
      canonicalMeetingId: item.canonicalMeetingId,
      sourceMeetingTitle: item.sourceMeetingTitle,
      occurrenceDate: item.occurrenceDate,
      decisions: [],
      actions: [],
    };
    groups.set(key, created);
    return created;
  };
  decisions.forEach(item => groupFor(item).decisions.push(item));
  actions.forEach(item => groupFor(item).actions.push(item));

  return [...groups.values()].map(group => {
    const source = [
      sourceDateLabel(group.occurrenceDate),
      singleLine(group.sourceMeetingTitle),
    ].filter(Boolean).join(' · ');
    const lines = [`来自 ${source}`];
    if (group.decisions.length > 0) {
      lines.push('决定', ...group.decisions.map(item => `- ${singleLine(item.content)}`));
    }
    if (group.actions.length > 0) {
      lines.push('未完成事项', ...group.actions.map(actionLine));
    }
    return lines.join('\n');
  }).join('\n\n');
}

function appendBlock(current: string, block: string): string {
  if (!current) return block;
  if (current.includes(block)) return current;
  const separator = current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n';
  return `${current}${separator}${block}`;
}

function carryImportRecord(
  targetMeetingId: string,
  kind: 'decision' | 'action',
  item: MeetingSeriesMemoryDecision | MeetingSeriesMemoryAction,
  importedAtMs: number,
): MeetingSeriesCarryImportRecord {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(item.occurrenceDate)) {
    throw new SeriesMemoryCarrySelectionStaleError();
  }
  const decisionCitation = kind === 'decision'
    ? (item as MeetingSeriesMemoryDecision).citations[0]
    : null;
  const action = kind === 'action' ? item as MeetingSeriesMemoryAction : null;
  return {
    targetMeetingId,
    sourceMeetingId: item.canonicalMeetingId,
    sourceKind: kind,
    sourceItemId: item.id,
    sourceOccurrenceDate: item.occurrenceDate,
    sourceTitle: item.sourceMeetingTitle,
    contentSnapshot: item.content,
    assigneeSnapshot: action?.assigneeText ?? null,
    dueAtMs: action?.dueAtMs ?? null,
    sourceSegmentId: decisionCitation
      ? decisionCitation.sourceSegmentId ?? decisionCitation.segmentId
      : action?.sourceSegmentSourceId ?? action?.sourceSegmentId ?? null,
    sourceStartMs: decisionCitation?.startMs ?? action?.sourceStartMs ?? null,
    importedAtMs,
  };
}

function operationKey(
  input: CarrySeriesMemoryToManualNoteInput,
  decisionIds: readonly string[],
  actionIds: readonly string[],
): string {
  return JSON.stringify([
    input.scopeKey,
    input.event.sourceEventId ?? input.event.id,
    input.event.occurrenceDate ?? input.event.startDate,
    [...decisionIds].sort(),
    [...actionIds].sort(),
  ]);
}

async function executeCarry(
  input: CarrySeriesMemoryToManualNoteInput,
  decisionIds: readonly string[],
  actionIds: readonly string[],
): Promise<CarrySeriesMemoryToManualNoteResult> {
  const memory = await resolveMeetingSeriesMemory(input.scopeKey, input.event);
  if (!memory) throw new SeriesMemoryCarrySelectionStaleError();
  const decisionSet = new Set(decisionIds);
  const actionSet = new Set(actionIds);
  const decisions = memory.decisions.filter(item => decisionSet.has(item.id));
  const actions = memory.pendingActions.filter(item => actionSet.has(item.id));
  if (decisions.length !== decisionSet.size || actions.length !== actionSet.size) {
    throw new SeriesMemoryCarrySelectionStaleError();
  }
  if (!carryBlock(decisions, actions)) throw new SeriesMemoryCarrySelectionStaleError();

  const target = await openOccurrenceMeeting({
    scopeKey: input.scopeKey,
    event: input.event,
    entryPoint: 'calendar_detail',
    createMeeting: input.createMeeting,
  });
  let result: CarrySeriesMemoryToManualNoteResult | null = null;
  try {
    await sqliteMeetingNoteRepository.transaction(async transaction => {
      const note = await transaction.findMeetingByNativeSessionId(
        target.projection.meetingId,
        input.scopeKey,
      );
      if (!note || note.lifecycle === 'deleted') {
        throw new Error('series memory carry target is unavailable');
      }
      const manualNote = await transaction.getManualNote(note.id, input.scopeKey);
      if (!manualNote) throw new Error('series memory carry target note is unavailable');
      const importedAtMs = Date.now();
      if (!Number.isSafeInteger(importedAtMs) || importedAtMs < 0) {
        throw new Error('series memory carry clock is invalid');
      }
      const insertedDecisions: MeetingSeriesMemoryDecision[] = [];
      const insertedActions: MeetingSeriesMemoryAction[] = [];
      for (const decision of decisions) {
        if (await transaction.insertSeriesCarryImport(
          carryImportRecord(note.id, 'decision', decision, importedAtMs),
          input.scopeKey,
        )) insertedDecisions.push(decision);
      }
      for (const action of actions) {
        if (await transaction.insertSeriesCarryImport(
          carryImportRecord(note.id, 'action', action, importedAtMs),
          input.scopeKey,
        )) insertedActions.push(action);
      }
      if (insertedDecisions.length === 0 && insertedActions.length === 0) {
        result = {
          meetingId: target.projection.meetingId,
          canonicalMeetingId: note.id,
          noteRevision: manualNote.revision,
          applied: false,
        };
        return;
      }
      const insertedBlock = carryBlock(insertedDecisions, insertedActions);
      const saved = await saveManualNote.executeInTransaction(transaction, {
        meetingId: note.id,
        scopeKey: input.scopeKey,
        content: appendBlock(manualNote.content, insertedBlock),
        expectedRevision: manualNote.revision,
      });
      result = {
        meetingId: target.projection.meetingId,
        canonicalMeetingId: note.id,
        noteRevision: saved.note.revision,
        applied: saved.applied,
      };
    });
  } catch (error) {
    if (error instanceof ManualNoteRevisionConflictError) {
      throw new SeriesMemoryCarryNoteConflictError();
    }
    throw error;
  }
  if (!result) throw new Error('series memory carry transaction produced no result');
  return result;
}

export function carrySeriesMemoryToManualNote(
  input: CarrySeriesMemoryToManualNoteInput,
): Promise<CarrySeriesMemoryToManualNoteResult> {
  assertScopeKey(input.scopeKey);
  const decisionIds = normalizedSelectionIds(input.decisionIds);
  const actionIds = normalizedSelectionIds(input.actionIds);
  if (
    decisionIds.length + actionIds.length < 1
    || decisionIds.length + actionIds.length > MAX_CARRY_ITEMS
  ) throw new SeriesMemoryCarrySelectionStaleError();
  const key = operationKey(input, decisionIds, actionIds);
  const current = operations.get(key);
  if (current) return current;
  const operation = executeCarry(input, decisionIds, actionIds).finally(() => {
    if (operations.get(key) === operation) operations.delete(key);
  });
  operations.set(key, operation);
  return operation;
}
