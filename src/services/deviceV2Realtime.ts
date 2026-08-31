import {
  attachNativeDeviceV2Recorder,
  startNativeDeviceV2Recorder,
  type NativeDeviceV2RecorderStartOptions,
  type NativeRealtimeRecorderSnapshot,
} from 'laoji-native-platform';
import { ensureNativeDeviceV2TransferLease } from '../native/nativeTransferCoordinator';
import { ensureRemoteMeetingServiceBinding } from './deviceAuthority';
import { ensureDeviceV2Session, loadDeviceV2Capabilities } from './deviceV2Api';
import { getApiConfig } from './config';
import { diagnosticAudit } from './diagnostics';

export interface DeviceV2RealtimeRecordingInput {
  meetingId: string;
  sessionId: string;
  taskId?: string;
  clientOperationId?: string;
  assetId?: string;
  assetGeneration?: string;
  storageScope?: 'guest';
  expiresAtEpoch?: number;
  allowInsecureDevelopment?: boolean;
  connectionTimeoutMs?: number;
  stopTimeoutMs?: number;
  levelIntervalMs?: number;
}

export async function prewarmDeviceV2RealtimeRecording(): Promise<boolean> {
  diagnosticAudit('device_v2_realtime_prewarm_start', {});
  const capabilities = await loadDeviceV2Capabilities();
  if (!capabilities.realtimeAsrV2) return false;
  const session = await ensureDeviceV2Session();
  const lease = await ensureNativeDeviceV2TransferLease(session);
  diagnosticAudit('device_v2_realtime_prewarm_ready', { lease_ready: Boolean(lease) });
  return Boolean(lease);
}

/**
 * Direct v2 start surface for callers that do not use the current
 * local-capture-first attach flow.
 */
export async function startDeviceV2RealtimeRecording(
  input: DeviceV2RealtimeRecordingInput,
): Promise<NativeRealtimeRecorderSnapshot> {
  diagnosticAudit('device_v2_realtime_start', {});
  const options = await prepareDeviceV2RealtimeRecording(input);
  diagnosticAudit('device_v2_realtime_native_start', {});
  try {
    const snapshot = await startNativeDeviceV2Recorder(options);
    diagnosticAudit('device_v2_realtime_native_ready', {});
    return snapshot;
  } catch (error) {
    diagnosticAudit('device_v2_realtime_native_error', { error_code: error instanceof Error ? error.name : 'unknown' });
    throw error;
  }
}

export async function attachDeviceV2RealtimeRecording(
  input: DeviceV2RealtimeRecordingInput,
): Promise<NativeRealtimeRecorderSnapshot> {
  diagnosticAudit('device_v2_realtime_attach_start', {});
  const options = await prepareDeviceV2RealtimeRecording(input);
  try {
    const snapshot = await attachNativeDeviceV2Recorder(options);
    diagnosticAudit('device_v2_realtime_attach_ready', {});
    return snapshot;
  } catch (error) {
    diagnosticAudit('device_v2_realtime_attach_error', { error_code: error instanceof Error ? error.name : 'unknown' });
    throw error;
  }
}

async function prepareDeviceV2RealtimeRecording(
  input: DeviceV2RealtimeRecordingInput,
): Promise<NativeDeviceV2RecorderStartOptions> {
  const binding = await ensureRemoteMeetingServiceBinding(input.meetingId);
  diagnosticAudit('device_v2_realtime_binding_ready', {});
  const session = await ensureDeviceV2Session();
  diagnosticAudit('device_v2_realtime_session_ready', {});
  if (binding.deviceEpochId !== session.epochId) {
    throw new Error('实时转写设备 epoch 与会议连接不一致');
  }
  const lease = await ensureNativeDeviceV2TransferLease(session);
  if (!lease) throw new Error('当前构建不支持 device-v2 实时转写');
  diagnosticAudit('device_v2_realtime_lease_ready', {});
  const websocketUrl = `${getApiConfig().realtimeAsrBase}/api/device/v2/realtime/${encodeURIComponent(input.sessionId)}`;
  const taskId = input.taskId ?? `v2-realtime-transcript-${binding.bindingId}`;
  const clientOperationId = input.clientOperationId ?? `v2-realtime-operation-${binding.bindingId}`;
  const assetId = input.assetId ?? `v2-realtime-asset-${binding.bindingId}`;
  const assetGeneration = input.assetGeneration ?? binding.bindingGeneration;
  const expiresAtEpoch = input.expiresAtEpoch ?? Math.floor(Date.now() / 1_000) + 23 * 60 * 60;
  return {
    sessionId: input.sessionId,
    storageScope: input.storageScope,
    websocketUrl,
    credentialScope: lease.scope,
    credentialGeneration: lease.generation,
    taskId,
    clientOperationId,
    bindingId: binding.bindingId,
    bindingGeneration: binding.bindingGeneration,
    bindingRevision: binding.bindingRevision,
    cancelRevision: binding.cancelRevision,
    assetId,
    assetGeneration,
    expiresAtEpoch,
    allowInsecureDevelopment: input.allowInsecureDevelopment,
    connectionTimeoutMs: input.connectionTimeoutMs,
    stopTimeoutMs: input.stopTimeoutMs,
    levelIntervalMs: input.levelIntervalMs,
  };
}
