import Constants from 'expo-constants';

export interface LaoJiFeatureFlags {
  localMeetingDbV1: boolean;
  localMeetingDbCanonicalReadV1: boolean;
  localMeetingDbCanonicalWriteV1: boolean;
  localMeetingDbAccountRootWriteV1: boolean;
  localMeetingDbAccountUploadWriteV1: boolean;
  meetingQuestionsV1: boolean;
  meetingAutomaticTopicsV1: boolean;
  meetingTagSyncV1: boolean;
  meetingAttachmentSyncV1: boolean;
  meetingMarkerSyncV1: boolean;
  meetingMediaImportExistingV1: boolean;
  meetingMediaClipsV1: boolean;
  meetingTranscriptReprocessV1: boolean;
  meetingActionCollaborationV1: boolean;
  meetingContentShareLinksV1: boolean;
}

type ExtraWithFeatureFlags = {
  featureFlags?: Partial<LaoJiFeatureFlags>;
};

export function getFeatureFlags(): LaoJiFeatureFlags {
  const extra = (Constants.expoConfig?.extra ?? {}) as ExtraWithFeatureFlags;
  const localMeetingDbV1 = extra.featureFlags?.localMeetingDbV1 !== false;
  const localMeetingDbCanonicalReadV1 = localMeetingDbV1
    && extra.featureFlags?.localMeetingDbCanonicalReadV1 === true;
  return {
    localMeetingDbV1,
    // Canonical reads are fail-closed and can never outlive the underlying
    // database flag. Release builds must opt in explicitly after preflight.
    localMeetingDbCanonicalReadV1,
    // Canonical writes require the canonical reader so a committed SQLite
    // mutation can remain visible while the downgrade mirror is repaired.
    localMeetingDbCanonicalWriteV1: localMeetingDbCanonicalReadV1
      && extra.featureFlags?.localMeetingDbCanonicalWriteV1 === true,
    // Root create/update/delete transport stays independently gated until the
    // deployed account API contract and recovery path are verified end to end.
    localMeetingDbAccountRootWriteV1: localMeetingDbCanonicalReadV1
      && extra.featureFlags?.localMeetingDbCanonicalWriteV1 === true
      && extra.featureFlags?.localMeetingDbAccountRootWriteV1 === true,
    // Account upload remains independently reversible. Runtime writes still
    // require a fresh recording_assets_v2 capability response.
    localMeetingDbAccountUploadWriteV1: localMeetingDbCanonicalReadV1
      && extra.featureFlags?.localMeetingDbCanonicalWriteV1 === true
      && extra.featureFlags?.localMeetingDbAccountUploadWriteV1 === true,
    // QA remains independently reversible even though its source revisions are
    // stored in the canonical meeting database.
    meetingQuestionsV1: localMeetingDbCanonicalReadV1
      && extra.featureFlags?.meetingQuestionsV1 === true,
    // Current structured Summary topics remain a read-only source and never
    // create or mutate user-owned meeting tags.
    meetingAutomaticTopicsV1: localMeetingDbCanonicalReadV1
      && extra.featureFlags?.meetingAutomaticTopicsV1 === true,
    // User tags stay local-first; account transport additionally requires a
    // fresh meeting_tags_v1 service capability before any remote write.
    meetingTagSyncV1: localMeetingDbCanonicalReadV1
      && extra.featureFlags?.localMeetingDbCanonicalWriteV1 === true
      && extra.featureFlags?.meetingTagSyncV1 === true,
    // Account attachments remain local-first and only contact a server that
    // freshly advertises meeting_attachments_v1.
    meetingAttachmentSyncV1: localMeetingDbCanonicalReadV1
      && extra.featureFlags?.localMeetingDbCanonicalWriteV1 === true
      && extra.featureFlags?.meetingAttachmentSyncV1 === true,
    // Account markers stay local-first and only contact a server that freshly
    // advertises meeting_markers_v1.
    meetingMarkerSyncV1: localMeetingDbCanonicalReadV1
      && extra.featureFlags?.localMeetingDbCanonicalWriteV1 === true
      && extra.featureFlags?.meetingMarkerSyncV1 === true,
    // Explicitly attaching imported media requires canonical multi-asset writes.
    meetingMediaImportExistingV1: localMeetingDbCanonicalReadV1
      && extra.featureFlags?.meetingMediaImportExistingV1 === true,
    // Derived WAV clips remain independently reversible and never replace the
    // source RecordingAsset.
    meetingMediaClipsV1: localMeetingDbCanonicalReadV1
      && extra.featureFlags?.meetingMediaClipsV1 === true,
    // A user-requested reprocess creates a new immutable transcript revision;
    // runtime submission still requires a fresh transcript_reprocess_v1 capability.
    meetingTranscriptReprocessV1: localMeetingDbCanonicalReadV1
      && extra.featureFlags?.meetingTranscriptReprocessV1 === true,
    // Collaboration links expose one action projection only and remain
    // independently reversible from meeting-level sharing.
    meetingActionCollaborationV1: localMeetingDbCanonicalReadV1
      && extra.featureFlags?.meetingActionCollaborationV1 === true,
    // Account meeting links are explicit, frozen by default, and capability-gated.
    meetingContentShareLinksV1: localMeetingDbCanonicalReadV1
      && extra.featureFlags?.localMeetingDbCanonicalWriteV1 === true
      && extra.featureFlags?.meetingContentShareLinksV1 === true,
  };
}
