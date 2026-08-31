import { useEffect } from 'react';
import { activateMinutesPlaybackStorageScope } from 'laoji-native-platform';

/** Keep native playback storage in the installation-local namespace. */
export function NativePlatformCoordinator() {
  useEffect(() => {
    void activateMinutesPlaybackStorageScope('guest').catch(() => {});
  }, []);

  return null;
}
