import { requireOptionalNativeModule } from 'expo-modules-core';

export interface DeviceKeyInfo {
  keyVersion: number;
  publicKeyDer: string;
}

interface DeviceAuthNativeModule {
  getOrCreateKey(keyVersion: number): Promise<DeviceKeyInfo>;
  sign(keyVersion: number, payloadBase64: string): string;
  findProofOfWork(nonceBase64: string, difficultyBits: number): Promise<number>;
  rotateKey(nextKeyVersion: number): Promise<DeviceKeyInfo>;
  deleteKey(keyVersion: number): void;
  hasKey(keyVersion: number): boolean;
}

const nativeModule = requireOptionalNativeModule<DeviceAuthNativeModule>('LaojiDeviceAuth');

function requireModule(): DeviceAuthNativeModule {
  if (!nativeModule) throw new Error('当前平台不支持设备密钥服务。');
  return nativeModule;
}

function validVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new Error('设备密钥版本无效。');
  return value;
}

export function hasDeviceKey(keyVersion: number): boolean {
  return Boolean(nativeModule?.hasKey(validVersion(keyVersion)));
}

export function getOrCreateDeviceKey(keyVersion: number): Promise<DeviceKeyInfo> {
  return requireModule().getOrCreateKey(validVersion(keyVersion));
}

export function signWithDeviceKey(keyVersion: number, payloadBase64: string): string {
  const payload = payloadBase64.trim();
  if (!payload) throw new Error('设备签名输入为空。');
  return requireModule().sign(validVersion(keyVersion), payload);
}

export function findDeviceProofOfWork(nonceBase64: string, difficultyBits: number): Promise<number> {
  if (!Number.isSafeInteger(difficultyBits) || difficultyBits < 1 || difficultyBits > 24) {
    throw new Error('设备注册难度无效。');
  }
  return requireModule().findProofOfWork(nonceBase64.trim(), difficultyBits);
}

export function rotateDeviceKey(nextKeyVersion: number): Promise<DeviceKeyInfo> {
  return requireModule().rotateKey(validVersion(nextKeyVersion));
}

export function deleteDeviceKey(keyVersion: number): void {
  if (!nativeModule) return;
  nativeModule.deleteKey(validVersion(keyVersion));
}
