import * as Crypto from 'expo-crypto';
import { getOrCreateDeviceIdentity } from './deviceIdentity';
import {
  createMeetingServiceBinding,
  ensureDeviceEpoch,
  getMeetingServiceBinding,
  listActiveMeetingServiceBindingsThrough,
  type MeetingServiceBinding,
} from '../data/repositories/vnext/deviceAuthorityRepository';
import { openMeetingDatabase } from '../data/db/openDatabase';
import {
  markPurgeCapabilityArmed,
  preparePurgeCapability,
} from 'laoji-native-platform';
import { DeviceV2ApiError, deviceV2Request } from './deviceV2Api';
import { diagnosticAudit } from './diagnostics';

function randomGeneration(): string {
  const bytes = Crypto.getRandomBytes(16);
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
}

/**
 * Allocates the phone-owned opaque service identity before any remote intent.
 * It is intentionally independent from the historical v1 server meeting ID.
 */
export async function ensureLocalMeetingServiceBinding(
  meetingId: string,
): Promise<MeetingServiceBinding> {
  diagnosticAudit('device_binding_local_start', {});
  const normalizedMeetingId = meetingId.trim();
  const database = await openMeetingDatabase();
  const resolved = await database.getFirstAsync<{ id: string }>(
    `SELECT id FROM meeting_notes
      WHERE id = ? OR legacy_source_id = ?
      ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END LIMIT 1`,
    normalizedMeetingId,
    normalizedMeetingId,
    normalizedMeetingId,
  );
  if (!resolved) {
    diagnosticAudit('device_binding_local_error', { error_code: 'meeting_index_missing' });
    throw new Error('会议本机索引不可用');
  }
  const canonicalMeetingId = resolved.id;
  const existing = await getMeetingServiceBinding(canonicalMeetingId);
  if (existing) {
    if (existing.state !== 'active') {
      diagnosticAudit('device_binding_local_error', { error_code: 'binding_not_active' });
      throw new Error('会议服务连接正在清理');
    }
    diagnosticAudit('device_binding_local_cached', {});
    return existing;
  }
  const identity = await getOrCreateDeviceIdentity();
  await ensureDeviceEpoch(identity.epochId);
  const created = await createMeetingServiceBinding({
    meetingId: canonicalMeetingId,
    epochId: identity.epochId,
    bindingId: Crypto.randomUUID().toLowerCase(),
    bindingGeneration: randomGeneration(),
  });
  diagnosticAudit('device_binding_local_ready', {});
  return created;
}

/**
 * Registers the phone-owned binding and its native-only purge capability as
 * one remote transaction. The native capability remains `registering` until
 * the server acknowledges the exact binding fence.
 */
export async function ensureRemoteMeetingServiceBinding(
  meetingId: string,
): Promise<MeetingServiceBinding> {
  diagnosticAudit('device_binding_remote_start', {});
  const target = await ensureLocalMeetingServiceBinding(meetingId);
  return enqueueBindingRegistration(async () => {
    try {
      // A newly-created local binding is almost always the server's exact next
      // sequence. Register it immediately so opening realtime transcription
      // needs one round trip rather than a cursor read followed by a write.
      // The server's contiguous-sequence fence remains the source of truth.
      await registerRemoteMeetingServiceBinding(target, true);
      return target;
    } catch (error) {
      if (!(error instanceof DeviceV2ApiError) || error.code !== 'BINDING_SEQUENCE_GAP') {
        throw error;
      }
      diagnosticAudit('device_binding_remote_gap_recovery', {
        target_sequence: target.bindingEpochSeq,
      });
    }

    const prefix = await listActiveMeetingServiceBindingsThrough({
      epochId: target.deviceEpochId,
      bindingEpochSeq: target.bindingEpochSeq,
    });
    if (!prefix.some(binding => binding.bindingId === target.bindingId)) {
      diagnosticAudit('device_binding_remote_error', { error_code: 'binding_prefix_incomplete' });
      throw new Error('会议服务连接序列不完整');
    }
    const remoteCursor = await loadRemoteBindingCursor().catch(error => {
      // Rolling deployments must keep working against the previous API.  Only
      // an absent cursor route falls back to the historical full-prefix replay;
      // authentication and network failures remain visible to recovery logic.
      if (error instanceof DeviceV2ApiError && error.status === 404) return 0;
      throw error;
    });
    diagnosticAudit('device_binding_remote_cursor_ready', {
      remote_cursor: remoteCursor,
      target_sequence: target.bindingEpochSeq,
      pending_bindings: Math.max(0, target.bindingEpochSeq - remoteCursor),
    });
    if (remoteCursor >= target.bindingEpochSeq) {
      await confirmRemoteMeetingServiceBinding(target);
      return target;
    }
    for (const binding of prefix) {
      if (binding.bindingEpochSeq <= remoteCursor) continue;
      await registerRemoteMeetingServiceBinding(binding, binding.bindingId === target.bindingId);
    }
    return target;
  });
}

async function loadRemoteBindingCursor(): Promise<number> {
  const response = await deviceV2Request<{
    schema_version: 2;
    cursor: { binding_epoch_seq: number };
  }>('/bindings/cursor', {}, '会议服务连接游标读取失败');
  const sequence = Number(response?.cursor?.binding_epoch_seq);
  if (response?.schema_version !== 2 || !Number.isSafeInteger(sequence) || sequence < 0) {
    diagnosticAudit('device_binding_remote_error', { error_code: 'binding_cursor_invalid' });
    throw new Error('会议服务连接游标无效');
  }
  return sequence;
}

function remoteBindingMatches(
  binding: MeetingServiceBinding,
  response: {
    schema_version: number;
    binding: {
      binding_id: string;
      binding_generation: string;
      binding_epoch_seq: number;
      binding_revision: number;
      cancel_revision: number;
      state: string;
    };
  },
): boolean {
  const remote = response.binding;
  return response.schema_version === 2
    && remote.binding_id === binding.bindingId
    && remote.binding_generation === binding.bindingGeneration
    && Number(remote.binding_epoch_seq) === binding.bindingEpochSeq
    && Number(remote.binding_revision) === binding.bindingRevision
    && Number(remote.cancel_revision) === binding.cancelRevision
    && remote.state === 'active';
}

async function confirmRemoteMeetingServiceBinding(binding: MeetingServiceBinding): Promise<void> {
  const purgeCapability = await preparePurgeCapability(
    'binding',
    binding.deviceEpochId,
    `binding-register-${binding.bindingId}`,
    {
      bindingId: binding.bindingId,
      bindingGeneration: binding.bindingGeneration,
    },
  );
  const response = await deviceV2Request<{
    schema_version: 2;
    binding: {
      binding_id: string;
      binding_generation: string;
      binding_epoch_seq: number;
      binding_revision: number;
      cancel_revision: number;
      state: string;
    };
  }>(
    `/meetings/${encodeURIComponent(binding.bindingId)}`,
    {},
    '会议服务连接确认失败',
  );
  if (!remoteBindingMatches(binding, response)) {
    diagnosticAudit('device_binding_remote_error', { error_code: 'binding_confirmation_mismatch' });
    throw new Error('会议服务连接确认不一致');
  }
  markPurgeCapabilityArmed(purgeCapability.capabilityId);
  diagnosticAudit('device_binding_remote_cached', { binding_epoch_seq: binding.bindingEpochSeq });
}

let bindingRegistrationQueue: Promise<void> = Promise.resolve();

function enqueueBindingRegistration<T>(operation: () => Promise<T>): Promise<T> {
  const result = bindingRegistrationQueue.then(operation, operation);
  bindingRegistrationQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function registerRemoteMeetingServiceBinding(
  binding: MeetingServiceBinding,
  target: boolean,
): Promise<void> {
  const purgeCapability = await preparePurgeCapability(
    'binding',
    binding.deviceEpochId,
    `binding-register-${binding.bindingId}`,
    {
      bindingId: binding.bindingId,
      bindingGeneration: binding.bindingGeneration,
    },
  );
  diagnosticAudit('device_binding_remote_capability_ready', {});
  const response = await deviceV2Request<{
    schema_version: 2;
    binding: {
      binding_id: string;
      binding_generation: string;
      binding_epoch_seq: number;
      binding_revision: number;
      cancel_revision: number;
      state: string;
    };
  }>(
    `/meetings/${encodeURIComponent(binding.bindingId)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schema_version: 2,
        binding_generation: binding.bindingGeneration,
        binding_epoch_seq: binding.bindingEpochSeq,
        binding_revision: binding.bindingRevision,
        cancel_revision: binding.cancelRevision,
        purge_capability: {
          capability_id: purgeCapability.capabilityId,
          secret_sha256: purgeCapability.secretSha256,
          registration_request_id: purgeCapability.registrationRequestId,
        },
      }),
    },
    '会议服务连接登记失败',
  );
  if (!remoteBindingMatches(binding, response)) {
    diagnosticAudit('device_binding_remote_error', { error_code: 'binding_confirmation_mismatch' });
    throw new Error('会议服务连接确认不一致');
  }
  diagnosticAudit('device_binding_remote_ready', {
    sequence_backfill: !target,
    binding_epoch_seq: binding.bindingEpochSeq,
  });
  markPurgeCapabilityArmed(purgeCapability.capabilityId);
}
