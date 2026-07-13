import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { AccountScreen } from '../src/screens/AccountScreen';
import { useAuth } from '../src/store/AuthStore';

const showDialog = jest.fn();

jest.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('../src/components/Common', () => ({
  BackHeader: 'BackHeader',
}));
jest.mock('../src/components/BottomTabBar', () => ({
  BottomTabBar: 'BottomTabBar',
  BOTTOM_TAB_BAR_GEOMETRY: { scrollContentClearance: 100 },
}));
jest.mock('../src/store/AuthStore', () => ({ useAuth: jest.fn() }));
jest.mock('../src/components/AppDialog', () => ({
  useAppDialog: () => ({ showDialog }),
}));
jest.mock('../src/services/notifications', () => ({
  REMINDER_OPTIONS: [{ value: 15, label: '提前15分钟' }],
  ensureNotificationPermission: jest.fn(async () => true),
  getNotificationPermissionStatus: jest.fn(async () => 'granted'),
  labelForReminder: jest.fn(() => '提前15分钟'),
  loadNotificationPrefs: jest.fn(async () => ({ defaultReminderMinutes: 15 })),
  saveNotificationPrefs: jest.fn(async () => undefined),
}));

describe('AccountScreen account deletion', () => {
  const deleteAccount = jest.fn();
  const navigation = {
    goBack: jest.fn(),
    navigate: jest.fn(),
    reset: jest.fn(),
  } as unknown as React.ComponentProps<typeof AccountScreen>['navigation'];

  beforeEach(() => {
    jest.clearAllMocks();
    deleteAccount.mockResolvedValue({
      deleted: true,
      events_deleted: 1,
      meetings_deleted: 2,
      sessions_deleted: 1,
      cleanup_pending: 0,
    });
    (useAuth as jest.Mock).mockReturnValue({
      profile: {
        nickname: '测试用户',
        email: 'user@example.com',
        phone: '',
        avatarUrl: null,
        avatarLocalUri: null,
      },
      isGuest: false,
      mode: 'authenticated',
      session: { user: { id: 7 } },
      accessToken: 'token-7',
      updateProfile: jest.fn(),
      uploadAvatar: jest.fn(),
      deleteAvatar: jest.fn(),
      signOut: jest.fn(),
      deleteAccount,
    });
  });

  it('requires password and the exact destructive confirmation before deletion', async () => {
    const view = await render(<AccountScreen navigation={navigation} />);

    expect(view.queryByTestId('account-avatar-picker')).toBeNull();
    expect(view.queryByTestId('account-nickname-input')).toBeNull();
    expect(view.queryByTestId('account-email-input')).toBeNull();
    expect(view.queryByTestId('account-phone-input')).toBeNull();

    await fireEvent.press(view.getByTestId('open-account-deletion'));
    expect(view.getByText('此操作不可撤销')).toBeTruthy();
    expect(view.getByTestId('confirm-account-deletion').props.disabled).toBe(true);

    await fireEvent.changeText(view.getByTestId('account-deletion-password'), 'Password123');
    await fireEvent.changeText(view.getByTestId('account-deletion-confirmation'), '删除账号');
    expect(view.getByTestId('confirm-account-deletion').props.disabled).toBe(false);
    await fireEvent.press(view.getByTestId('confirm-account-deletion'));

    await waitFor(() => {
      expect(deleteAccount).toHaveBeenCalledWith('Password123', '删除账号');
      expect(navigation.reset).toHaveBeenCalledWith({ index: 0, routes: [{ name: 'Login' }] });
    });
    expect(showDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: '账号已删除',
      tone: 'success',
    }));
  });

  it('does not expose cloud account deletion in guest mode', async () => {
    (useAuth as jest.Mock).mockReturnValue({
      profile: { nickname: '访客', email: '', phone: '', avatarUrl: null, avatarLocalUri: null },
      isGuest: true,
      mode: 'guest',
      session: null,
      accessToken: null,
      updateProfile: jest.fn(),
      uploadAvatar: jest.fn(),
      deleteAvatar: jest.fn(),
      signOut: jest.fn(),
      deleteAccount,
    });
    const view = await render(<AccountScreen navigation={navigation} />);
    expect(view.queryByTestId('open-account-deletion')).toBeNull();
  });

  it('opens the destructive confirmation directly from a deletion deep link', async () => {
    const route = {
      key: 'account-deletion-route',
      name: 'Account' as const,
      params: { section: 'deletion' as const },
    };
    const view = await render(<AccountScreen navigation={navigation} route={route} />);

    expect(view.getByText('此操作不可撤销')).toBeTruthy();
    expect(view.getByTestId('account-deletion-password')).toBeTruthy();
  });

  it('warns honestly when cloud deletion succeeds but local cleanup is partial', async () => {
    deleteAccount.mockResolvedValueOnce({
      deleted: true,
      events_deleted: 1,
      meetings_deleted: 2,
      sessions_deleted: 1,
      cleanup_pending: 0,
      local_cleanup_failed: 2,
    });
    const view = await render(<AccountScreen navigation={navigation} />);

    await fireEvent.press(view.getByTestId('open-account-deletion'));
    await fireEvent.changeText(view.getByTestId('account-deletion-password'), 'Password123');
    await fireEvent.changeText(view.getByTestId('account-deletion-confirmation'), '删除账号');
    await fireEvent.press(view.getByTestId('confirm-account-deletion'));

    await waitFor(() => expect(showDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: '账号已删除',
      tone: 'warning',
      message: expect.stringContaining('2 项本机清理失败'),
    })));
  });

  it('keeps profile editing out of the account security page', async () => {
    const view = await render(<AccountScreen navigation={navigation} />);

    expect(view.queryByText('头像')).toBeNull();
    expect(view.queryByText('昵称')).toBeNull();
    expect(view.queryByText('邮箱')).toBeNull();
    expect(view.queryByText('手机号')).toBeNull();
    expect(view.getByText('密码与安全')).toBeTruthy();
    expect(view.getAllByText('通知与提醒').length).toBeGreaterThan(0);
  });
});
