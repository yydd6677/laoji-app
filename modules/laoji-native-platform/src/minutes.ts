import type { ComponentType } from 'react';
import type {
  NativeSyntheticEvent,
  ViewProps,
} from 'react-native';
import {
  Platform,
  View,
} from 'react-native';
import {
  requireNativeViewManager,
  requireOptionalNativeModule,
} from 'expo-modules-core';
import type { NativeModule } from 'expo-modules-core';

export const MINUTES_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const MINUTES_PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;

export type MinutesSurface = 'list' | 'recording' | 'detail';
export type MinutesContentPhase = 'ready' | 'loading' | 'empty' | 'error';
export type MinutesDetailTab = 'transcript' | 'summary' | 'speakers';
export type MinutesRecordingPhase =
  | 'idle'
  | 'preparing'
  | 'recording'
  | 'paused'
  | 'stopping'
  | 'saving'
  | 'failed';
export type MinutesPlaybackPhase =
  | 'idle'
  | 'preparing'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'ended'
  | 'failed';
export type MinutesPlaybackRate = typeof MINUTES_PLAYBACK_RATES[number];

export interface MinutesMeetingSnapshot {
  id: string;
  title: string;
  dateTimeLabel: string;
  durationLabel?: string;
  statusLabel?: string;
  statusTone?: 'neutral' | 'primary' | 'success' | 'warning' | 'danger';
  canResume?: boolean;
}

export interface MinutesTranscriptLineSnapshot {
  id: string;
  speakerId?: string;
  speakerLabel?: string;
  timestampLabel?: string;
  startMs?: number;
  text: string;
  isFinal?: boolean;
}

export interface MinutesSummaryBlockSnapshot {
  id: string;
  kind?: 'paragraph' | 'heading' | 'bullet' | 'ordered' | 'task' | 'quote' | 'code';
  text: string;
  checked?: boolean;
}

export interface MinutesSpeakerSnapshot {
  id: string;
  label: string;
  segmentCount?: number;
  durationLabel?: string;
  canManage?: boolean;
}

export interface MinutesDetailPageStateSnapshot {
  phase: MinutesContentPhase;
  message: string;
  generation: number;
  cached: boolean;
}

export interface MinutesDetailPageStatesSnapshot {
  transcript: MinutesDetailPageStateSnapshot;
  summary: MinutesDetailPageStateSnapshot;
  speakers: MinutesDetailPageStateSnapshot;
}

export interface MinutesPlayerSourceSnapshot {
  sourceId: string;
  uri: string;
  headers?: Readonly<Record<string, string>>;
  title?: string;
  durationMsHint?: number;
  retainForBackground?: boolean;
  storageScope: 'guest' | `user:${string}`;
  expiresAt?: number;
}

export interface MinutesListSnapshot {
  title?: string;
  searching?: boolean;
  query?: string;
  phase?: MinutesContentPhase;
  message?: string;
  showingCachedData?: boolean;
  meetings: readonly MinutesMeetingSnapshot[];
}

export interface MinutesRecordingSnapshot {
  meetingId: string;
  title: string;
  startedAtLabel?: string;
  phase: MinutesRecordingPhase;
  elapsedMs: number;
  statusLabel?: string;
  errorMessage?: string;
  canPause?: boolean;
  canStop?: boolean;
  canStart?: boolean;
  followLatest?: boolean;
  transcript: readonly MinutesTranscriptLineSnapshot[];
}

export interface MinutesDetailSnapshot {
  meetingId: string;
  available?: boolean;
  title: string;
  dateTimeLabel?: string;
  activeTab: MinutesDetailTab;
  tabGeneration?: number;
  activeTabIsExplicit?: boolean;
  contentPhase?: MinutesContentPhase;
  contentMessage?: string;
  pageStates?: MinutesDetailPageStatesSnapshot;
  canShare?: boolean;
  canManageSpeakers?: boolean;
  canGenerateSummary?: boolean;
  summaryGenerating?: boolean;
  summaryActionLabel?: string;
  titleEditRequestId?: number;
  transcript: readonly MinutesTranscriptLineSnapshot[];
  summary: readonly MinutesSummaryBlockSnapshot[];
  speakers: readonly MinutesSpeakerSnapshot[];
  playerSource?: MinutesPlayerSourceSnapshot | null;
  audioStatusMessage?: string;
  audioErrorMessage?: string;
}

export interface MinutesViewSnapshot {
  schemaVersion: typeof MINUTES_SNAPSHOT_SCHEMA_VERSION;
  surface: MinutesSurface;
  list?: MinutesListSnapshot;
  recording?: MinutesRecordingSnapshot;
  detail?: MinutesDetailSnapshot;
}

export type MinutesSemanticAction =
  | { type: 'back' | 'search' | 'more' | 'share' | 'refreshMeetings'; surface: MinutesSurface; meetingId?: string }
  | { type: 'openMeeting' | 'openRecording' | 'stopRecording' | 'retryRecording'; surface: MinutesSurface; meetingId: string }
  | { type: 'startRecording'; surface: MinutesSurface; meetingId?: string }
  | { type: 'saveTitle'; surface: 'detail'; meetingId: string; title: string }
  | { type: 'openMeetingMenu'; surface: MinutesSurface; meetingId: string; canResume: boolean }
  | { type: 'toggleRecordingPause'; surface: MinutesSurface; meetingId: string; resume: boolean }
  | { type: 'setFollowLatest'; surface: MinutesSurface; meetingId: string; followLatest: boolean }
  | { type: 'selectDetailTab'; surface: MinutesSurface; meetingId: string; tab: MinutesDetailTab; selectionGeneration: number }
  | { type: 'retryDetailContent'; surface: MinutesSurface; meetingId: string; tab: MinutesDetailTab }
  | { type: 'seekTranscript'; surface: MinutesSurface; meetingId: string; lineId: string; positionMs: number }
  | { type: 'requestSpeakerAction'; surface: MinutesSurface; meetingId: string; lineId: string; speakerId: string }
  | { type: 'manageSpeaker'; surface: MinutesSurface; meetingId: string; speakerId: string }
  | { type: 'generateSummary'; surface: 'detail'; meetingId: string }
  | { type: 'beginSearch' | 'endSearch'; surface: 'list' }
  | { type: 'updateSearchQuery'; surface: 'list'; query: string };

export interface MinutesPlaybackState {
  sourceId: string | null;
  phase: MinutesPlaybackPhase;
  isPlaying: boolean;
  positionMs: number;
  bufferedPositionMs: number;
  durationMs: number;
  rate: number;
  retainForBackground: boolean;
  surfaceAttached: boolean;
  surfaceAttachmentCount: number;
  backgroundHostAttached: boolean;
  foregroundPlaybackRequested: boolean;
  errorCode: string | null;
  errorMessage: string | null;
}

type MinutesViewEvent<T> = (event: NativeSyntheticEvent<T>) => void;

export interface LaojiMinutesViewProps extends ViewProps {
  surface: MinutesSurface;
  snapshot: MinutesViewSnapshot;
  // UI-SHELL-BOTTOM-MAIN-001: selection motion resumes in the newly active native root.
  bottomBarSelectionCommand?: number | null;
  onMinutesAction?: MinutesViewEvent<MinutesSemanticAction>;
  onPlaybackStateChange?: MinutesViewEvent<MinutesPlaybackState>;
  onTabPress?: MinutesViewEvent<import('./ui').NativeTabPressEvent>;
}

interface MinutesModuleEvents {
  [eventName: string]: (...args: any[]) => void;
  onPlaybackStateChanged: (state: MinutesPlaybackState) => void;
}

interface NativeMinutesModule extends NativeModule<MinutesModuleEvents> {
  snapshotSchemaVersion: number;
  supportedPlaybackRates: number[];
  getPlaybackState(): Promise<MinutesPlaybackState>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seekTo(positionMs: number): Promise<void>;
  seekBy(deltaMs: number): Promise<void>;
  setPlaybackRate(rate: MinutesPlaybackRate): Promise<void>;
  activatePlaybackStorageScope(scope: 'guest' | `user:${string}` | 'signed_out'): Promise<void>;
  addListener(
    eventName: 'onPlaybackStateChanged',
    listener: MinutesModuleEvents['onPlaybackStateChanged'],
  ): { remove(): void };
}

const nativeModule = requireOptionalNativeModule<NativeMinutesModule>('LaojiMinutes');

const NativeMinutesView: ComponentType<LaojiMinutesViewProps> = Platform.OS === 'android'
  ? requireNativeViewManager<LaojiMinutesViewProps>('LaojiMinutes')
  : View as unknown as ComponentType<LaojiMinutesViewProps>;

export const LaojiMinutesView = NativeMinutesView;

export function hasNativeMinutes(): boolean {
  return nativeModule !== null;
}

export async function getMinutesPlaybackState(): Promise<MinutesPlaybackState> {
  if (!nativeModule) return idlePlaybackState();
  return nativeModule.getPlaybackState();
}

export async function playMinutesAudio(): Promise<void> {
  await nativeModule?.play();
}

export async function pauseMinutesAudio(): Promise<void> {
  await nativeModule?.pause();
}

export async function seekMinutesAudio(positionMs: number): Promise<void> {
  await nativeModule?.seekTo(positionMs);
}

export async function skipMinutesAudio(deltaMs: number): Promise<void> {
  await nativeModule?.seekBy(deltaMs);
}

export async function setMinutesPlaybackRate(rate: MinutesPlaybackRate): Promise<void> {
  await nativeModule?.setPlaybackRate(rate);
}

export type MinutesPlaybackStorageScope = 'guest' | `user:${string}` | 'signed_out';

export async function activateMinutesPlaybackStorageScope(
  scope: MinutesPlaybackStorageScope,
): Promise<void> {
  await nativeModule?.activatePlaybackStorageScope(scope);
}

export function addMinutesPlaybackListener(listener: (state: MinutesPlaybackState) => void) {
  return nativeModule?.addListener('onPlaybackStateChanged', listener) ?? { remove() {} };
}

function idlePlaybackState(): MinutesPlaybackState {
  return {
    sourceId: null,
    phase: 'idle',
    isPlaying: false,
    positionMs: 0,
    bufferedPositionMs: 0,
    durationMs: 0,
    rate: 1,
    retainForBackground: true,
    surfaceAttached: false,
    surfaceAttachmentCount: 0,
    backgroundHostAttached: false,
    foregroundPlaybackRequested: false,
    errorCode: null,
    errorMessage: null,
  };
}
