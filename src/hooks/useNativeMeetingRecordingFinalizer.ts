import { useCallback, useMemo } from 'react';
import {
  FinalizeNativeMeetingRecordingUseCase,
  type FinalizeNativeMeetingRecordingResult,
} from '../application/meeting';
import { recordTranscriptProcessingFailure } from '../services/meetingStageMirror';
import { useMeetings } from '../store/MeetingsStore';
import type { TranscriptLine } from '../types';

export interface NativeMeetingRecordingFinalizeRequest {
  meetingId: string;
  remoteMeetingId: string | null;
  getTranscriptLines: () => TranscriptLine[];
  getAudioDurationSec: () => number | undefined;
  getAudioBars: () => number[] | undefined;
  stopAudio: () => Promise<string | undefined>;
}

export interface NativeMeetingRecordingFinalizer {
  recordingStorageScope: 'guest';
  meetingScopeKey: 'guest';
  finalizeRecording: (
    request: NativeMeetingRecordingFinalizeRequest,
  ) => Promise<FinalizeNativeMeetingRecordingResult>;
}

export function useNativeMeetingRecordingFinalizer(): NativeMeetingRecordingFinalizer {
  const {
    getCachedTranscript,
    saveCachedTranscript,
    updateMeetingStatus,
    refreshMeetings,
    reconcileAudioUploads,
  } = useMeetings();
  const recordingStorageScope = 'guest';
  const meetingScopeKey = 'guest' as const;

  const useCase = useMemo(() => new FinalizeNativeMeetingRecordingUseCase({
    saveTranscript: saveCachedTranscript,
    getCachedTranscript,
    recordTranscriptFailure: recordTranscriptProcessingFailure,
    updateStatus: updateMeetingStatus,
    refreshMeetings,
    reconcileUploads: reconcileAudioUploads,
  }), [
    getCachedTranscript,
    reconcileAudioUploads,
    recordingStorageScope,
    refreshMeetings,
    saveCachedTranscript,
    updateMeetingStatus,
  ]);

  const finalizeRecording = useCallback((request: NativeMeetingRecordingFinalizeRequest) => (
    useCase.execute({
      ...request,
      storageScope: recordingStorageScope,
      scopeKey: meetingScopeKey,
    })
  ), [meetingScopeKey, recordingStorageScope, useCase]);

  return {
    recordingStorageScope,
    meetingScopeKey,
    finalizeRecording,
  };
}
