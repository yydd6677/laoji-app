import {
  assertScopeKey,
  secureClientIdFactory,
  type MeetingSummaryCarryForwardAuthorization,
  type MeetingSummaryCarryForwardItem,
  type ScopeKey,
} from '../domain/meeting';
import {
  resolveMeetingSeriesMemoryForMeeting,
  type MeetingSeriesMemoryAction,
  type MeetingSeriesMemoryDecision,
  type MeetingSeriesMemoryProjection,
} from './meetingSeriesMemory';

const MAX_CARRY_ITEMS = 8;

export interface MeetingSummaryCarryForwardSelection {
  decisionIds: readonly string[];
  actionIds: readonly string[];
}

export class MeetingSummaryCarryForwardSelectionStaleError extends Error {
  constructor() {
    super('summary carry-forward selection is stale');
    this.name = 'MeetingSummaryCarryForwardSelectionStaleError';
  }
}

function selectedIds(values: readonly string[]): string[] {
  const normalized = values.map(value => value.trim());
  if (
    normalized.some(value => !value || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value))
    || new Set(normalized).size !== normalized.length
  ) throw new MeetingSummaryCarryForwardSelectionStaleError();
  return normalized;
}

function boundedText(value: string, maximum: number): string {
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  if (!normalized || normalized.length > maximum || /\u0000/.test(normalized)) {
    throw new MeetingSummaryCarryForwardSelectionStaleError();
  }
  return normalized;
}

function sourceMeetingId(
  _scopeKey: ScopeKey,
  item: MeetingSeriesMemoryDecision | MeetingSeriesMemoryAction,
): string {
  return boundedText(item.legacyMeetingId, 160);
}

function sourceDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new MeetingSummaryCarryForwardSelectionStaleError();
  }
  return value;
}

function decisionItem(
  scopeKey: ScopeKey,
  decision: MeetingSeriesMemoryDecision,
): MeetingSummaryCarryForwardItem {
  return {
    kind: 'decision',
    sourceMeetingId: sourceMeetingId(scopeKey, decision),
    sourceItemId: boundedText(decision.id, 512),
    sourceTitle: decision.sourceMeetingTitle.trim().slice(0, 255),
    sourceOccurrenceDate: sourceDate(decision.occurrenceDate),
    content: boundedText(decision.content, 2_000),
    assignee: null,
    dueAt: null,
  };
}

function actionItem(
  scopeKey: ScopeKey,
  action: MeetingSeriesMemoryAction,
): MeetingSummaryCarryForwardItem {
  const due = action.dueAtMs === null ? null : new Date(action.dueAtMs);
  if (due && Number.isNaN(due.getTime())) throw new MeetingSummaryCarryForwardSelectionStaleError();
  return {
    kind: 'action',
    sourceMeetingId: sourceMeetingId(scopeKey, action),
    sourceItemId: boundedText(action.id, 512),
    sourceTitle: action.sourceMeetingTitle.trim().slice(0, 255),
    sourceOccurrenceDate: sourceDate(action.occurrenceDate),
    content: boundedText(action.content, 2_000),
    assignee: action.assigneeText?.trim().slice(0, 200) || null,
    dueAt: due?.toISOString() ?? null,
  };
}

export async function resolveMeetingSummaryCarryForwardMemory(
  scopeKey: ScopeKey,
  meetingId: string,
): Promise<MeetingSeriesMemoryProjection | null> {
  assertScopeKey(scopeKey);
  return resolveMeetingSeriesMemoryForMeeting(scopeKey, meetingId);
}

export async function authorizeMeetingSummaryCarryForward(input: {
  scopeKey: ScopeKey;
  meetingId: string;
  selection: MeetingSummaryCarryForwardSelection;
}): Promise<MeetingSummaryCarryForwardAuthorization> {
  assertScopeKey(input.scopeKey);
  const decisionIds = selectedIds(input.selection.decisionIds);
  const actionIds = selectedIds(input.selection.actionIds);
  if (
    decisionIds.length + actionIds.length < 1
    || decisionIds.length + actionIds.length > MAX_CARRY_ITEMS
  ) throw new MeetingSummaryCarryForwardSelectionStaleError();

  const memory = await resolveMeetingSeriesMemoryForMeeting(input.scopeKey, input.meetingId);
  if (!memory) throw new MeetingSummaryCarryForwardSelectionStaleError();
  const decisionSet = new Set(decisionIds);
  const actionSet = new Set(actionIds);
  const decisions = memory.decisions.filter(item => decisionSet.has(item.id));
  const actions = memory.pendingActions.filter(item => actionSet.has(item.id));
  if (decisions.length !== decisionSet.size || actions.length !== actionSet.size) {
    throw new MeetingSummaryCarryForwardSelectionStaleError();
  }

  return {
    requestId: secureClientIdFactory.create(),
    items: [
      ...decisions.map(item => decisionItem(input.scopeKey, item)),
      ...actions.map(item => actionItem(input.scopeKey, item)),
    ],
  };
}
