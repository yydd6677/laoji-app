import type { ComponentType } from 'react';
import type { NativeSyntheticEvent, ViewProps } from 'react-native';
import { Platform, View } from 'react-native';
import { requireNativeViewManager } from 'expo-modules-core';

// MIN-SPEAKER-001 / MIN-DETAIL-001: the native surface owns rendering and emits
// semantic actions. Authentication, speaker CRUD, and audio files stay in TS.
export const SPEAKER_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export type SpeakerSurface = 'manager' | 'enrollment';
export type SpeakerContentPhase = 'loading' | 'ready' | 'empty' | 'error';
export type SpeakerEnrollmentPhase =
  | 'idle'
  | 'preparing'
  | 'recording'
  | 'stopping'
  | 'ready'
  | 'saving'
  | 'error';

export interface NativeSpeakerProfileSnapshot {
  id: string;
  name: string;
  sampleCount: number;
  quality: number;
}

export interface NativeSpeakerManagerSnapshot {
  schemaVersion: typeof SPEAKER_SNAPSHOT_SCHEMA_VERSION;
  surface: 'manager';
  guest: boolean;
  phase: SpeakerContentPhase;
  message: string;
  speakers: readonly NativeSpeakerProfileSnapshot[];
}

export interface NativeSpeakerEnrollmentSnapshot {
  schemaVersion: typeof SPEAKER_SNAPSHOT_SCHEMA_VERSION;
  surface: 'enrollment';
  guest: boolean;
  speakerId: string | null;
  title: string;
  phase: SpeakerContentPhase;
  message: string;
  name: string;
  nameEditable: boolean;
  nameSaveEnabled: boolean;
  enrollmentPhase: SpeakerEnrollmentPhase;
  elapsedMs: number;
  maxDurationMs: number;
  level: number;
  errorMessage: string;
  canDelete: boolean;
  canRecord: boolean;
  canSubmit: boolean;
  voiceprintText: string;
  voiceprintConsentAccepted: boolean;
}

export type NativeSpeakerSnapshot =
  | NativeSpeakerManagerSnapshot
  | NativeSpeakerEnrollmentSnapshot;

export type NativeSpeakerAction =
  | { type: 'back'; surface: SpeakerSurface }
  | { type: 'retry'; surface: SpeakerSurface }
  | { type: 'login'; surface: SpeakerSurface }
  | { type: 'create'; surface: 'manager' }
  | { type: 'open'; surface: 'manager'; speakerId: string }
  | { type: 'nameChange'; surface: 'enrollment'; name: string }
  | { type: 'saveName'; surface: 'enrollment'; name: string }
  | { type: 'delete'; surface: 'enrollment'; speakerId: string }
  | { type: 'confirmDelete'; surface: 'enrollment'; speakerId: string }
  | { type: 'cancelDelete'; surface: 'enrollment'; speakerId: string }
  | { type: 'startRecording'; surface: 'enrollment'; speakerId: string | null }
  | { type: 'stopRecording'; surface: 'enrollment'; speakerId: string | null }
  | { type: 'retake'; surface: 'enrollment'; speakerId: string | null }
  | { type: 'toggleVoiceprintConsent'; surface: 'enrollment'; speakerId: string | null }
  | { type: 'submitRecording'; surface: 'enrollment'; speakerId: string | null };

type NativeSpeakerEvent<T> = (event: NativeSyntheticEvent<T>) => void;

export interface LaojiSpeakerViewProps extends ViewProps {
  surface: SpeakerSurface;
  snapshot: NativeSpeakerSnapshot;
  onSpeakerAction?: NativeSpeakerEvent<NativeSpeakerAction>;
}

const NativeSpeakerView: ComponentType<LaojiSpeakerViewProps> = Platform.OS === 'android'
  ? requireNativeViewManager<LaojiSpeakerViewProps>('LaojiSpeaker')
  : View as unknown as ComponentType<LaojiSpeakerViewProps>;

export const LaojiSpeakerView = NativeSpeakerView;
