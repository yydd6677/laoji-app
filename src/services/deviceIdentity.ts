import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

const DEVICE_ID_KEY = 'laoji.device.v1.id';
const DEVICE_SECRET_KEY = 'laoji.device.v1.secret';
const DATA_EPOCH_KEY = 'laoji.device.v1.epoch';

export interface DeviceIdentity {
  deviceId: string;
  deviceSecret: string;
  epochId: string;
}

function uuid(): string {
  const value = Crypto.randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('本机标识生成失败');
  }
  return value.toLowerCase();
}

async function secret(): Promise<string> {
  const bytes = await Crypto.getRandomBytesAsync(32);
  const raw = String.fromCharCode(...bytes);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function readStored(): Promise<DeviceIdentity | null> {
  const [deviceId, deviceSecret, epochId] = await Promise.all([
    SecureStore.getItemAsync(DEVICE_ID_KEY),
    SecureStore.getItemAsync(DEVICE_SECRET_KEY),
    SecureStore.getItemAsync(DATA_EPOCH_KEY),
  ]);
  if (!deviceId || !deviceSecret || !epochId) return null;
  return { deviceId, deviceSecret, epochId };
}

export async function getOrCreateDeviceIdentity(): Promise<DeviceIdentity> {
  const current = await readStored();
  if (current) return current;
  const next: DeviceIdentity = {
    deviceId: uuid(),
    deviceSecret: await secret(),
    epochId: uuid(),
  };
  await Promise.all([
    SecureStore.setItemAsync(DEVICE_ID_KEY, next.deviceId),
    SecureStore.setItemAsync(DEVICE_SECRET_KEY, next.deviceSecret),
    SecureStore.setItemAsync(DATA_EPOCH_KEY, next.epochId),
  ]);
  return next;
}

export async function replaceDataEpoch(epochId = uuid()): Promise<DeviceIdentity> {
  const current = await getOrCreateDeviceIdentity();
  if (!/^[0-9a-f-]{36}$/i.test(epochId)) throw new Error('本机数据域无效');
  const next = { ...current, epochId: epochId.toLowerCase() };
  await SecureStore.setItemAsync(DATA_EPOCH_KEY, next.epochId);
  return next;
}

export async function clearDeviceIdentity(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(DEVICE_ID_KEY),
    SecureStore.deleteItemAsync(DEVICE_SECRET_KEY),
    SecureStore.deleteItemAsync(DATA_EPOCH_KEY),
  ]);
}

/** Backward-compatible test alias; production cleanup uses the explicit name. */
export const clearDeviceIdentityForTests = clearDeviceIdentity;

export const deviceIdentityStorageKeys = {
  deviceId: DEVICE_ID_KEY,
  deviceSecret: DEVICE_SECRET_KEY,
  epochId: DATA_EPOCH_KEY,
} as const;
