import Constants from 'expo-constants';

export interface LaoJiFeatureFlags {
  localMeetingDbV1: boolean;
  localMeetingDbCanonicalReadV1: boolean;
}

type ExtraWithFeatureFlags = {
  featureFlags?: Partial<LaoJiFeatureFlags>;
};

export function getFeatureFlags(): LaoJiFeatureFlags {
  const extra = (Constants.expoConfig?.extra ?? {}) as ExtraWithFeatureFlags;
  const localMeetingDbV1 = extra.featureFlags?.localMeetingDbV1 !== false;
  return {
    localMeetingDbV1,
    // Canonical reads are fail-closed and can never outlive the underlying
    // database flag. Release builds must opt in explicitly after preflight.
    localMeetingDbCanonicalReadV1: localMeetingDbV1
      && extra.featureFlags?.localMeetingDbCanonicalReadV1 === true,
  };
}
