export type MeetingMediaClipSourceKind = 'marker' | 'transcript';

export type MeetingMediaClipStatus = 'pending' | 'ready' | 'failed' | 'deleting';

export interface MeetingMediaClip {
  id: string;
  meetingId: string;
  sourceRecordingAssetId: string | null;
  sourceRecordingChecksumSha256: string | null;
  sourceRecordingUpdatedAtMs: number;
  sourceKind: MeetingMediaClipSourceKind;
  sourceMarkerId: string | null;
  sourceSegmentId: string | null;
  startMs: number;
  endMs: number;
  includeSpeaker: boolean;
  includeText: boolean;
  speakerText: string | null;
  transcriptText: string | null;
  status: MeetingMediaClipStatus;
  localUri: string | null;
  mimeType: 'audio/wav' | null;
  fileName: string | null;
  byteSize: number | null;
  checksumSha256: string | null;
  errorCode: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface MeetingMediaClipLimits {
  minimumDurationMs: number;
  maximumDurationMs: number;
  adjustmentStepMs: number;
}

export interface MeetingMediaClipDraft {
  meetingId: string;
  sourceRecordingAssetId: string;
  sourceRecordingChecksumSha256: string | null;
  sourceRecordingUpdatedAtMs: number;
  sourceKind: MeetingMediaClipSourceKind;
  sourceMarkerId: string | null;
  sourceSegmentId: string | null;
  startMs: number;
  endMs: number;
  sourceDurationMs: number;
  includeSpeaker: boolean;
  includeText: boolean;
  speakerText: string | null;
  transcriptText: string | null;
  limits: MeetingMediaClipLimits;
}
