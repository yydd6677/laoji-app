import * as Crypto from 'expo-crypto';
import { getOrCreateDeviceIdentity } from './deviceIdentity';
import {
  createMeetingServiceBinding,
  ensureDeviceEpoch,
  getMeetingServiceBinding,
  type MeetingServiceBinding,
} from '../data/repositories/vnext/deviceAuthorityRepository';
import { openMeetingDatabase } from '../data/db/openDatabase';

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
  if (!resolved) throw new Error('会议本机索引不可用');
  const canonicalMeetingId = resolved.id;
  const existing = await getMeetingServiceBinding(canonicalMeetingId);
  if (existing) {
    if (existing.state !== 'active') throw new Error('会议服务连接正在清理');
    return existing;
  }
  const identity = await getOrCreateDeviceIdentity();
  await ensureDeviceEpoch(identity.epochId);
  return createMeetingServiceBinding({
    meetingId: canonicalMeetingId,
    epochId: identity.epochId,
    bindingId: Crypto.randomUUID().toLowerCase(),
    bindingGeneration: randomGeneration(),
  });
}
