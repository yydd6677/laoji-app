import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  getBiometricUnavailableReason,
  loadPrivacyPrefs,
  privacyKeyForScope,
  savePrivacyPrefs,
  subscribePrivacyPrefs,
} from '../src/services/privacy';
import { resetAppStorageQueueForTests } from '../src/services/appStorage';
import * as LocalAuthentication from 'expo-local-authentication';

jest.mock('expo-local-authentication', () => ({
  hasHardwareAsync: jest.fn(),
  isEnrolledAsync: jest.fn(),
  getEnrolledLevelAsync: jest.fn(),
  authenticateAsync: jest.fn(),
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
}));

describe('privacy preferences', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetAppStorageQueueForTests();
  });

  it('publishes a scoped update only after durable storage succeeds', async () => {
    const guestListener = jest.fn();
    const userListener = jest.fn();
    const unsubscribeGuest = subscribePrivacyPrefs('guest', guestListener);
    const unsubscribeUser = subscribePrivacyPrefs('user:7', userListener);

    await savePrivacyPrefs('guest', { biometricEnabled: true, appLockEnabled: true });

    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      privacyKeyForScope('guest'),
      JSON.stringify({ biometricEnabled: true, appLockEnabled: true }),
    );
    expect(guestListener).toHaveBeenCalledWith({ biometricEnabled: true, appLockEnabled: true });
    expect(userListener).not.toHaveBeenCalled();
    unsubscribeGuest();
    unsubscribeUser();
  });

  it('does not announce a setting that failed to persist', async () => {
    const listener = jest.fn();
    const unsubscribe = subscribePrivacyPrefs('guest', listener);
    (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('storage full'));

    await expect(savePrivacyPrefs('guest', { biometricEnabled: true, appLockEnabled: true }))
      .rejects.toThrow('storage full');
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('loads legacy preference names without enabling unrelated flags', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify({ faceId: true, appLock: false }));
    await expect(loadPrivacyPrefs('guest')).resolves.toEqual({
      biometricEnabled: true,
      appLockEnabled: false,
    });
  });

  it('does not silently disable protection when stored preferences are corrupted', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('{not-json');
    await expect(loadPrivacyPrefs('guest')).rejects.toThrow('privacy preferences are corrupted');
  });

  it('accepts a device PIN or pattern even when no biometric is enrolled', async () => {
    (LocalAuthentication.getEnrolledLevelAsync as jest.Mock).mockResolvedValueOnce(
      LocalAuthentication.SecurityLevel.SECRET,
    );
    await expect(getBiometricUnavailableReason()).resolves.toBeNull();
  });

  it('requires at least a system credential and reports native lookup failures', async () => {
    (LocalAuthentication.getEnrolledLevelAsync as jest.Mock)
      .mockResolvedValueOnce(LocalAuthentication.SecurityLevel.NONE)
      .mockRejectedValueOnce(new Error('native unavailable'));
    await expect(getBiometricUnavailableReason()).resolves.toContain('设备密码');
    await expect(getBiometricUnavailableReason()).resolves.toContain('无法读取');
  });
});
