import { useCallback, useMemo } from 'react';
import type { ApiGuestRealtimeSession } from '../services/api';
import { deleteGuestRealtimeSession, uploadMeetingAudio } from '../services/api';
import {
  FinalizeNativeMeetingRecordingUseCase,
  type FinalizeNativeMeetingRecordingResult,
} from '../application/meeting';
import { enqueueNativeMeetingUpload } from '../native/nativeTransferCoordinator';
import { mirrorLegacyTranscriptProcessingFailure } from '../services/meetingStageMirror';
import { useAuth } from '../store/AuthStore';
import { useMeetings } from '../store/MeetingsStore';
import type { TranscriptLine } from '../types';

export interface NativeMeetingRecordingFinalizeRequest {
  meetingId: string;
  remoteMeetingId: string | null;
  guestSession?: ApiGuestRealtimeSession;
  getTranscriptLines: () => TranscriptLine[];
  getAudioDurationSec: () => number | undefined;
  getAudioBars: () => number[] | undefined;
  stopAudio: () => Promise<string | undefined>;
}

export interface NativeMeetingRecordingFinalizer {
  recordingStorageScope: string;
  meetingScopeKey: 'guest' | `user:${string}` | null;
  finalizeRecording: (
    request: NativeMeetingRecordingFinalizeRequest,
  ) => Promise<FinalizeNativeMeetingRecordingResult>;
}

export function useNativeMeetingRecordingFinalizer(): NativeMeetingRecordingFinalizer {
  const { accessToken, isGuest, session } = useAuth();
  const {
    getCachedTranscript,
    saveCachedTranscript,
    updateMeetingStatus,
    refreshMeetings,
    reconcileAudioUploads,
  } = useMeetings();
  const recordingStorageScope = isGuest ? 'guest' : session ? `user:${session.user.id}` : 'signed_out';
  const meetingScopeKey = isGuest
    ? 'guest' as const
    : session
      ? `user:${session.user.id}` as const
      : null;

  const useCase = useMemo(() => new FinalizeNativeMeetingRecordingUseCase({
    saveTranscript: saveCachedTranscript,
    getCachedTranscript,
    recordTranscriptFailure: mirrorLegacyTranscriptProcessingFailure,
    uploadAudio: (meetingId, uri, token) => uploadMeetingAudio(
      meetingId,
      uri,
      token,
      { fileName: `${meetingId}.wav`, mimeType: 'audio/wav' },
    ),
    enqueuePersistentUpload: (pending, token) => enqueueNativeMeetingUpload({
      scope: recordingStorageScope,
      accessToken: token,
      meetingId: pending.meetingId,
      remoteMeetingId: pending.remoteMeetingId,
      operationId: `meeting-audio:${pending.meetingId}:${pending.createdAt}`,
      fileUri: pending.audioUri,
      mimeType: pending.mimeType,
      fileName: pending.fileName,
    }),
    updateStatus: updateMeetingStatus,
    refreshMeetings,
    reconcileUploads: reconcileAudioUploads,
    deleteGuestSession: sessionIdentity => deleteGuestRealtimeSession(
      sessionIdentity.meetingId,
      sessionIdentity.guestToken,
    ),
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
      isGuest,
      accessToken,
      guestSession: request.guestSession
        ? {
            meetingId: request.guestSession.meeting_id,
            guestToken: request.guestSession.guest_token,
          }
        : undefined,
    })
  ), [accessToken, isGuest, meetingScopeKey, recordingStorageScope, useCase]);

  return {
    recordingStorageScope,
    meetingScopeKey,
    finalizeRecording,
  };
}
