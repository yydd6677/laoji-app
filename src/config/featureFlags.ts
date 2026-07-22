import Constants from 'expo-constants';

export interface LaoJiFeatureFlags {
  localMeetingDbV1: boolean;
}

type ExtraWithFeatureFlags = {
  featureFlags?: Partial<LaoJiFeatureFlags>;
};

export function getFeatureFlags(): LaoJiFeatureFlags {
  const extra = (Constants.expoConfig?.extra ?? {}) as ExtraWithFeatureFlags;
  return {
    localMeetingDbV1: extra.featureFlags?.localMeetingDbV1 !== false,
  };
}
