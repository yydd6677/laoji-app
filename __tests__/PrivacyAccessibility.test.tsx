import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { PrivacyScreen } from '../src/screens/PrivacyScreen';
import { useAuth } from '../src/store/AuthStore';
import { loadPrivacyPrefs } from '../src/services/privacy';

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('../src/components/ScreenContainer', () => ({ ScreenContainer: 'ScreenContainer' }));
jest.mock('../src/components/Common', () => ({ BackHeader: 'BackHeader' }));
jest.mock('../src/components/BottomTabBar', () => ({
  BottomTabBar: 'BottomTabBar',
  BOTTOM_TAB_BAR_GEOMETRY: { scrollContentClearance: 160 },
}));
jest.mock('../src/navigation/tabTargets', () => ({
  openMeetingsTab: jest.fn(),
  openScheduleTab: jest.fn(),
}));
jest.mock('../src/store/AuthStore', () => ({ useAuth: jest.fn() }));
jest.mock('../src/components/AppDialog', () => ({
  useAppDialog: () => ({ showDialog: jest.fn() }),
}));
jest.mock('../src/services/privacy', () => ({
  authenticateWithSystem: jest.fn(),
  getBiometricUnavailableReason: jest.fn(),
  loadPrivacyPrefs: jest.fn(),
  savePrivacyPrefs: jest.fn(),
}));

describe('PrivacyScreen accessibility [UI-TOKENS-001/UI-MOTION-001]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useAuth as jest.Mock).mockReturnValue({
      mode: 'guest',
      session: null,
      signOut: jest.fn(),
    });
    (loadPrivacyPrefs as jest.Mock).mockResolvedValue({
      biometricEnabled: false,
      appLockEnabled: false,
    });
  });

  it('names both privacy toggles and exposes their switch state', async () => {
    const navigation = {
      goBack: jest.fn(),
      navigate: jest.fn(),
      reset: jest.fn(),
    } as unknown as React.ComponentProps<typeof PrivacyScreen>['navigation'];

    await render(<PrivacyScreen navigation={navigation} />);

    await waitFor(() => expect(loadPrivacyPrefs).toHaveBeenCalledWith('guest'));
    const systemVerification = screen.getByLabelText('系统验证');
    const startupVerification = screen.getByLabelText('启动时验证');

    expect(systemVerification.props.accessibilityRole).toBe('switch');
    expect(systemVerification.props.accessibilityState).toEqual({ checked: false, disabled: false });
    expect(systemVerification.props.accessibilityHint).toBe('双击以开启系统验证');
    expect(StyleSheet.flatten(systemVerification.props.style)).toEqual(expect.objectContaining({
      width: 36,
      height: 20,
    }));
    expect(StyleSheet.flatten(screen.getByTestId('privacy-system-verification-toggle-track').props.style))
      .toEqual(expect.objectContaining({ height: 14, top: 3 }));
    expect(startupVerification.props.accessibilityRole).toBe('switch');
    expect(startupVerification.props.accessibilityState).toEqual({ checked: false, disabled: false });
    expect(startupVerification.props.accessibilityHint).toBe('双击以开启启动时验证');
  });

  it('uses one account and security entry instead of duplicating deletion', async () => {
    (useAuth as jest.Mock).mockReturnValue({
      mode: 'authenticated',
      session: { user: { id: 'user-1' } },
      signOut: jest.fn(),
    });
    const navigation = {
      goBack: jest.fn(),
      navigate: jest.fn(),
      reset: jest.fn(),
    } as unknown as React.ComponentProps<typeof PrivacyScreen>['navigation'];

    await render(<PrivacyScreen navigation={navigation} />);
    fireEvent.press(screen.getByText('账号与安全'));

    expect(navigation.navigate).toHaveBeenCalledWith('Account');
    expect(screen.queryByText('账号与数据删除')).toBeNull();
    expect(StyleSheet.flatten(screen.getByTestId('privacy-settings-group').props.style))
      .toEqual(expect.objectContaining({ marginHorizontal: 0, marginTop: 12, borderRadius: 0 }));
    expect(screen.queryByText('密码、通知、退出与账号删除')).toBeNull();
    expect(screen.queryByText('账号数据按用户隔离，访客数据仅保存在本机')).toBeNull();
  });
});
