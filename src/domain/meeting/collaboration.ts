export type MeetingActionSharePermission = 'viewer' | 'action_editor';

export type MeetingActionShareStatus =
  | 'pending'
  | 'active'
  | 'failed_retryable'
  | 'blocked'
  | 'revoking'
  | 'revoked';

export type MeetingActionShareOperation = 'create' | 'revoke';

/**
 * A local receipt for one capability link. The link only exposes the action
 * projection; it never carries a MeetingNote, Transcript, recording, Summary,
 * or manual-note identity.
 */
export interface MeetingActionShare {
  id: string;
  meetingId: string;
  actionId: string;
  permission: MeetingActionSharePermission;
  status: MeetingActionShareStatus;
  remoteId: string | null;
  remoteRevision: number | null;
  inviteUrl: string | null;
  expectedActionRemoteRevision: number | null;
  operationId: string;
  pendingOperation: MeetingActionShareOperation | null;
  attemptCount: number;
  lastErrorCode: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface SharedMeetingAction {
  shareId: string;
  shareRevision: number;
  permission: MeetingActionSharePermission;
  status: 'active' | 'revoked';
  action: {
    id: string;
    revision: number;
    content: string;
    status: 'pending' | 'completed' | 'dismissed';
    assignee: string | null;
    dueAtMs: number | null;
    updatedAtMs: number;
    actorLabel: string;
  };
}
