import type { SpeakerProfile } from '../services/speakers';
import {
  SPEAKER_SNAPSHOT_SCHEMA_VERSION,
  type NativeSpeakerEnrollmentSnapshot,
  type NativeSpeakerManagerSnapshot,
  type NativeSpeakerProfileSnapshot,
  type SpeakerContentPhase,
  type SpeakerEnrollmentPhase,
  type SpeakerReprocessPhase,
} from 'laoji-native-platform';

// MIN-SPEAKER-001: snapshots deliberately contain display data only. Bearer
// tokens, audio URIs, and server response objects never cross the native View boundary.
export function toNativeSpeakerProfile(profile: SpeakerProfile): NativeSpeakerProfileSnapshot {
  return {
    id: profile.speaker_id,
    name: profile.name,
    sampleCount: Number.isFinite(profile.sample_count) ? profile.sample_count : 0,
    quality: Number.isFinite(profile.quality) ? profile.quality : 0,
  };
}

export function buildNativeSpeakerManagerSnapshot(input: {
  guest: boolean;
  phase: SpeakerContentPhase;
  message?: string;
  speakers?: readonly SpeakerProfile[];
}): NativeSpeakerManagerSnapshot {
  return {
    schemaVersion: SPEAKER_SNAPSHOT_SCHEMA_VERSION,
    surface: 'manager',
    guest: input.guest,
    phase: input.phase,
    message: input.message ?? '',
    speakers: (input.speakers ?? []).map(toNativeSpeakerProfile),
  };
}

export function buildNativeSpeakerEnrollmentSnapshot(input: {
  guest: boolean;
  speakerId?: string | null;
  title?: string;
  phase: SpeakerContentPhase;
  message?: string;
  name?: string;
  nameEditable?: boolean;
  nameSaveEnabled?: boolean;
  enrollmentPhase?: SpeakerEnrollmentPhase;
  elapsedMs?: number;
  maxDurationMs?: number;
  level?: number;
  errorMessage?: string;
  canDelete?: boolean;
  canRecord?: boolean;
  canSubmit?: boolean;
  voiceprintText?: string;
  voiceprintConsentAccepted?: boolean;
  reprocessPhase?: SpeakerReprocessPhase;
  reprocessMessage?: string;
  canReprocess?: boolean;
}): NativeSpeakerEnrollmentSnapshot {
  return {
    schemaVersion: SPEAKER_SNAPSHOT_SCHEMA_VERSION,
    surface: 'enrollment',
    guest: input.guest,
    speakerId: input.speakerId ?? null,
    title: input.title ?? (input.speakerId ? '讲话人详情' : '声纹采集'),
    phase: input.phase,
    message: input.message ?? '',
    name: input.name ?? '',
    nameEditable: input.nameEditable ?? true,
    nameSaveEnabled: input.nameSaveEnabled ?? false,
    enrollmentPhase: input.enrollmentPhase ?? 'idle',
    elapsedMs: Math.max(0, input.elapsedMs ?? 0),
    maxDurationMs: Math.max(1, input.maxDurationMs ?? 15_000),
    level: Math.max(0, Math.min(1, input.level ?? 0)),
    errorMessage: input.errorMessage ?? '',
    canDelete: input.canDelete ?? Boolean(input.speakerId),
    canRecord: input.canRecord ?? true,
    canSubmit: input.canSubmit ?? false,
    voiceprintText: input.voiceprintText
      ?? '今天的会议将围绕项目进展展开，请大家依次说明完成情况和下一步安排。',
    voiceprintConsentAccepted: input.voiceprintConsentAccepted ?? false,
    reprocessPhase: input.reprocessPhase ?? 'idle',
    reprocessMessage: input.reprocessMessage ?? '',
    canReprocess: input.canReprocess ?? Boolean(input.speakerId),
  };
}
