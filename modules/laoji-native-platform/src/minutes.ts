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
import type { NativeProjectionEnvelope } from './contracts';

export const MINUTES_SNAPSHOT_SCHEMA_VERSION = 19 as const;
export const MINUTES_PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;

export type MinutesSurface = 'list' | 'recording' | 'detail';
export type MinutesContentPhase = 'ready' | 'loading' | 'empty' | 'error';
export type MinutesDetailTab = 'notes' | 'transcript' | 'summary' | 'speakers' | 'info';
export type MinutesProcessingStage = 'capture' | 'upload' | 'transcript' | 'summary' | 'speaker';
export type MinutesStatusTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger';
export type MinutesRecordingContent = 'notes' | 'transcript';
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
  targetMeetingId?: string;
  title: string;
  dateTimeLabel: string;
  durationLabel?: string;
  statusLabel?: string;
  statusTone?: MinutesStatusTone;
  canResume?: boolean;
  /** LaoJi derives a content-shaped cover from locally available meeting data. */
  coverType?: 'default' | 'summary' | 'speakerSummary';
  coverTitle?: string;
  coverText?: string;
  supportText?: string;
  searchSource?: 'title' | 'tag' | 'manual_note' | 'transcript' | 'summary' | 'action';
  searchSourceId?: string;
  searchPositionMs?: number;
  action?: 'open' | 'restore';
  actionEnabled?: boolean;
}

export interface MinutesTranscriptLineSnapshot {
  id: string;
  playerSourceId?: string;
  speakerId?: string;
  speakerClusterId?: string;
  speakerLabel?: string;
  timestampLabel?: string;
  startMs?: number;
  endMs?: number;
  text: string;
  isFinal?: boolean;
  active?: boolean;
  searchRanges?: readonly { start: number; end: number }[];
  selectedSearchMatch?: boolean;
  revisionKind?: 'realtimeDraft' | 'final' | 'reprocessed';
}

export interface MinutesMarkerSnapshot {
  id: string;
  positionMs: number;
  timestampLabel: string;
  segmentId?: string;
  label?: string;
  deleting?: boolean;
}

export interface MinutesSummaryBlockSnapshot {
  id: string;
  kind?: 'paragraph' | 'heading' | 'bullet' | 'ordered' | 'task' | 'quote' | 'code';
  text: string;
  checked?: boolean;
}

export interface MinutesSummaryCitationSnapshot {
  id: string;
  segmentId: string;
  startMs: number;
  endMs?: number;
  label?: string;
}

export interface MinutesSummaryRichItemSnapshot {
  id: string;
  title?: string | null;
  text: string;
  meta?: string | null;
  sourceId?: string | null;
  startMs?: number | null;
}

export interface MinutesSummaryRichEdgeSnapshot {
  from: string;
  to: string;
  label?: string | null;
}

export interface MinutesSummaryRichBlockSnapshot {
  kind: 'paragraph' | 'bullet_group' | 'quote' | 'timeline' | 'flow' | 'comparison' | 'risk_card' | 'stat';
  iconKey: 'overview' | 'topic' | 'quote' | 'time' | 'flow' | 'compare' | 'risk' | 'stat' | 'action';
  items: readonly MinutesSummaryRichItemSnapshot[];
  edges?: readonly MinutesSummaryRichEdgeSnapshot[];
  edited?: boolean;
  originalSourceLabel?: string | null;
}

export interface MinutesSummarySectionSnapshot {
  id: string;
  stableKey: string;
  kind?: string;
  title?: string | null;
  text: string;
  editable?: boolean;
  userEdited?: boolean;
  citations?: readonly MinutesSummaryCitationSnapshot[];
  richBlock?: MinutesSummaryRichBlockSnapshot;
}

export interface MinutesActionItemSnapshot {
  id: string;
  content: string;
  status: 'pending' | 'completed' | 'dismissed';
  assigneeLabel?: string;
  dueLabel?: string;
  reminderLabel?: string;
  followupEventSourceId?: string;
  hasSource?: boolean;
  sourceSegmentId?: string;
  sourceStartMs?: number;
  updatedAtMs?: number;
  updating?: boolean;
  canShare?: boolean;
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
  notes: MinutesDetailPageStateSnapshot;
  transcript: MinutesDetailPageStateSnapshot;
  summary: MinutesDetailPageStateSnapshot;
  speakers: MinutesDetailPageStateSnapshot;
  info: MinutesDetailPageStateSnapshot;
}

export interface MinutesPlayerSourceSnapshot {
  sourceId: string;
  uri: string;
  recordingAssetId?: string;
  recordingAssetRemoteId?: string;
  label?: string;
  localOnly?: boolean;
  headers?: Readonly<Record<string, string>>;
  title?: string;
  durationMsHint?: number;
  retainForBackground?: boolean;
  storageScope: 'guest';
  expiresAt?: number;
}

export interface MinutesListSnapshot {
  title?: string;
  searching?: boolean;
  query?: string;
  mediaImporting?: boolean;
  mediaImportStatusLabel?: string;
  phase?: MinutesContentPhase;
  message?: string;
  showingCachedData?: boolean;
  mode?: 'meetings' | 'recycleBin';
  canOpenRecycleBin?: boolean;
  canEmptyRecycleBin?: boolean;
  recycleBinEmptying?: boolean;
  canReorder?: boolean;
  meetings: readonly MinutesMeetingSnapshot[];
}

export interface MinutesRecordingSnapshot {
  meetingId: string;
  title: string;
  startedAtLabel?: string;
  location?: string;
  locationLoading?: boolean;
  canEditLocation?: boolean;
  phase: MinutesRecordingPhase;
  elapsedMs: number;
  statusLabel?: string;
  errorMessage?: string;
  canPause?: boolean;
  canStop?: boolean;
  canStart?: boolean;
  canCreateMarker?: boolean;
  followLatest?: boolean;
  activeContent?: MinutesRecordingContent;
  manualNote?: string;
  manualNoteLoading?: boolean;
  manualNoteSaving?: boolean;
  manualNoteEnabled?: boolean;
  manualNoteError?: string;
  manualNoteRetryable?: boolean;
  transcript: readonly MinutesTranscriptLineSnapshot[];
}

export interface MinutesDetailSnapshot {
  meetingId: string;
  available?: boolean;
  title: string;
  dateTimeLabel?: string;
  location?: string;
  locationLoading?: boolean;
  canEditLocation?: boolean;
  activeTab: MinutesDetailTab;
  tabGeneration?: number;
  activeTabIsExplicit?: boolean;
  contentPhase?: MinutesContentPhase;
  contentMessage?: string;
  pageStates?: MinutesDetailPageStatesSnapshot;
  canShare?: boolean;
  canManageSpeakers?: boolean;
  canGenerateSummary?: boolean;
  canCreateAction?: boolean;
  summaryGenerating?: boolean;
  summaryActionLabel?: string;
  titleEditRequestId?: number;
  focusActionId?: string;
  focusActionRequestId?: number;
  focusTranscriptSegmentId?: string;
  focusTranscriptPositionMs?: number;
  focusTranscriptRequestId?: number;
  manualNote?: string;
  manualNoteLoading?: boolean;
  manualNoteSaving?: boolean;
  manualNoteEnabled?: boolean;
  manualNoteError?: string;
  manualNoteRetryable?: boolean;
  transcript: readonly MinutesTranscriptLineSnapshot[];
  markers?: readonly MinutesMarkerSnapshot[];
  summary: readonly MinutesSummarySectionSnapshot[];
  actions?: readonly MinutesActionItemSnapshot[];
  speakers: readonly MinutesSpeakerSnapshot[];
  playerSource?: MinutesPlayerSourceSnapshot | null;
  playerSources?: readonly MinutesPlayerSourceSnapshot[];
  audioStatusMessage?: string;
  audioErrorMessage?: string;
  processingStatusLabel?: string;
  processingStatusTone?: MinutesStatusTone;
  processingRetryStage?: MinutesProcessingStage;
  processingRetrying?: boolean;
  recordingMergeStatusLabel?: string;
  recordingMergeActionLabel?: string;
  recordingMergeActionEnabled?: boolean;
}

export interface MinutesViewSnapshot {
  schemaVersion: typeof MINUTES_SNAPSHOT_SCHEMA_VERSION;
  surface: MinutesSurface;
  list?: MinutesListSnapshot;
  recording?: MinutesRecordingSnapshot;
  detail?: MinutesDetailSnapshot;
  projection?: NativeProjectionEnvelope | null;
}

export type MinutesSemanticAction = (
  | { type: 'back' | 'search' | 'more' | 'share' | 'refreshMeetings'; surface: MinutesSurface; meetingId?: string }
  | { type: 'openSpeakers' | 'openSettings' | 'openMeetingTags' | 'openMeetingOrganization' | 'openRecycleBin' | 'closeRecycleBin' | 'emptyRecycleBin'; surface: 'list' }
  | { type: 'importMedia'; surface: 'list' }
  | {
      type: 'openMeeting' | 'openRecording' | 'stopRecording' | 'retryRecording';
      surface: MinutesSurface;
      meetingId: string;
      searchSource?: MinutesMeetingSnapshot['searchSource'];
      searchSourceId?: string;
      searchPositionMs?: number;
    }
  | { type: 'startRecording'; surface: MinutesSurface; meetingId?: string }
  | { type: 'saveTitle'; surface: 'detail' | 'recording'; meetingId: string; title: string }
  | { type: 'openMeetingMenu'; surface: MinutesSurface; meetingId: string; canResume: boolean }
  | { type: 'renameMeeting' | 'setMeetingTags' | 'deleteMeeting'; surface: 'list'; meetingId: string }
  | { type: 'restoreMeeting' | 'permanentlyDeleteMeeting'; surface: 'list'; meetingId: string }
  | { type: 'reorderMeetings'; surface: 'list'; meetingIds: readonly string[] }
  | { type: 'toggleRecordingPause'; surface: MinutesSurface; meetingId: string; resume: boolean }
  | { type: 'createMarker'; surface: 'recording'; meetingId: string; positionMs: number }
  | { type: 'requestMeetingLocation'; surface: 'recording' | 'detail'; meetingId?: string }
  | { type: 'setFollowLatest'; surface: MinutesSurface; meetingId: string; followLatest: boolean }
  | { type: 'selectRecordingContent'; surface: 'recording'; meetingId: string; content: MinutesRecordingContent }
  | { type: 'updateManualNote'; surface: 'detail' | 'recording'; meetingId: string; content: string }
  | { type: 'retryManualNote'; surface: 'detail' | 'recording'; meetingId: string }
  | { type: 'selectDetailTab'; surface: MinutesSurface; meetingId: string; tab: MinutesDetailTab; selectionGeneration: number }
  | { type: 'retryDetailContent'; surface: MinutesSurface; meetingId: string; tab: MinutesDetailTab }
  | { type: 'retryProcessingStage'; surface: 'detail'; meetingId: string; stage: MinutesProcessingStage }
  | { type: 'mergeRecordingAssets'; surface: 'detail'; meetingId: string }
  | { type: 'selectPlayerSource'; surface: 'detail'; meetingId: string; sourceId: string }
  | {
      type: 'seekTranscript';
      surface: MinutesSurface;
      meetingId: string;
      lineId: string;
      positionMs: number;
      playerSourceId?: string;
    }
  | { type: 'openMarker'; surface: 'detail'; meetingId: string; markerId: string; segmentId?: string; positionMs: number }
  | { type: 'openMarkerActions'; surface: 'detail'; meetingId: string; markerId: string }
  | { type: 'deleteMarker'; surface: 'detail'; meetingId: string; markerId: string }
  | { type: 'seekSummaryCitation'; surface: 'detail'; meetingId: string; segmentId: string; positionMs: number }
  | { type: 'editSummarySection'; surface: 'detail'; meetingId: string; sectionId: string }
  | { type: 'toggleAction'; surface: 'detail'; meetingId: string; actionId: string; completed: boolean }
  | { type: 'createAction'; surface: 'detail'; meetingId: string }
  | { type: 'editAction'; surface: 'detail'; meetingId: string; actionId: string }
  | { type: 'shareAction'; surface: 'detail'; meetingId: string; actionId: string }
  | { type: 'actionToEvent'; surface: 'detail'; meetingId: string; actionId: string }
  | { type: 'openActionSource'; surface: 'detail'; meetingId: string; actionId: string; segmentId?: string; positionMs: number }
  | {
      type: 'editTranscriptSpeaker';
      surface: 'detail';
      meetingId: string;
      lineId: string;
      speakerId: string;
      speakerClusterId?: string;
      speakerLabel: string;
      positionMs: number;
      revisionKind: 'realtimeDraft' | 'final' | 'reprocessed';
    }
  | { type: 'manageSpeaker'; surface: MinutesSurface; meetingId: string; speakerId: string }
  | { type: 'generateSummary'; surface: 'detail'; meetingId: string }
  | { type: 'openSummaryBlocks'; surface: 'detail'; meetingId: string }
  | { type: 'openSummaryEvidence'; surface: 'detail'; meetingId: string; sectionId: string }
  | { type: 'beginSearch' | 'endSearch'; surface: 'list' }
  | { type: 'updateSearchQuery'; surface: 'list'; query: string }
) & { projection?: NativeProjectionEnvelope | null };

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
  profileEntry?: import('./ui').NativeProfileEntrySnapshot | null;
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
  activatePlaybackStorageScope(scope: 'guest' | 'signed_out'): Promise<void>;
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

export type MinutesPlaybackStorageScope = 'guest' | 'signed_out';

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
