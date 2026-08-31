import {
  requireOptionalNativeModule,
  type EventSubscription,
  type NativeModule,
} from 'expo-modules-core';

export type HardwareConnectionPhase =
  | 'disconnected'
  | 'discovered'
  | 'permission_required'
  | 'connecting'
  | 'handshaking'
  | 'ready'
  | 'recording'
  | 'paused'
  | 'finalizing'
  | 'transferring'
  | 'retryable_error'
  | 'incompatible';

export type HardwareTransport = 'usb' | 'ble' | 'wifi';

export interface HardwareConnectionState {
  phase: HardwareConnectionPhase;
  transport: HardwareTransport | null;
  locator: string | null;
  deviceId: string | null;
  model: string | null;
  firmwareRevision: string | null;
  hardwareRevision: string | null;
  securityMode: 'development_usb' | 'development_ble' | 'paired' | 'production_attested' | null;
  capabilities: Record<string, unknown>;
  sessionId: string | null;
  streamId: number | null;
  transferProgress: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  updatedAtMs: number;
}

export interface HardwareUsbDevice {
  locator: string;
  transport: 'usb';
  vendorId: number;
  productId: number;
  deviceName: string;
  productName: string;
  manufacturerName: string;
  serialNumber: string | null;
  hasPermission: boolean;
  compatible: boolean;
}

export interface HardwareBleDevice {
  locator: string;
  transport: 'ble';
  productName: string;
  rssi: number;
  compatible: boolean;
}

export type HardwareDevice = HardwareUsbDevice | HardwareBleDevice;

export interface PendingHardwareRecording {
  recordingId: string;
  deviceId: string;
  sessionId: string;
  localUri: string;
  recordedAtMs: number;
  durationMs: number;
  byteSize: number;
  checksumSha256: string;
  interrupted: boolean;
  sampleRateHz: number;
  bitsPerSample: number;
  channels: number;
  sourceDeviceRecordingId: string | null;
  sourceGeneration: string | null;
  title: string | null;
}

export interface HardwareDeviceRecording {
  recordingId: string;
  generation: string;
  title: string | null;
  byteSize: number;
  durationMs: number;
  checksumSha256: string;
  checksumScope: 'whole_file' | 'audio_payload';
  createdEpochMs: number | null;
  acknowledged: boolean;
  recovered: boolean;
}

export interface HardwareLevelEvent {
  sessionId: string;
  peak: number;
  rms: number;
  normalized: number;
}

interface HardwareEvents {
  [eventName: string]: (...args: any[]) => void;
  onHardwareStateChanged: (value: unknown) => void;
  onHardwareRecordingReady: (value: unknown) => void;
  onHardwareLevel: (value: unknown) => void;
}

interface LaojiHardwareNativeModule extends NativeModule<HardwareEvents> {
  getState(): Promise<unknown>;
  listDevices(): Promise<unknown>;
  scanBleDevices(): Promise<unknown>;
  requestUsbPermission(locator: string): Promise<boolean>;
  connectUsb(locator: string): Promise<unknown>;
  connectBle(locator: string): Promise<unknown>;
  disconnect(): Promise<unknown>;
  startCapture(): Promise<unknown>;
  stopCapture(): Promise<unknown>;
  pauseCapture(): Promise<unknown>;
  resumeCapture(): Promise<unknown>;
  listDeviceRecordings(): Promise<unknown>;
  renameDeviceRecording(recordingId: string, generation: string, title: string): Promise<unknown>;
  deleteDeviceRecording(recordingId: string, generation: string): Promise<boolean>;
  receiveDeviceRecording(recordingId: string, generation: string): Promise<unknown>;
  listPendingRecordings(): Promise<unknown>;
  acknowledgeRecording(recordingId: string): Promise<boolean>;
  addListener<Name extends keyof HardwareEvents>(
    eventName: Name,
    listener: HardwareEvents[Name],
  ): EventSubscription;
}

const nativeModule = requireOptionalNativeModule<LaojiHardwareNativeModule>('LaojiHardware');

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`native hardware ${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`native hardware ${label} is invalid`);
  }
  return value.trim();
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`native hardware ${label} is invalid`);
  }
  return value;
}

function nullableInteger(value: unknown): number | null {
  return value == null ? null : integer(value, 'integer');
}

function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`native hardware ${label} is invalid`);
  }
  return value;
}

const PHASES = new Set<HardwareConnectionPhase>([
  'disconnected', 'discovered', 'permission_required', 'connecting', 'handshaking',
  'ready', 'recording', 'paused', 'finalizing', 'transferring', 'retryable_error', 'incompatible',
]);

function normalizeState(value: unknown): HardwareConnectionState {
  const source = object(value, 'state');
  const phase = string(source.phase, 'phase') as HardwareConnectionPhase;
  if (!PHASES.has(phase)) throw new Error('native hardware phase is invalid');
  const transport = nullableString(source.transport);
  if (transport && !['usb', 'ble', 'wifi'].includes(transport)) {
    throw new Error('native hardware transport is invalid');
  }
  const securityMode = nullableString(source.securityMode);
  if (securityMode && !['development_usb', 'development_ble', 'paired', 'production_attested'].includes(securityMode)) {
    throw new Error('native hardware security mode is invalid');
  }
  const capabilities = source.capabilities == null
    ? {}
    : object(source.capabilities, 'capabilities');
  return {
    phase,
    transport: transport as HardwareTransport | null,
    locator: nullableString(source.locator),
    deviceId: nullableString(source.deviceId),
    model: nullableString(source.model),
    firmwareRevision: nullableString(source.firmwareRevision),
    hardwareRevision: nullableString(source.hardwareRevision),
    securityMode: securityMode as HardwareConnectionState['securityMode'],
    capabilities,
    sessionId: nullableString(source.sessionId),
    streamId: nullableInteger(source.streamId),
    transferProgress: source.transferProgress == null
      ? null
      : finite(source.transferProgress, 'transferProgress'),
    errorCode: nullableString(source.errorCode),
    errorMessage: nullableString(source.errorMessage),
    updatedAtMs: integer(source.updatedAtMs, 'updatedAtMs'),
  };
}

function normalizeUsbDevice(value: unknown): HardwareUsbDevice {
  const source = object(value, 'USB device');
  return {
    locator: string(source.locator, 'locator'),
    transport: 'usb',
    vendorId: integer(source.vendorId, 'vendorId'),
    productId: integer(source.productId, 'productId'),
    deviceName: typeof source.deviceName === 'string' ? source.deviceName : '',
    productName: typeof source.productName === 'string' ? source.productName : '',
    manufacturerName: typeof source.manufacturerName === 'string' ? source.manufacturerName : '',
    serialNumber: nullableString(source.serialNumber),
    hasPermission: source.hasPermission === true,
    compatible: source.compatible === true,
  };
}

function normalizeBleDevice(value: unknown): HardwareBleDevice {
  const source = object(value, 'BLE device');
  return {
    locator: string(source.locator, 'locator'),
    transport: 'ble',
    productName: typeof source.productName === 'string' ? source.productName : '',
    rssi: integer(source.rssi, 'rssi', -127),
    compatible: source.compatible === true,
  };
}

function normalizeRecording(value: unknown): PendingHardwareRecording {
  const source = object(value, 'recording');
  const checksum = string(source.checksumSha256, 'checksum');
  if (!/^sha256:[0-9a-f]{64}$/.test(checksum)) {
    throw new Error('native hardware checksum is invalid');
  }
  return {
    recordingId: string(source.recordingId, 'recordingId'),
    deviceId: string(source.deviceId, 'deviceId'),
    sessionId: string(source.sessionId, 'sessionId'),
    localUri: string(source.localUri, 'localUri'),
    recordedAtMs: integer(source.recordedAtMs, 'recordedAtMs'),
    durationMs: integer(source.durationMs, 'durationMs'),
    byteSize: integer(source.byteSize, 'byteSize'),
    checksumSha256: checksum,
    interrupted: source.interrupted === true,
    sampleRateHz: integer(source.sampleRateHz, 'sampleRateHz', 1),
    bitsPerSample: integer(source.bitsPerSample, 'bitsPerSample', 1),
    channels: integer(source.channels, 'channels', 1),
    sourceDeviceRecordingId: nullableString(source.sourceDeviceRecordingId),
    sourceGeneration: nullableString(source.sourceGeneration),
    title: nullableString(source.title),
  };
}

function normalizeDeviceRecording(value: unknown): HardwareDeviceRecording {
  const source = object(value, 'device recording');
  const checksum = string(source.checksumSha256, 'checksum').toLowerCase();
  if (!/^sha256:[0-9a-f]{64}$/.test(checksum)) {
    throw new Error('native hardware checksum is invalid');
  }
  const checksumScope = string(source.checksumScope, 'checksumScope');
  if (!['whole_file', 'audio_payload'].includes(checksumScope)) {
    throw new Error('native hardware checksum scope is invalid');
  }
  return {
    recordingId: string(source.recordingId, 'recordingId'),
    generation: string(source.generation, 'generation'),
    title: nullableString(source.title),
    byteSize: integer(source.byteSize, 'byteSize', 45),
    durationMs: integer(source.durationMs, 'durationMs'),
    checksumSha256: checksum,
    checksumScope: checksumScope as HardwareDeviceRecording['checksumScope'],
    createdEpochMs: nullableInteger(source.createdEpochMs),
    acknowledged: source.acknowledged === true,
    recovered: source.recovered === true,
  };
}

function normalizeLevel(value: unknown): HardwareLevelEvent {
  const source = object(value, 'level');
  return {
    sessionId: string(source.sessionId, 'sessionId'),
    peak: finite(source.peak, 'peak'),
    rms: finite(source.rms, 'rms'),
    normalized: finite(source.normalized, 'normalized'),
  };
}

function requireHardware(): LaojiHardwareNativeModule {
  if (!nativeModule) throw new Error('当前设备不支持外接录音设备。');
  return nativeModule;
}

export function hasNativeHardwareSupport(): boolean {
  return nativeModule !== null;
}

export async function getHardwareState(): Promise<HardwareConnectionState> {
  return normalizeState(await requireHardware().getState());
}

export async function listHardwareUsbDevices(): Promise<HardwareUsbDevice[]> {
  const value = await requireHardware().listDevices();
  if (!Array.isArray(value)) throw new Error('native hardware device list is invalid');
  return value.map(normalizeUsbDevice);
}

export async function scanHardwareBleDevices(): Promise<HardwareBleDevice[]> {
  const value = await requireHardware().scanBleDevices();
  if (!Array.isArray(value)) throw new Error('native hardware BLE device list is invalid');
  return value.map(normalizeBleDevice);
}

export async function requestHardwareUsbPermission(locator: string): Promise<boolean> {
  return requireHardware().requestUsbPermission(string(locator, 'locator'));
}

export async function connectHardwareUsb(locator: string): Promise<HardwareConnectionState> {
  return normalizeState(await requireHardware().connectUsb(string(locator, 'locator')));
}

export async function connectHardwareBle(locator: string): Promise<HardwareConnectionState> {
  return normalizeState(await requireHardware().connectBle(string(locator, 'locator')));
}

export async function disconnectHardware(): Promise<HardwareConnectionState> {
  return normalizeState(await requireHardware().disconnect());
}

export async function startHardwareCapture(): Promise<HardwareConnectionState> {
  return normalizeState(await requireHardware().startCapture());
}

export async function stopHardwareCapture(): Promise<PendingHardwareRecording | null> {
  const value = await requireHardware().stopCapture();
  return value == null ? null : normalizeRecording(value);
}

export async function pauseHardwareCapture(): Promise<HardwareConnectionState> {
  return normalizeState(await requireHardware().pauseCapture());
}

export async function resumeHardwareCapture(): Promise<HardwareConnectionState> {
  return normalizeState(await requireHardware().resumeCapture());
}

export async function listHardwareDeviceRecordings(): Promise<HardwareDeviceRecording[]> {
  const value = await requireHardware().listDeviceRecordings();
  if (!Array.isArray(value)) throw new Error('native hardware device recording list is invalid');
  return value.map(normalizeDeviceRecording);
}

export async function renameHardwareDeviceRecording(
  recordingId: string,
  generation: string,
  title: string,
): Promise<HardwareDeviceRecording> {
  return normalizeDeviceRecording(await requireHardware().renameDeviceRecording(
    string(recordingId, 'recordingId'),
    string(generation, 'generation'),
    title.trim().slice(0, 120),
  ));
}

export async function deleteHardwareDeviceRecording(
  recordingId: string,
  generation: string,
): Promise<boolean> {
  return requireHardware().deleteDeviceRecording(
    string(recordingId, 'recordingId'),
    string(generation, 'generation'),
  );
}

export async function receiveHardwareDeviceRecording(
  recordingId: string,
  generation: string,
): Promise<PendingHardwareRecording> {
  return normalizeRecording(await requireHardware().receiveDeviceRecording(
    string(recordingId, 'recordingId'),
    string(generation, 'generation'),
  ));
}

export async function listPendingHardwareRecordings(): Promise<PendingHardwareRecording[]> {
  const value = await requireHardware().listPendingRecordings();
  if (!Array.isArray(value)) throw new Error('native hardware recording list is invalid');
  return value.map(normalizeRecording);
}

export async function acknowledgeHardwareRecording(recordingId: string): Promise<boolean> {
  return requireHardware().acknowledgeRecording(string(recordingId, 'recordingId'));
}

export function addHardwareStateListener(
  listener: (state: HardwareConnectionState) => void,
): EventSubscription {
  if (!nativeModule) return { remove() {} };
  return nativeModule.addListener('onHardwareStateChanged', value => listener(normalizeState(value)));
}

export function addHardwareRecordingListener(
  listener: (recording: PendingHardwareRecording) => void,
): EventSubscription {
  if (!nativeModule) return { remove() {} };
  return nativeModule.addListener('onHardwareRecordingReady', value => listener(normalizeRecording(value)));
}

export function addHardwareLevelListener(
  listener: (level: HardwareLevelEvent) => void,
): EventSubscription {
  if (!nativeModule) return { remove() {} };
  return nativeModule.addListener('onHardwareLevel', value => listener(normalizeLevel(value)));
}
