import * as Crypto from 'expo-crypto';
import { getOrCreateDeviceIdentity } from './deviceIdentity';
import {
  createMeetingServiceBinding,
  ensureDeviceEpoch,
  getMeetingServiceBinding,
  type MeetingServiceBinding,
} from '../data/repositories/vnext/deviceAuthorityRepository';
import { openMeetingDatabase } from '../data/db/openDatabase';
import {
  markPurgeCapabilityArmed,
  preparePurgeCapability,
} from 'laoji-native-platform';
import { deviceV2Request } from './deviceV2Api';
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
  const binding = await ensureLocalMeetingServiceBinding(meetingId);
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
  const remote = response.binding;
  if (
    response.schema_version !== 2
    || remote.binding_id !== binding.bindingId
    || remote.binding_generation !== binding.bindingGeneration
    || Number(remote.binding_epoch_seq) !== binding.bindingEpochSeq
    || Number(remote.binding_revision) !== binding.bindingRevision
    || Number(remote.cancel_revision) !== binding.cancelRevision
    || remote.state !== 'active'
  ) {
    diagnosticAudit('device_binding_remote_error', { error_code: 'binding_confirmation_mismatch' });
    throw new Error('会议服务连接确认不一致');
  }
  diagnosticAudit('device_binding_remote_ready', {});
  markPurgeCapabilityArmed(purgeCapability.capabilityId);
  return binding;
}
