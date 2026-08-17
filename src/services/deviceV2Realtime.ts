import {
  startNativeDeviceV2Recorder,
  type NativeRealtimeRecorderSnapshot,
} from 'laoji-native-platform';
import { ensureNativeDeviceV2TransferLease } from '../native/nativeTransferCoordinator';
import { ensureRemoteMeetingServiceBinding } from './deviceAuthority';
import { ensureDeviceV2Session } from './deviceV2Api';
import { getApiConfig } from './config';

export interface DeviceV2RealtimeRecordingInput {
  meetingId: string;
  sessionId: string;
  taskId: string;
  clientOperationId: string;
  assetId: string;
  assetGeneration: string;
  storageScope?: string;
  expiresAtEpoch: number;
  allowInsecureDevelopment?: boolean;
  connectionTimeoutMs?: number;
  stopTimeoutMs?: number;
  levelIntervalMs?: number;
}

/**
 * Isolated Stage 2 activation surface. No current screen calls this function;
 * the legacy recorder remains the default until the capability barrier moves.
 */
export async function startDeviceV2RealtimeRecording(
  input: DeviceV2RealtimeRecordingInput,
): Promise<NativeRealtimeRecorderSnapshot> {
  const binding = await ensureRemoteMeetingServiceBinding(input.meetingId);
  const session = await ensureDeviceV2Session();
  if (binding.deviceEpochId !== session.epochId) {
    throw new Error('实时转写设备 epoch 与会议连接不一致');
  }
  const lease = await ensureNativeDeviceV2TransferLease(session);
  if (!lease) throw new Error('当前构建不支持 device-v2 实时转写');
  const websocketUrl = `${getApiConfig().realtimeAsrBase}/api/device/v2/realtime/${encodeURIComponent(input.sessionId)}`;
  return startNativeDeviceV2Recorder({
    sessionId: input.sessionId,
    storageScope: input.storageScope,
    websocketUrl,
    credentialScope: lease.scope,
    credentialGeneration: lease.generation,
    taskId: input.taskId,
    clientOperationId: input.clientOperationId,
    bindingId: binding.bindingId,
    bindingGeneration: binding.bindingGeneration,
    bindingRevision: binding.bindingRevision,
    cancelRevision: binding.cancelRevision,
    assetId: input.assetId,
    assetGeneration: input.assetGeneration,
    expiresAtEpoch: input.expiresAtEpoch,
    allowInsecureDevelopment: input.allowInsecureDevelopment,
    connectionTimeoutMs: input.connectionTimeoutMs,
    stopTimeoutMs: input.stopTimeoutMs,
    levelIntervalMs: input.levelIntervalMs,
  });
}
