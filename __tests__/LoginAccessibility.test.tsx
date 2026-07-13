import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { LoginScreen } from '../src/screens/LoginScreen';
import { useAuth } from '../src/store/AuthStore';

const showDialog = jest.fn();

jest.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('../src/components/ScreenContainer', () => ({ ScreenContainer: 'ScreenContainer' }));
jest.mock('../src/components/Common', () => ({ Sparkle: 'Sparkle' }));
jest.mock('../src/store/AuthStore', () => ({ useAuth: jest.fn() }));
jest.mock('../src/components/AppDialog', () => ({
  useAppDialog: () => ({ showDialog }),
}));
jest.mock('../src/services/auth', () => ({ requestPasswordReset: jest.fn() }));

describe('LoginScreen accessibility', () => {
  beforeEach(() => {
    showDialog.mockClear();
    (useAuth as jest.Mock).mockReturnValue({
      signIn: jest.fn(),
      register: jest.fn(),
      continueAsGuest: jest.fn(),
      sessionNotice: null,
      clearSessionNotice: jest.fn(),
    });
  });

  it('announces the current password visibility action', async () => {
    const navigation = { navigate: jest.fn() } as unknown as React.ComponentProps<typeof LoginScreen>['navigation'];
    await render(<LoginScreen navigation={navigation} />);

    const show = screen.getByLabelText('显示密码');
    await fireEvent.press(show);
    expect(screen.getByLabelText('隐藏密码')).toBeTruthy();
  });

  it('shows the custom re-login dialog once after session invalidation', async () => {
    const clearSessionNotice = jest.fn();
    (useAuth as jest.Mock).mockReturnValue({
      signIn: jest.fn(),
      register: jest.fn(),
      continueAsGuest: jest.fn(),
      sessionNotice: '登录状态已失效，为保护账号数据，请重新登录。',
      clearSessionNotice,
    });
    const navigation = { navigate: jest.fn() } as unknown as React.ComponentProps<typeof LoginScreen>['navigation'];

    await render(<LoginScreen navigation={navigation} />);

    expect(clearSessionNotice).toHaveBeenCalledTimes(1);
    expect(showDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: '请重新登录',
      tone: 'warning',
    }));
  });
});
