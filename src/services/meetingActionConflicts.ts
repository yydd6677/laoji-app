import type {
  ActionItemRecord,
  MeetingActionSyncConflictRecord,
} from '../data/repositories';

type UnknownRecord = Record<string, unknown>;

export interface MeetingActionRemoteConflictVersion {
  remoteId: string;
  revision: number;
  clientCreatedAtMs: number;
  clientUpdatedAtMs: number;
  userEditedAtMs: number | null;
  completedAtMs: number | null;
  content: string;
  status: ActionItemRecord['status'];
  assigneeText: string | null;
  dueAtMs: number | null;
  reminderAtMs: number | null;
  followupEventSourceId: string | null;
  sourceKind: ActionItemRecord['sourceKind'];
  sourceSummaryVersionId: string | null;
  sourceSegmentId: string | null;
  sourceStartMs: number | null;
  generationFingerprint: string | null;
}

export interface MeetingActionSyncConflictView {
  id: string;
  meetingId: string;
  actionId: string;
  createdAtMs: number;
  localRevision: number | null;
  local: ActionItemRecord;
  remoteIdentity: { remoteId: string; revision: number } | null;
  remote: MeetingActionRemoteConflictVersion | null;
  remoteMissing: boolean;
  invalidRemotePayload: boolean;
  contractCode: string | null;
  canKeepLocal: boolean;
  canUseRemote: boolean;
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identifier(value: unknown, maximum = 512): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum && !/[\u0000-\u001f\u007f]/.test(normalized)
    ? normalized
    : null;
}

function safeInteger(value: unknown, minimum = 0): number | null {
  return Number.isSafeInteger(value) && Number(value) >= minimum ? Number(value) : null;
}

function optionalTime(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const parsed = safeInteger(value);
  return parsed === null ? undefined : parsed;
}

function nullableText(value: unknown, maximum: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (normalized.length > maximum || normalized.includes('\u0000')) return undefined;
  return normalized || null;
}

function nullableIdentifier(value: unknown, maximum = 512): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return identifier(value, maximum) ?? undefined;
}

function actionStatus(value: unknown): ActionItemRecord['status'] | null {
  return value === 'pending' || value === 'completed' || value === 'dismissed'
    ? value
    : null;
}

function sourceKind(value: unknown): ActionItemRecord['sourceKind'] | null {
  return value === 'generated' || value === 'manual' || value === 'marker' ? value : null;
}

export function meetingActionSyncConflictView(
  action: ActionItemRecord,
  conflict: MeetingActionSyncConflictRecord,
): MeetingActionSyncConflictView {
  let payload: unknown = null;
  try {
    payload = JSON.parse(conflict.remotePayloadJson) as unknown;
  } catch {
    payload = Symbol('invalid');
  }
  const wrapper = isRecord(payload) && (
    Object.prototype.hasOwnProperty.call(payload, 'current')
    || Object.prototype.hasOwnProperty.call(payload, 'error_code')
  ) ? payload : null;
  const contractCode = identifier(wrapper?.error_code, 160);
  const current = wrapper ? wrapper.current : payload;
  const remoteMissing = current === null;
  const record = isRecord(current) ? current : null;
  const remoteId = identifier(record?.id ?? record?.remote_id, 160);
  const revision = safeInteger(record?.revision ?? conflict.remoteRevision, 1);
  const matchingRevision = revision !== null && (
    conflict.remoteRevision === null || conflict.remoteRevision === revision
  );
  const remoteIdentity = remoteId && matchingRevision ? { remoteId, revision } : null;
  const clientActionId = identifier(record?.client_action_id);
  const clientCreatedAtMs = safeInteger(record?.client_created_at_ms);
  const clientUpdatedAtMs = safeInteger(record?.client_updated_at_ms);
  const userEditedAtMs = optionalTime(record?.user_edited_at_ms);
  const completedAtMs = optionalTime(record?.completed_at_ms);
  const content = typeof record?.content === 'string' ? record.content.trim() : '';
  const status = actionStatus(record?.status);
  const assigneeText = nullableText(record?.assignee, 500);
  const dueAtMs = optionalTime(record?.due_at_ms);
  const rawReminderAtMs = optionalTime(record?.reminder_at_ms);
  const followupEventSourceId = nullableIdentifier(record?.followup_event_source_id);
  const remoteSourceKind = sourceKind(record?.source_kind);
  const sourceSummaryVersionId = nullableIdentifier(record?.source_summary_version_id);
  const sourceSegmentId = nullableIdentifier(record?.source_segment_id);
  const sourceStartMs = optionalTime(record?.source_start_ms);
  const generationFingerprint = nullableIdentifier(record?.generation_fingerprint);
  const completionValid = Boolean(
    status
    && ((status === 'completed') === (completedAtMs !== null))
    && completedAtMs !== undefined
    && (
      completedAtMs === null
      || (
        clientCreatedAtMs !== null
        && clientUpdatedAtMs !== null
        && completedAtMs >= clientCreatedAtMs
        && completedAtMs <= clientUpdatedAtMs
      )
    )
  );
  const reminderValid = rawReminderAtMs !== undefined && (
    rawReminderAtMs === null || (status === 'pending' && dueAtMs !== null)
  );
  const generationValid = Boolean(
    remoteSourceKind
    && generationFingerprint !== undefined
    && (remoteSourceKind === 'generated' || generationFingerprint === null)
  );
  const fieldsValid = Boolean(
    remoteIdentity
    && clientActionId === action.id
    && clientCreatedAtMs !== null
    && clientUpdatedAtMs !== null
    && clientCreatedAtMs <= clientUpdatedAtMs
    && userEditedAtMs !== undefined
    && (userEditedAtMs === null || userEditedAtMs <= clientUpdatedAtMs)
    && content
    && content.length <= 20_000
    && !content.includes('\u0000')
    && status
    && assigneeText !== undefined
    && dueAtMs !== undefined
    && reminderValid
    && completionValid
    && followupEventSourceId !== undefined
    && remoteSourceKind
    && sourceSummaryVersionId !== undefined
    && sourceSegmentId !== undefined
    && sourceStartMs !== undefined
    && generationValid
  );
  const remote = fieldsValid ? {
    remoteId: remoteIdentity!.remoteId,
    revision: remoteIdentity!.revision,
    clientCreatedAtMs: clientCreatedAtMs!,
    clientUpdatedAtMs: clientUpdatedAtMs!,
    userEditedAtMs: userEditedAtMs ?? null,
    completedAtMs: completedAtMs ?? null,
    content,
    status: status!,
    assigneeText: assigneeText ?? null,
    dueAtMs: dueAtMs ?? null,
    reminderAtMs: rawReminderAtMs ?? null,
    followupEventSourceId: followupEventSourceId ?? null,
    sourceKind: remoteSourceKind!,
    sourceSummaryVersionId: sourceSummaryVersionId ?? null,
    sourceSegmentId: sourceSegmentId ?? null,
    sourceStartMs: sourceStartMs ?? null,
    generationFingerprint: generationFingerprint ?? null,
  } : null;
  const identityMatches = Boolean(remote
    && remote.clientCreatedAtMs === action.createdAtMs
    && remote.sourceKind === action.sourceKind
    && remote.sourceSummaryVersionId === action.sourceSummaryVersionId
    && remote.sourceSegmentId === (action.sourceSegmentSourceId ?? action.sourceSegmentId)
    && remote.sourceStartMs === action.sourceStartMs
    && remote.generationFingerprint === action.generationFingerprint);
  const invalidRemotePayload = !remoteMissing && remote === null;
  return {
    id: conflict.id,
    meetingId: conflict.meetingId,
    actionId: conflict.actionId,
    createdAtMs: conflict.createdAtMs,
    localRevision: conflict.localRevision,
    local: action,
    remoteIdentity,
    remote,
    remoteMissing,
    invalidRemotePayload,
    contractCode,
    canKeepLocal: remoteMissing ? conflict.remoteRevision === null : remoteIdentity !== null,
    canUseRemote: remote !== null && identityMatches,
  };
}
