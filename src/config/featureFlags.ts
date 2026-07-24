import Constants from 'expo-constants';

export interface LaoJiFeatureFlags {
  localMeetingDbV1: boolean;
  localMeetingDbCanonicalReadV1: boolean;
  localMeetingDbCanonicalWriteV1: boolean;
  localMeetingDbAccountRootWriteV1: boolean;
  localMeetingDbAccountUploadWriteV1: boolean;
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
    // Account upload remains isolated from the broad write flag until the
    // deployed root and audio contracts are verified together.
    localMeetingDbAccountUploadWriteV1: localMeetingDbCanonicalReadV1
      && extra.featureFlags?.localMeetingDbCanonicalWriteV1 === true
      && extra.featureFlags?.localMeetingDbAccountUploadWriteV1 === true,
  };
}
