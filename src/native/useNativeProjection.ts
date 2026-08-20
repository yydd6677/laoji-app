import { useEffect, useMemo, useRef, useState } from 'react';
import * as Crypto from 'expo-crypto';
import type { NativeProjectionEnvelope } from 'laoji-native-platform';
import { createNativeRandomUuid } from 'laoji-native-platform';
import { getOrCreateDeviceIdentity } from '../services/deviceIdentity';
import {
  acceptNativeProjectionCheckpoint,
  getNativeProjectionCheckpoint,
  type NativeProjectionCheckpoint,
} from '../data/repositories/vnext/nativeProjectionCheckpointRepository';
import { ensureDeviceEpoch } from '../data/repositories/vnext/deviceAuthorityRepository';
import {
  createProjectionEnvelope,
  projectionPayloadSha256,
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
  options: { enabled: boolean; entityId: string; surfaceKey: string },
): T & { projection?: NativeProjectionEnvelope | null } {
  const { enabled, entityId, surfaceKey } = options;
  const surfaceInstanceId = useMemo(
    () => createNativeRandomUuid() ?? Crypto.randomUUID(),
    [],
  );
  const payloadKey = enabled ? stableProjectionJson(snapshot) : '';
  const [deviceEpoch, setDeviceEpoch] = useState<string | null>(null);
  const [checkpointReady, setCheckpointReady] = useState(false);
  const [projection, setProjection] = useState<ProjectionState>(null);
  const checkpointRef = useRef<NativeProjectionCheckpoint | null>(null);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  useEffect(() => {
    if (!enabled) {
      setDeviceEpoch(null);
      setCheckpointReady(false);
      checkpointRef.current = null;
      setProjection(null);
      return;
    }
    let active = true;
    setCheckpointReady(false);
    checkpointRef.current = null;
    setProjection(null);
    void getOrCreateDeviceIdentity().then(async identity => {
      // Projection checkpoints reference the local epoch owner. Device network
      // registration is intentionally best-effort, so establish this local FK
      // before a first-frame projection instead of waiting for remote startup.
      await ensureDeviceEpoch(identity.epochId);
      const checkpoint = await getNativeProjectionCheckpoint({
        deviceEpochId: identity.epochId,
        surfaceKey,
        entityId,
      });
      if (!active) return;
      setDeviceEpoch(identity.epochId);
      checkpointRef.current = checkpoint;
      setCheckpointReady(true);
    }).catch(() => {
      if (!active) return;
      setDeviceEpoch(null);
      checkpointRef.current = null;
      setCheckpointReady(true);
    });
    return () => { active = false; };
  }, [enabled, entityId, surfaceKey]);

  useEffect(() => {
    if (!enabled || !deviceEpoch || !checkpointReady || !payloadKey) {
      setProjection(null);
      return;
    }
    let active = true;
    void (async () => {
      // Hash and envelope one immutable render snapshot. A newer render can
      // replace snapshotRef while the digest is pending; mixing its body with
      // the previous payload key would corrupt the persistent action fence.
      const payloadSnapshot = snapshotRef.current;
      const payloadSha256 = await projectionPayloadSha256(payloadSnapshot);
      if (!active) return;
      // At most one retry is needed when a cancelled previous render committed
      // between this render reading the checkpoint and accepting its hash.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const previous = checkpointRef.current;
        const samePayload = previous?.payloadSha256 === payloadSha256;
        const entityRevision = samePayload ? previous.entityRevision : (previous?.entityRevision ?? 0) + 1;
        const viewRevision = samePayload ? previous.viewRevision : (previous?.viewRevision ?? 0) + 1;
        const envelope = await createProjectionEnvelope(
          {
            deviceEpoch,
            entityId,
            entityRevision,
            viewRevision,
            surfaceInstanceId,
          },
          payloadSnapshot,
        );
        if (!active) return;
        const accepted = await acceptNativeProjectionCheckpoint({
          deviceEpochId: deviceEpoch,
          surfaceKey,
          entityId,
          entityRevision,
          viewRevision,
          surfaceInstanceId,
          payloadSha256,
        });
        if (!active) return;
        checkpointRef.current = accepted.checkpoint;
        if (accepted.status === 'stale') continue;
        setProjection({ key: payloadKey, envelope });
        return;
      }
    })().catch(() => {
      if (active) setProjection(null);
    });
    return () => { active = false; };
  }, [checkpointReady, deviceEpoch, enabled, entityId, payloadKey, surfaceKey, surfaceInstanceId]);

  return useMemo(() => ({
    ...snapshot,
    ...(enabled ? { projection: projection?.key === payloadKey ? projection.envelope : null } : {}),
  }), [enabled, payloadKey, projection, snapshot]);
}
