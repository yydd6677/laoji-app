import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { LoginScreen } from '../src/screens/LoginScreen';
import { useAuth } from '../src/store/AuthStore';

const showDialog = jest.fn();
const signIn = jest.fn();
const register = jest.fn();
const continueAsGuest = jest.fn();

jest.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('../src/components/ScreenContainer', () => ({ ScreenContainer: 'ScreenContainer' }));
jest.mock('../src/components/Common', () => ({ Sparkle: 'Sparkle' }));
jest.mock('../src/store/AuthStore', () => ({ useAuth: jest.fn() }));
jest.mock('../src/components/AppDialog', () => ({
  useAppDialog: () => ({ showDialog }),
}));
jest.mock('../src/services/auth', () => ({ requestPasswordReset: jest.fn() }));

describe('LoginScreen accessibility [UI-SHELL-001/UI-FORM-001]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    signIn.mockResolvedValue(undefined);
    register.mockResolvedValue(undefined);
    continueAsGuest.mockResolvedValue(undefined);
    (useAuth as jest.Mock).mockReturnValue({
      signIn,
      register,
      continueAsGuest,
      sessionNotice: null,
      clearSessionNotice: jest.fn(),
    });
  });

  it('uses the source shell and stable account geometry before entering the password step', async () => {
    const navigation = { navigate: jest.fn() } as unknown as React.ComponentProps<typeof LoginScreen>['navigation'];
    await render(<LoginScreen navigation={navigation} />);

    expect(StyleSheet.flatten(screen.getByTestId('login-logo').props.style))
      .toEqual(expect.objectContaining({ width: 56, height: 56, borderRadius: 10 }));
    expect(StyleSheet.flatten(screen.getByTestId('login-titlebar').props.style))
      .toEqual(expect.objectContaining({ height: 44 }));
    expect(StyleSheet.flatten(screen.getByTestId('login-next').props.style))
      .toEqual(expect.objectContaining({ height: 48, borderRadius: 6, marginTop: 16 }));
    expect(screen.queryByTestId('login-password-input')).toBeNull();

    expect(screen.getByLabelText('同意用户协议和隐私政策').props.accessibilityState)
      .toEqual({ checked: false });
    await fireEvent.press(screen.getByTestId('login-terms-checkbox'));
    await fireEvent.changeText(screen.getByTestId('login-account-input'), 'user@example.com');
    await fireEvent.press(screen.getByTestId('login-next'));

    await waitFor(() => expect(screen.getByTestId('login-password-step')).toBeTruthy());
    const show = screen.getByLabelText('显示密码');
    await fireEvent.press(show);
    expect(screen.getByLabelText('隐藏密码')).toBeTruthy();
  });

  it('submits login credentials only from the password step', async () => {
    const navigation = { navigate: jest.fn() } as unknown as React.ComponentProps<typeof LoginScreen>['navigation'];
    await render(<LoginScreen navigation={navigation} />);

    await fireEvent.press(screen.getByTestId('login-terms-checkbox'));
    await fireEvent.changeText(screen.getByTestId('login-account-input'), 'user@example.com');
    await fireEvent.press(screen.getByTestId('login-next'));
    await waitFor(() => expect(screen.getByTestId('login-password-input')).toBeTruthy());
    expect(signIn).not.toHaveBeenCalled();

    await fireEvent.changeText(screen.getByTestId('login-password-input'), 'Password123');
    await fireEvent.press(screen.getByTestId('login-primary'));

    await waitFor(() => expect(signIn).toHaveBeenCalledWith('user@example.com', 'Password123'));
  });

  it('keeps registration in the same source-aligned credential flow', async () => {
    const navigation = { navigate: jest.fn() } as unknown as React.ComponentProps<typeof LoginScreen>['navigation'];
    await render(<LoginScreen navigation={navigation} />);

    await fireEvent.press(screen.getByTestId('login-terms-checkbox'));
    await fireEvent.changeText(screen.getByTestId('login-account-input'), 'new@example.com');
    await fireEvent.press(screen.getByText('立即注册'));
    await waitFor(() => expect(screen.getByText('设置密码')).toBeTruthy());

    await fireEvent.changeText(screen.getByTestId('login-password-input'), 'Password123');
    await fireEvent.press(screen.getByTestId('login-primary'));

    await waitFor(() => expect(register).toHaveBeenCalledWith('new@example.com', 'Password123'));
    expect(signIn).not.toHaveBeenCalled();
  });

  it('blocks account and guest continuation until the legal agreement is checked', async () => {
    const navigation = { navigate: jest.fn() } as unknown as React.ComponentProps<typeof LoginScreen>['navigation'];
    await render(<LoginScreen navigation={navigation} />);

    await fireEvent.changeText(screen.getByTestId('login-account-input'), 'user@example.com');
    await fireEvent.press(screen.getByTestId('login-next'));
    expect(screen.queryByTestId('login-password-step')).toBeNull();
    expect(showDialog).toHaveBeenCalledWith(expect.objectContaining({ title: '请先阅读并同意' }));

    showDialog.mockClear();
    await fireEvent.press(screen.getByTestId('login-guest'));
    expect(continueAsGuest).not.toHaveBeenCalled();
    expect(showDialog).toHaveBeenCalledWith(expect.objectContaining({ title: '请先阅读并同意' }));
  });

  it('shows the custom re-login dialog once after session invalidation', async () => {
    const clearSessionNotice = jest.fn();
    (useAuth as jest.Mock).mockReturnValue({
      signIn,
      register,
      continueAsGuest,
      sessionNotice: '登录状态已失效，为保护账号数据，请重新登录。',
      clearSessionNotice,
    });
    const navigation = { navigate: jest.fn() } as unknown as React.ComponentProps<typeof LoginScreen>['navigation'];

    await render(<LoginScreen navigation={navigation} />);

    await waitFor(() => {
      expect(clearSessionNotice).toHaveBeenCalledTimes(1);
      expect(showDialog).toHaveBeenCalledWith(expect.objectContaining({
        title: '请重新登录',
        tone: 'warning',
      }));
    });
  });
});
