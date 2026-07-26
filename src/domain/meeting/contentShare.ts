export type MeetingContentShareKey =
  | 'info'
  | 'summary'
  | 'actions'
  | 'transcript'
  | 'markers'
  | 'attachments'
  | 'manualNote';

export interface MeetingContentShareSection {
  key: MeetingContentShareKey;
  title: string;
  content: string;
}

export interface MeetingContentShareSnapshot {
  schema_version: 1;
  sections: readonly MeetingContentShareSection[];
  source_summary_version_id: string | null;
}

export type MeetingContentShareStatus =
  | 'pending'
  | 'active'
  | 'failed_retryable'
  | 'blocked'
  | 'revoking'
  | 'revoked';

export type MeetingContentShareOperation = 'create' | 'revoke';

export interface MeetingContentShare {
  id: string;
  meetingId: string;
  contentScope: readonly MeetingContentShareKey[];
  snapshot: MeetingContentShareSnapshot | null;
  followLatestSummary: boolean;
  sourceSummaryVersionId: string | null;
  status: MeetingContentShareStatus;
  remoteId: string | null;
  remoteRevision: number | null;
  inviteUrl: string | null;
  operationId: string | null;
  pendingOperation: MeetingContentShareOperation | null;
  attemptCount: number;
  lastErrorCode: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface SharedMeetingContent {
  shareId: string;
  shareRevision: number;
  status: 'active' | 'revoked';
  contentScope: readonly MeetingContentShareKey[];
  followLatestSummary: boolean;
  summaryVersionId: string | null;
  sections: readonly MeetingContentShareSection[];
  createdAtMs: number;
  updatedAtMs: number;
}
