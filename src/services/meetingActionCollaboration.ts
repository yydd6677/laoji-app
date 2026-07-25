import {
  createMeetingActionShareRemote,
  loadMeetingCapabilities,
  MeetingActionShareConflictError,
  revokeMeetingActionShareRemote,
} from '../data/api/v2';
import {
  beginRevokeMeetingActionShare,
  completeMeetingActionShareCreate,
  completeMeetingActionShareRevoke,
  failMeetingActionShareOperation,
  insertPendingMeetingActionShare,
  listMeetingActionShares,
  markMeetingActionShareAttempt,
  restartMeetingActionShareCreate,
  sqliteMeetingNoteRepository,
} from '../data/repositories';
import {
  assertScopeKey,
  secureClientIdFactory,
  type MeetingActionShare,
  type MeetingActionSharePermission,
  type ScopeKey,
} from '../domain/meeting';
import { requestMeetingActionSync } from '../application/meeting/actionSyncTrigger';
import { HttpResponseError } from './errors';
import { getAppStorageItem, setAppStorageItem } from './appStorage';

const COLLABORATOR_ID_KEY = '@laoji:actionCollaboratorId:v1';

type ActionShareContext = {
  canonicalMeetingId: string;
  meetingRemoteId: string | null;
  actionId: string;
  actionRemoteRevision: number | null;
};

async function actionShareContext(
  scopeKey: ScopeKey,
  meetingId: string,
  actionId: string,
): Promise<ActionShareContext> {
  assertScopeKey(scopeKey);
  const aggregate = await sqliteMeetingNoteRepository.findByNativeSessionId(meetingId, scopeKey);
  if (!aggregate || aggregate.note.lifecycle === 'deleted') throw new Error('会议记录已不可用。');
  const action = (await sqliteMeetingNoteRepository.listMeetingActions(
    aggregate.note.id,
    scopeKey,
  )).find(candidate => candidate.id === actionId) ?? null;
  if (!action) throw new Error('待办事项已发生变化，请刷新后重试。');
  return {
    canonicalMeetingId: aggregate.note.id,
    meetingRemoteId: aggregate.note.remoteId,
    actionId: action.id,
    actionRemoteRevision: action.remoteRevision,
  };
}

function errorCode(reason: unknown): string {
  if (reason instanceof MeetingActionShareConflictError) {
    return reason.code === 'share_revision_conflict'
      ? 'share_revision_changed'
      : 'action_revision_changed';
  }
  if (reason instanceof HttpResponseError) {
    if (reason.status === 401) return 'auth_unauthorized';
    if ([403, 404, 405, 501].includes(reason.status)) return 'collaboration_not_available';
    return `http_${reason.status}`;
  }
  const message = reason instanceof Error ? reason.message.toLowerCase() : '';
  if (message.includes('capabilit')) return 'capability_unavailable';
  return 'network_or_timeout';
}

function blockedError(code: string): boolean {
  return [
    'auth_unauthorized',
    'collaboration_not_available',
    'action_revision_changed',
    'share_revision_changed',
  ].includes(code);
}

export function meetingActionShareErrorMessage(
  value: MeetingActionShare | null,
  fallback = '共享暂时不可用，请稍后重试。',
): string {
  switch (value?.lastErrorCode) {
    case 'action_not_synced':
      return '待办事项正在同步，完成后可重试共享。';
    case 'capability_unavailable':
    case 'network_or_timeout':
      return '当前无法连接共享服务，请稍后重试。';
    case 'collaboration_not_available':
      return '当前服务暂不支持待办协作。';
    case 'auth_unauthorized':
      return '登录状态已失效，请重新登录后再试。';
    case 'action_revision_changed':
      return '待办事项已更新，请重新创建共享链接。';
    case 'share_revision_changed':
      return '共享设置已在其他设备更新，请重新打开。';
    default:
      return fallback;
  }
}

async function requireRemoteCapability(accessToken: string): Promise<void> {
  const capability = await loadMeetingCapabilities({
    accessToken,
    forceRefresh: true,
    allowStaleOnError: false,
  });
  if (capability.source !== 'remote' || !capability.capabilities.actionCollaborationV1) {
    throw new HttpResponseError('当前服务暂不支持待办协作', 501);
  }
}

async function processCreate(
  scopeKey: ScopeKey,
  accessToken: string,
  share: MeetingActionShare,
  context: ActionShareContext,
): Promise<MeetingActionShare> {
  const attempted = await markMeetingActionShareAttempt({
    shareId: share.id,
    scopeKey,
    operationId: share.operationId,
    status: 'pending',
    updatedAtMs: Date.now(),
  });
  if (!context.meetingRemoteId || attempted.expectedActionRemoteRevision === null) {
    requestMeetingActionSync(scopeKey);
    const failed = await failMeetingActionShareOperation({
      shareId: attempted.id,
      scopeKey,
      operationId: attempted.operationId,
      disposition: 'failed_retryable',
      errorCode: 'action_not_synced',
      updatedAtMs: Date.now(),
    });
    throw new Error(meetingActionShareErrorMessage(failed));
  }
  try {
    await requireRemoteCapability(accessToken);
    const remote = await createMeetingActionShareRemote({
      accessToken,
      meetingRemoteId: context.meetingRemoteId,
      clientActionId: context.actionId,
      clientShareId: attempted.id,
      permission: attempted.permission,
      expectedActionRevision: attempted.expectedActionRemoteRevision,
      idempotencyKey: attempted.operationId,
    });
    if (remote.permission !== attempted.permission || remote.status !== 'active' || !remote.inviteUrl) {
      throw new Error('共享服务返回了不一致的权限。');
    }
    return completeMeetingActionShareCreate({
      shareId: attempted.id,
      scopeKey,
      operationId: attempted.operationId,
      remoteId: remote.remoteId,
      remoteRevision: remote.revision,
      inviteUrl: remote.inviteUrl,
      updatedAtMs: Date.now(),
    });
  } catch (reason) {
    const code = errorCode(reason);
    const failed = await failMeetingActionShareOperation({
      shareId: attempted.id,
      scopeKey,
      operationId: attempted.operationId,
      disposition: blockedError(code) ? 'blocked' : 'failed_retryable',
      errorCode: code,
      updatedAtMs: Date.now(),
    }).catch(() => null);
    throw new Error(meetingActionShareErrorMessage(failed));
  }
}

export async function loadMeetingActionShares(input: {
  scopeKey: ScopeKey;
  meetingId: string;
  actionId: string;
}): Promise<{ context: ActionShareContext; shares: readonly MeetingActionShare[] }> {
  const context = await actionShareContext(input.scopeKey, input.meetingId, input.actionId);
  return {
    context,
    shares: await listMeetingActionShares(
      context.canonicalMeetingId,
      context.actionId,
      input.scopeKey,
    ),
  };
}

export async function createMeetingActionShare(input: {
  scopeKey: ScopeKey;
  meetingId: string;
  actionId: string;
  permission: MeetingActionSharePermission;
  accessToken: string;
}): Promise<MeetingActionShare> {
  assertScopeKey(input.scopeKey);
  if (input.scopeKey === 'guest' || !input.accessToken) throw new Error('登录后才能共享待办事项。');
  const context = await actionShareContext(input.scopeKey, input.meetingId, input.actionId);
  const createdAtMs = Date.now();
  const pending = await insertPendingMeetingActionShare({
    id: secureClientIdFactory.create(),
    meetingId: context.canonicalMeetingId,
    actionId: context.actionId,
    scopeKey: input.scopeKey,
    permission: input.permission,
    expectedActionRemoteRevision: context.actionRemoteRevision,
    operationId: secureClientIdFactory.create(),
    createdAtMs,
  });
  return processCreate(input.scopeKey, input.accessToken, pending, context);
}

export async function retryMeetingActionShare(input: {
  scopeKey: ScopeKey;
  meetingId: string;
  share: MeetingActionShare;
  accessToken: string;
}): Promise<MeetingActionShare> {
  assertScopeKey(input.scopeKey);
  if (input.scopeKey === 'guest' || !input.accessToken) throw new Error('登录后才能重试共享。');
  const context = await actionShareContext(
    input.scopeKey,
    input.meetingId,
    input.share.actionId,
  );
  if (input.share.pendingOperation === 'create') {
    let share = input.share;
    if (
      context.actionRemoteRevision !== null
      && (
        share.expectedActionRemoteRevision === null
        || share.lastErrorCode === 'action_revision_changed'
      )
    ) {
      share = await restartMeetingActionShareCreate({
        shareId: share.id,
        scopeKey: input.scopeKey,
        operationId: secureClientIdFactory.create(),
        expectedActionRemoteRevision: context.actionRemoteRevision,
        updatedAtMs: Date.now(),
      });
    }
    return processCreate(input.scopeKey, input.accessToken, share, context);
  }
  if (input.share.pendingOperation !== 'revoke') throw new Error('这条共享记录无需重试。');
  return processRevoke(input.scopeKey, input.accessToken, input.share, context);
}

async function processRevoke(
  scopeKey: ScopeKey,
  accessToken: string,
  share: MeetingActionShare,
  context: ActionShareContext,
): Promise<MeetingActionShare> {
  if (!context.meetingRemoteId || share.remoteRevision === null) {
    throw new Error('共享云端状态已发生变化，请重新打开。');
  }
  const attempted = await markMeetingActionShareAttempt({
    shareId: share.id,
    scopeKey,
    operationId: share.operationId,
    status: 'revoking',
    updatedAtMs: Date.now(),
  });
  try {
    await requireRemoteCapability(accessToken);
    const remote = await revokeMeetingActionShareRemote({
      accessToken,
      meetingRemoteId: context.meetingRemoteId,
      clientActionId: context.actionId,
      clientShareId: attempted.id,
      expectedShareRevision: attempted.remoteRevision!,
      idempotencyKey: attempted.operationId,
    });
    if (remote.status !== 'revoked') throw new Error('共享服务未确认撤销。');
    return completeMeetingActionShareRevoke({
      shareId: attempted.id,
      scopeKey,
      operationId: attempted.operationId,
      remoteRevision: remote.revision,
      updatedAtMs: Date.now(),
    });
  } catch (reason) {
    const code = errorCode(reason);
    const failed = await failMeetingActionShareOperation({
      shareId: attempted.id,
      scopeKey,
      operationId: attempted.operationId,
      disposition: blockedError(code) ? 'blocked' : 'failed_retryable',
      errorCode: code,
      updatedAtMs: Date.now(),
    }).catch(() => null);
    throw new Error(meetingActionShareErrorMessage(failed, '共享链接暂时无法撤销，请稍后重试。'));
  }
}

export async function revokeMeetingActionShare(input: {
  scopeKey: ScopeKey;
  meetingId: string;
  share: MeetingActionShare;
  accessToken: string;
}): Promise<MeetingActionShare> {
  assertScopeKey(input.scopeKey);
  if (input.scopeKey === 'guest' || !input.accessToken) throw new Error('登录后才能撤销共享。');
  const context = await actionShareContext(input.scopeKey, input.meetingId, input.share.actionId);
  const revoking = await beginRevokeMeetingActionShare({
    shareId: input.share.id,
    scopeKey: input.scopeKey,
    operationId: secureClientIdFactory.create(),
    updatedAtMs: Date.now(),
  });
  return processRevoke(input.scopeKey, input.accessToken, revoking, context);
}

export async function getMeetingActionCollaboratorId(): Promise<string> {
  const existing = (await getAppStorageItem(COLLABORATOR_ID_KEY))?.trim() ?? '';
  if (/^[0-9a-f-]{36}$/i.test(existing)) return existing.toLowerCase();
  const created = secureClientIdFactory.create();
  await setAppStorageItem(COLLABORATOR_ID_KEY, created);
  return created;
}
