import React, { useEffect } from 'react';
import { AppState } from 'react-native';
import { ensureDeviceReady } from '../services/deviceApi';
import { diagnosticAudit, diagnosticWarn } from '../services/diagnostics';
import { drainDeviceSpeakerDeletionOutbox } from '../services/speakers';
import { resumePendingRemotePurge } from '../services/localDataEraseCoordinator';

/**
 * Device service registration is deliberately best-effort and never gates the
 * first frame.  Calendar and existing local meeting data remain usable while
 * the server is being deployed or temporarily unreachable.
 */
export function DeviceServiceCoordinator(): null {
  useEffect(() => {
    let active = true;
    void resumePendingRemotePurge()
      .then(result => {
        if (!active || result === 'none') return;
        diagnosticAudit('device_remote_purge_resume', { result });
      })
      .catch(error => {
        if (active) diagnosticWarn('[device-service] purge resume deferred', error);
      });
    void ensureDeviceReady()
      .then(identity => {
        if (!active) return;
        diagnosticAudit('device_service_ready', {
          device_id_suffix: identity.deviceId.slice(-8),
          epoch_id_suffix: identity.epochId.slice(-8),
        });
      })
      .catch(error => {
        if (active) diagnosticWarn('[device-service] registration deferred', error);
      });
    void drainDeviceSpeakerDeletionOutbox(true);
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') void drainDeviceSpeakerDeletionOutbox();
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);
  return null;
}
