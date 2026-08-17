import { useEffect, useMemo, useRef, useState } from 'react';
import * as Crypto from 'expo-crypto';
import type { NativeProjectionEnvelope } from 'laoji-native-platform';
import { createNativeRandomUuid } from 'laoji-native-platform';
import { getOrCreateDeviceIdentity } from '../services/deviceIdentity';
import {
  createProjectionEnvelope,
  stableProjectionJson,
} from './projectionEnvelope';

type ProjectionState = {
  key: string;
  envelope: NativeProjectionEnvelope;
} | null;

/**
 * Adds a revisioned native projection only when the candidate flag is on.
 * While a new hash is being computed, null is deliberately emitted so a live
 * native host keeps its previous projection instead of rendering body/hash
 * from different revisions.
 */
export function useNativeProjection<T extends object>(
  snapshot: T,
  options: { enabled: boolean; entityId: string },
): T & { projection?: NativeProjectionEnvelope | null } {
  const { enabled, entityId } = options;
  const surfaceInstanceId = useMemo(
    () => createNativeRandomUuid() ?? Crypto.randomUUID(),
    [],
  );
  const payloadKey = enabled ? stableProjectionJson(snapshot) : '';
  const lastKeyRef = useRef('');
  const revisionRef = useRef(0);
  if (enabled && payloadKey !== lastKeyRef.current) {
    lastKeyRef.current = payloadKey;
    revisionRef.current += 1;
  }
  const revision = revisionRef.current;
  const [deviceEpoch, setDeviceEpoch] = useState<string | null>(null);
  const [projection, setProjection] = useState<ProjectionState>(null);

  useEffect(() => {
    if (!enabled) {
      setDeviceEpoch(null);
      setProjection(null);
      return;
    }
    let active = true;
    void getOrCreateDeviceIdentity()
      .then(identity => {
        if (active) setDeviceEpoch(identity.epochId);
      })
      .catch(() => {
        if (active) setDeviceEpoch(null);
      });
    return () => { active = false; };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !deviceEpoch || !payloadKey || revision < 1) {
      setProjection(null);
      return;
    }
    let active = true;
    void createProjectionEnvelope(
      {
        deviceEpoch,
        entityId,
        entityRevision: revision,
        viewRevision: revision,
        surfaceInstanceId,
      },
      snapshot,
    ).then(envelope => {
      if (active) setProjection({ key: payloadKey, envelope });
    }).catch(() => {
      if (active) setProjection(null);
    });
    return () => { active = false; };
  }, [deviceEpoch, enabled, entityId, payloadKey, revision, snapshot, surfaceInstanceId]);

  return useMemo(() => ({
    ...snapshot,
    ...(enabled ? { projection: projection?.key === payloadKey ? projection.envelope : null } : {}),
  }), [enabled, payloadKey, projection, snapshot]);
}
