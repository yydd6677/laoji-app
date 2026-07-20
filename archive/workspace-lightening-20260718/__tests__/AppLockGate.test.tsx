import React, { useEffect } from 'react';
import { AppState, StyleSheet, Text } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { AppLockGate } from '../src/components/AppLockGate';
import { useAuth } from '../src/store/AuthStore';
import {
  authenticateWithSystem,
  loadPrivacyPrefs,
  savePrivacyPrefs,
  subscribePrivacyPrefs,
} from '../src/services/privacy';
import { setNotificationNavigationUnlocked } from '../src/navigation/notificationNavigation';

jest.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('../src/components/Common', () => ({ Avatar: 'Avatar', Sparkle: 'Sparkle' }));
jest.mock('../src/store/AuthStore', () => ({ useAuth: jest.fn() }));
jest.mock('../src/navigation/notificationNavigation', () => ({
  setNotificationNavigationUnlocked: jest.fn(),
}));
jest.mock('../src/services/privacy', () => ({
  authenticateWithSystem: jest.fn(),
  DEFAULT_PRIVACY_PREFS: { biometricEnabled: false, appLockEnabled: false },
  loadPrivacyPrefs: jest.fn(),
  savePrivacyPrefs: jest.fn(),
  subscribePrivacyPrefs: jest.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

const unlockedPrefs = { biometricEnabled: false, appLockEnabled: false };

describe('AppLockGate', () => {
  let authState: {
    mode: string;
    session: { user: { id: number } } | null;
    profile?: { nickname: string };
  };
  let privacyListener: ((prefs: typeof unlockedPrefs) => void) | null;
  let appStateListener: ((state: string) => void) | null;

  beforeEach(() => {
    jest.clearAllMocks();
    authState = { mode: 'guest', session: null, profile: { nickname: '访客用户' } };
    privacyListener = null;
    appStateListener = null;
    (useAuth as jest.Mock).mockImplementation(() => authState);
    (subscribePrivacyPrefs as jest.Mock).mockImplementation((_scope, listener) => {
      privacyListener = listener;
      return jest.fn();
    });
    (AppState.addEventListener as jest.Mock).mockImplementation((_event, listener) => {
      appStateListener = listener;
      return { remove: jest.fn() };
    });
  });

  it('never renders protected content while the scoped preference is unresolved', async () => {
    const loading = deferred<typeof unlockedPrefs>();
    (loadPrivacyPrefs as jest.Mock).mockReturnValueOnce(loading.promise);
    const view = await render(<AppLockGate><Text testID="private-content">私密日程</Text></AppLockGate>);

    expect(view.getByTestId('app-lock-loading')).toBeTruthy();
    expect(view.queryByTestId('private-content')).toBeNull();

    await act(async () => { loading.resolve(unlockedPrefs); });
    await waitFor(() => expect(view.getByTestId('private-content')).toBeTruthy());
  });

  it('uses a live setting update when the app next returns from background', async () => {
    (loadPrivacyPrefs as jest.Mock).mockResolvedValueOnce(unlockedPrefs);
    const authentication = deferred<boolean>();
    (authenticateWithSystem as jest.Mock).mockReturnValue(authentication.promise);
    const mounted = jest.fn();
    const unmounted = jest.fn();
    function ProtectedContent() {
      useEffect(() => {
        mounted();
        return unmounted;
      }, []);
      return <Text testID="private-content">私密日程</Text>;
    }
    const view = await render(<AppLockGate><ProtectedContent /></AppLockGate>);
    await waitFor(() => expect(view.getByTestId('private-content')).toBeTruthy());
    await waitFor(() => expect(privacyListener).not.toBeNull());

    await act(async () => {
      privacyListener?.({ biometricEnabled: true, appLockEnabled: true });
    });
    await act(async () => {
      appStateListener?.('background');
    });

    expect(view.getByText('老记已锁定，请使用系统生物识别或设备密码验证身份')).toBeTruthy();
    expect(StyleSheet.flatten(view.getByTestId('app-lock-screen').props.style).paddingTop).toBe(20);
    expect(StyleSheet.flatten(view.getByTestId('app-lock-avatar').props.style)).toEqual(expect.objectContaining({
      width: 80,
      height: 80,
    }));
    expect(StyleSheet.flatten(view.getByTestId('app-lock-user-name').props.style)).toEqual(expect.objectContaining({
      height: 32,
      marginTop: 8,
      fontSize: 24,
    }));
    expect(StyleSheet.flatten(view.getByTestId('app-lock-hint').props.style)).toEqual(expect.objectContaining({
      minHeight: 52,
      marginTop: 20,
      fontSize: 17,
    }));
    expect(StyleSheet.flatten(view.getByTestId('app-lock-status-slot').props.style).height).toBe(52);
    expect(view.queryByText('验证并解锁')).toBeNull();
    expect(view.getByTestId('private-content', { includeHiddenElements: true })).toBeTruthy();
    expect(view.getByTestId('app-lock-protected-content', { includeHiddenElements: true }).props.accessibilityElementsHidden).toBe(true);
    expect(setNotificationNavigationUnlocked).toHaveBeenLastCalledWith(false);
    expect(authenticateWithSystem).not.toHaveBeenCalled();
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(unmounted).not.toHaveBeenCalled();

    await act(async () => {
      appStateListener?.('active');
    });

    await waitFor(() => expect(authenticateWithSystem).toHaveBeenCalledWith('解锁老记'));
    expect(view.getByTestId('private-content', { includeHiddenElements: true })).toBeTruthy();
    expect(view.getByText('老记已锁定，请使用系统生物识别或设备密码验证身份')).toBeTruthy();
    expect(unmounted).not.toHaveBeenCalled();

    await act(async () => { authentication.resolve(true); });
    await waitFor(() => expect(setNotificationNavigationUnlocked).toHaveBeenLastCalledWith(true));
  });

  it('blocks the previous account content immediately while a new scope loads', async () => {
    const userPrefs = deferred<typeof unlockedPrefs>();
    (loadPrivacyPrefs as jest.Mock).mockImplementation((scope: string) => (
      scope === 'guest' ? Promise.resolve(unlockedPrefs) : userPrefs.promise
    ));
    const view = await render(<AppLockGate><Text testID="private-content">私密日程</Text></AppLockGate>);
    await waitFor(() => expect(loadPrivacyPrefs).toHaveBeenCalledWith('guest'));
    await waitFor(() => expect(view.getByTestId('private-content')).toBeTruthy());

    authState = { mode: 'authenticated', session: { user: { id: 7 } }, profile: { nickname: '测试用户' } };
    await view.rerender(<AppLockGate><Text testID="private-content">私密日程</Text></AppLockGate>);

    expect(view.getByTestId('app-lock-loading')).toBeTruthy();
    expect(view.queryByTestId('private-content')).toBeNull();
    await act(async () => { userPrefs.resolve(unlockedPrefs); });
    await waitFor(() => expect(view.getByTestId('private-content')).toBeTruthy());
  });

  it('fails closed on a storage read error and exposes only an explicit retry', async () => {
    (loadPrivacyPrefs as jest.Mock)
      .mockRejectedValueOnce(new Error('storage unavailable'))
      .mockResolvedValueOnce(unlockedPrefs);
    const view = await render(<AppLockGate><Text testID="private-content">私密日程</Text></AppLockGate>);

    await waitFor(() => expect(view.getByText('暂时无法读取隐私设置')).toBeTruthy());
    expect(view.queryByTestId('private-content')).toBeNull();

    await fireEvent.press(view.getByText('重试读取'));
    await waitFor(() => expect(loadPrivacyPrefs).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(view.getByTestId('private-content')).toBeTruthy());
  });

  it('requires system authentication before resetting an unreadable preference', async () => {
    (loadPrivacyPrefs as jest.Mock).mockRejectedValue(new Error('corrupted'));
    (authenticateWithSystem as jest.Mock).mockResolvedValueOnce(true);
    (savePrivacyPrefs as jest.Mock).mockResolvedValueOnce(undefined);
    const view = await render(<AppLockGate><Text testID="private-content">私密日程</Text></AppLockGate>);
    await waitFor(() => expect(view.getByText('暂时无法读取隐私设置')).toBeTruthy());

    await fireEvent.press(view.getByText('验证身份并重置设置'));

    await waitFor(() => expect(authenticateWithSystem).toHaveBeenCalledWith('恢复老记隐私设置'));
    expect(savePrivacyPrefs).toHaveBeenCalledWith('guest', {
      biometricEnabled: false,
      appLockEnabled: false,
    });
    await waitFor(() => expect(view.getByTestId('private-content')).toBeTruthy());
  });
});
