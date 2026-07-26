import {
  createMeetingContentShareRemote,
  listMeetingContentSharesRemote,
  loadMeetingCapabilities,
  MeetingContentShareConflictError,
  revokeMeetingContentShareRemote,
} from '../data/api/v2';
import {
  beginRevokeMeetingContentShare,
  completeMeetingContentShareCreate,
  completeMeetingContentShareRevoke,
  failMeetingContentShareOperation,
  insertPendingMeetingContentShare,
  listMeetingContentShares,
  markMeetingContentShareAttempt,
  mergeRemoteMeetingContentShares,
  restartMeetingContentShareCreate,
  sqliteMeetingNoteRepository,
} from '../data/repositories';
import {
  assertScopeKey,
  secureClientIdFactory,
  type MeetingContentShare,
  type MeetingContentShareSnapshot,
  type ScopeKey,
} from '../domain/meeting';
import { requestMeetingRootSync } from '../application/meeting/rootSyncTrigger';
import { HttpResponseError } from './errors';

type MeetingContentShareContext = {
  canonicalMeetingId: string;
  meetingRemoteId: string | null;
};

async function contentShareContext(
  scopeKey: ScopeKey,
  meetingId: string,
): Promise<MeetingContentShareContext> {
  assertScopeKey(scopeKey);
  const aggregate = await sqliteMeetingNoteRepository.findByNativeSessionId(meetingId, scopeKey);
  if (!aggregate || aggregate.note.lifecycle === 'deleted') throw new Error('会议记录已不可用。');
  return {
    canonicalMeetingId: aggregate.note.id,
    meetingRemoteId: aggregate.note.remoteId,
  };
}

function errorCode(reason: unknown): string {
  if (reason instanceof MeetingContentShareConflictError) {
    return reason.code === 'share_revision_conflict'
      ? 'share_revision_changed'
      : reason.code === 'share_already_exists' ? 'share_already_exists' : 'share_conflict';
  }
  if (reason instanceof HttpResponseError) {
    if (reason.status === 401) return 'auth_unauthorized';
    if ([403, 404, 405, 501].includes(reason.status)) return 'content_share_not_available';
    if (reason.status === 413) return 'content_too_large';
    return `http_${reason.status}`;
  }
  const message = reason instanceof Error ? reason.message.toLowerCase() : '';
  if (message.includes('capabilit')) return 'capability_unavailable';
  return 'network_or_timeout';
}

function blockedError(code: string): boolean {
  return [
    'auth_unauthorized',
    'content_share_not_available',
    'content_too_large',
    'share_revision_changed',
    'share_conflict',
  ].includes(code);
}

function meetingContentShareErrorCodeMessage(
  code: string | null | undefined,
  fallback: string,
): string {
  switch (code) {
    case 'meeting_not_synced':
      return '会议记录正在同步，完成后可重试创建链接。';
    case 'capability_unavailable':
    case 'network_or_timeout':
      return '当前无法连接共享服务，请稍后重试。';
    case 'content_share_not_available':
      return '当前服务暂不支持会议资料链接。';
    case 'auth_unauthorized':
      return '登录状态已失效，请重新登录后再试。';
    case 'content_too_large':
      return '所选内容过多，请减少后重新创建。';
    case 'share_revision_changed':
      return '共享设置已在其他设备更新，请重新打开。';
    case 'share_already_exists':
      return '这条共享链接已经创建，请刷新后重试。';
    case 'share_conflict':
      return '共享链接状态已变化，请重新打开。';
    default:
      return fallback;
  }
}

export function meetingContentShareErrorMessage(
  value: MeetingContentShare | null,
  fallback = '共享链接暂时不可用，请稍后重试。',
): string {
  return meetingContentShareErrorCodeMessage(value?.lastErrorCode, fallback);
}

async function requireRemoteCapability(accessToken: string): Promise<void> {
  const capability = await loadMeetingCapabilities({
    accessToken,
    forceRefresh: true,
    allowStaleOnError: false,
  });
  if (capability.source !== 'remote' || !capability.capabilities.meetingContentSharesV1) {
    throw new HttpResponseError('当前服务暂不支持会议资料链接', 501);
  }
}

async function processCreate(
  scopeKey: ScopeKey,
  accessToken: string,
  share: MeetingContentShare,
  context: MeetingContentShareContext,
): Promise<MeetingContentShare> {
  if (!share.operationId || !share.snapshot) throw new Error('共享冻结内容已不可用。');
  const attempted = await markMeetingContentShareAttempt({
    shareId: share.id,
    scopeKey,
    operationId: share.operationId,
    status: 'pending',
    updatedAtMs: Date.now(),
  });
  if (!context.meetingRemoteId) {
    requestMeetingRootSync(scopeKey);
    const failed = await failMeetingContentShareOperation({
      shareId: attempted.id,
      scopeKey,
      operationId: attempted.operationId!,
      disposition: 'failed_retryable',
      errorCode: 'meeting_not_synced',
      updatedAtMs: Date.now(),
    });
    throw new Error(meetingContentShareErrorMessage(failed));
  }
  try {
    await requireRemoteCapability(accessToken);
    const remote = await createMeetingContentShareRemote({
      accessToken,
      meetingRemoteId: context.meetingRemoteId,
      clientShareId: attempted.id,
      snapshot: attempted.snapshot!,
      followLatestSummary: attempted.followLatestSummary,
      idempotencyKey: attempted.operationId!,
    });
    if (
      remote.status !== 'active' || !remote.inviteUrl
      || remote.followLatestSummary !== attempted.followLatestSummary
      || JSON.stringify(remote.contentScope) !== JSON.stringify(attempted.contentScope)
    ) throw new Error('共享服务返回了不一致的内容范围。');
    return completeMeetingContentShareCreate({
      shareId: attempted.id,
      scopeKey,
      operationId: attempted.operationId!,
      remote,
      updatedAtMs: Date.now(),
    });
  } catch (reason) {
    const code = errorCode(reason);
    const failed = await failMeetingContentShareOperation({
      shareId: attempted.id,
      scopeKey,
      operationId: attempted.operationId!,
      disposition: blockedError(code) ? 'blocked' : 'failed_retryable',
      errorCode: code,
      updatedAtMs: Date.now(),
    }).catch(() => null);
    throw new Error(meetingContentShareErrorMessage(failed));
  }
}

export async function loadMeetingContentShares(input: {
  scopeKey: ScopeKey;
  meetingId: string;
  accessToken: string | null;
}): Promise<{
  shares: readonly MeetingContentShare[];
  remoteError: string;
}> {
  const context = await contentShareContext(input.scopeKey, input.meetingId);
  const local = await listMeetingContentShares(context.canonicalMeetingId, input.scopeKey);
  if (input.scopeKey === 'guest' || !input.accessToken || !context.meetingRemoteId) {
    return { shares: local, remoteError: '' };
  }
  try {
    await requireRemoteCapability(input.accessToken);
    const remote = await listMeetingContentSharesRemote({
      accessToken: input.accessToken,
      meetingRemoteId: context.meetingRemoteId,
    });
    return {
      shares: await mergeRemoteMeetingContentShares({
        meetingId: context.canonicalMeetingId,
        scopeKey: input.scopeKey,
        remote,
        mergedAtMs: Date.now(),
      }),
      remoteError: '',
    };
  } catch (reason) {
    const code = errorCode(reason);
    return {
      shares: local,
      remoteError: meetingContentShareErrorCodeMessage(code, '共享链接暂时无法刷新。'),
    };
  }
}

export async function createMeetingContentShare(input: {
  scopeKey: ScopeKey;
  meetingId: string;
  snapshot: MeetingContentShareSnapshot;
  followLatestSummary: boolean;
  accessToken: string;
}): Promise<MeetingContentShare> {
  assertScopeKey(input.scopeKey);
  if (input.scopeKey === 'guest' || !input.accessToken) throw new Error('登录后才能创建共享链接。');
  const context = await contentShareContext(input.scopeKey, input.meetingId);
  const createdAtMs = Date.now();
  const pending = await insertPendingMeetingContentShare({
    id: secureClientIdFactory.create(),
    meetingId: context.canonicalMeetingId,
    scopeKey: input.scopeKey,
    snapshot: input.snapshot,
    followLatestSummary: input.followLatestSummary,
    operationId: secureClientIdFactory.create(),
    createdAtMs,
  });
  return processCreate(input.scopeKey, input.accessToken, pending, context);
}

export async function retryMeetingContentShare(input: {
  scopeKey: ScopeKey;
  meetingId: string;
  share: MeetingContentShare;
  accessToken: string;
}): Promise<MeetingContentShare> {
  assertScopeKey(input.scopeKey);
  if (input.scopeKey === 'guest' || !input.accessToken) throw new Error('登录后才能重试共享。');
  const context = await contentShareContext(input.scopeKey, input.meetingId);
  if (input.share.pendingOperation === 'create') {
    const restarted = await restartMeetingContentShareCreate({
      shareId: input.share.id,
      scopeKey: input.scopeKey,
      operationId: secureClientIdFactory.create(),
      updatedAtMs: Date.now(),
    });
    return processCreate(input.scopeKey, input.accessToken, restarted, context);
  }
  if (input.share.pendingOperation !== 'revoke') throw new Error('这条共享记录无需重试。');
  return processRevoke(input.scopeKey, input.accessToken, input.share, context);
}

async function processRevoke(
  scopeKey: ScopeKey,
  accessToken: string,
  share: MeetingContentShare,
  context: MeetingContentShareContext,
): Promise<MeetingContentShare> {
  if (!context.meetingRemoteId || share.remoteRevision === null || !share.operationId) {
    throw new Error('共享云端状态已发生变化，请重新打开。');
  }
  const attempted = await markMeetingContentShareAttempt({
    shareId: share.id,
    scopeKey,
    operationId: share.operationId,
    status: 'revoking',
    updatedAtMs: Date.now(),
  });
  try {
    await requireRemoteCapability(accessToken);
    const remote = await revokeMeetingContentShareRemote({
      accessToken,
      meetingRemoteId: context.meetingRemoteId,
      clientShareId: attempted.id,
      expectedShareRevision: attempted.remoteRevision!,
      idempotencyKey: attempted.operationId!,
    });
    if (remote.status !== 'revoked') throw new Error('共享服务未确认撤销。');
    return completeMeetingContentShareRevoke({
      shareId: attempted.id,
      scopeKey,
      operationId: attempted.operationId!,
      remoteRevision: remote.revision,
      updatedAtMs: Date.now(),
    });
  } catch (reason) {
    const code = errorCode(reason);
    const failed = await failMeetingContentShareOperation({
      shareId: attempted.id,
      scopeKey,
      operationId: attempted.operationId!,
      disposition: blockedError(code) ? 'blocked' : 'failed_retryable',
      errorCode: code,
      updatedAtMs: Date.now(),
    }).catch(() => null);
    throw new Error(meetingContentShareErrorMessage(failed, '共享链接暂时无法撤销，请稍后重试。'));
  }
}

export async function revokeMeetingContentShare(input: {
  scopeKey: ScopeKey;
  meetingId: string;
  share: MeetingContentShare;
  accessToken: string;
}): Promise<MeetingContentShare> {
  assertScopeKey(input.scopeKey);
  if (input.scopeKey === 'guest' || !input.accessToken) throw new Error('登录后才能撤销共享。');
  const context = await contentShareContext(input.scopeKey, input.meetingId);
  const revoking = await beginRevokeMeetingContentShare({
    shareId: input.share.id,
    scopeKey: input.scopeKey,
    operationId: secureClientIdFactory.create(),
    updatedAtMs: Date.now(),
  });
  return processRevoke(input.scopeKey, input.accessToken, revoking, context);
}
