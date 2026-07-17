import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { AppState, StyleSheet } from 'react-native';
import { AccountScreen } from '../src/screens/AccountScreen';
import {
  ACCOUNT_SECURITY_GEOMETRY,
  ChangePasswordScreen,
} from '../src/screens/ChangePasswordScreen';
import { NotificationSettingsScreen } from '../src/screens/NotificationSettingsScreen';
import { AccountDeletionScreen } from '../src/screens/AccountDeletionScreen';
import { FEISHU_SAVE_GEOMETRY } from '../src/components/FeishuForm';
import { useAuth } from '../src/store/AuthStore';
import { changePassword } from '../src/services/auth';
import {
  ensureNotificationPermission,
  getNotificationPermissionStatus,
  openNotificationSettings,
  saveNotificationPrefs,
  scheduleTestNotification,
} from '../src/services/notifications';

const showDialog = jest.fn();

jest.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('../src/components/Common', () => ({ BackHeader: 'BackHeader' }));
jest.mock('../src/store/AuthStore', () => ({ useAuth: jest.fn() }));
jest.mock('../src/components/AppDialog', () => ({
  useAppDialog: () => ({ showDialog }),
}));
jest.mock('../src/services/auth', () => ({
  changePassword: jest.fn(async () => undefined),
}));
jest.mock('../src/services/notifications', () => ({
  REMINDER_OPTIONS: [
    { value: 15, label: '提前15分钟' },
    { value: 30, label: '提前30分钟' },
  ],
  ensureNotificationPermission: jest.fn(async () => true),
  getNotificationPermissionStatus: jest.fn(async () => 'granted'),
  labelForReminder: jest.fn(() => '提前15分钟'),
  loadNotificationPrefs: jest.fn(async () => ({ defaultReminderMinutes: 15 })),
  openNotificationSettings: jest.fn(async () => undefined),
  saveNotificationPrefs: jest.fn(async () => undefined),
  scheduleTestNotification: jest.fn(async () => 'test-notification-id'),
}));

describe('account security pages [UI-SHELL-001/UI-FORM-001/UI-TOKENS-001]', () => {
  const deleteAccount = jest.fn();
  const signOut = jest.fn();
  const navigation = {
    goBack: jest.fn(),
    navigate: jest.fn(),
    reset: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (changePassword as jest.Mock).mockResolvedValue(undefined);
    (ensureNotificationPermission as jest.Mock).mockResolvedValue(true);
    (getNotificationPermissionStatus as jest.Mock).mockResolvedValue('granted');
    (openNotificationSettings as jest.Mock).mockResolvedValue(undefined);
    (saveNotificationPrefs as jest.Mock).mockResolvedValue(undefined);
    (scheduleTestNotification as jest.Mock).mockResolvedValue('test-notification-id');
    deleteAccount.mockResolvedValue({
      deleted: true,
      events_deleted: 1,
      meetings_deleted: 2,
      sessions_deleted: 1,
      cleanup_pending: 0,
    });
    (useAuth as jest.Mock).mockReturnValue({
      isGuest: false,
      mode: 'authenticated',
      session: { user: { id: 7 } },
      accessToken: 'token-7',
      signOut,
      deleteAccount,
    });
  });

  it('keeps the account page as a source-style entry list with distinct destinations', async () => {
    const view = await render(
      <AccountScreen navigation={navigation as unknown as React.ComponentProps<typeof AccountScreen>['navigation']} />,
    );

    expect(view.queryByText('头像')).toBeNull();
    expect(view.queryByText('昵称')).toBeNull();
    expect(view.queryByText('邮箱')).toBeNull();
    expect(view.queryByText('手机号')).toBeNull();
    expect(StyleSheet.flatten(view.getByTestId('account-settings-group').props.style))
      .toEqual(expect.objectContaining({ marginHorizontal: 0, marginTop: 12, borderRadius: 0 }));
    expect(StyleSheet.flatten(view.getByTestId('account-setting-0').props.style).minHeight).toBe(52);

    await fireEvent.press(view.getByTestId('account-setting-0'));
    expect(navigation.navigate).toHaveBeenCalledWith('ChangePassword');
    await fireEvent.press(view.getByTestId('account-setting-1'));
    expect(navigation.navigate).toHaveBeenCalledWith('NotificationSettings');
    await fireEvent.press(view.getByTestId('open-account-deletion'));
    expect(navigation.navigate).toHaveBeenCalledWith('AccountDeletion');
    expect(view.queryByTestId('account-bottom-sheet')).toBeNull();
  });

  it('does not expose cloud account deletion in guest mode', async () => {
    (useAuth as jest.Mock).mockReturnValue({
      isGuest: true,
      mode: 'guest',
      session: null,
      accessToken: null,
      signOut,
      deleteAccount,
    });
    const view = await render(
      <AccountScreen navigation={navigation as unknown as React.ComponentProps<typeof AccountScreen>['navigation']} />,
    );
    expect(view.queryByTestId('open-account-deletion')).toBeNull();

    await fireEvent.press(view.getByTestId('account-setting-0'));
    expect(navigation.navigate).not.toHaveBeenCalledWith('ChangePassword');
    expect(showDialog).toHaveBeenCalledWith(expect.objectContaining({ title: '密码与安全' }));
  });

  it('routes the account deletion section parameter to the dedicated page', async () => {
    const route = {
      key: 'account-deletion-route',
      name: 'Account' as const,
      params: { section: 'deletion' as const },
    };
    await render(
      <AccountScreen
        navigation={navigation as unknown as React.ComponentProps<typeof AccountScreen>['navigation']}
        route={route}
      />,
    );

    await waitFor(() => expect(navigation.navigate).toHaveBeenCalledWith('AccountDeletion'));
  });

  it('changes the password from a full page without moving its fixed action area', async () => {
    const view = await render(
      <ChangePasswordScreen navigation={navigation as unknown as React.ComponentProps<typeof ChangePasswordScreen>['navigation']} />,
    );

    expect(StyleSheet.flatten(view.getByTestId('change-password-current-field').props.style).height)
      .toBe(ACCOUNT_SECURITY_GEOMETRY.inputHeight);
    expect(FEISHU_SAVE_GEOMETRY).toEqual({ width: 64, height: 44 });
    expect(StyleSheet.flatten(view.getByTestId('change-password-footer').props.style))
      .toEqual(expect.objectContaining({ width: 64, height: 44 }));

    await fireEvent.press(view.getByTestId('change-password-submit'));
    expect(view.getByTestId('change-password-validation-toast')).toBeTruthy();
    expect(view.getByText('请填写当前密码、新密码和确认密码')).toBeTruthy();

    await fireEvent.changeText(view.getByTestId('change-password-current'), 'OldPassword123');
    await fireEvent.changeText(view.getByTestId('change-password-new'), 'NewPassword123');
    await fireEvent.changeText(view.getByTestId('change-password-confirm'), 'NewPassword123');
    await fireEvent.press(view.getByTestId('change-password-submit'));

    await waitFor(() => expect(changePassword).toHaveBeenCalledWith('token-7', 'OldPassword123', 'NewPassword123'));
    expect(navigation.goBack).toHaveBeenCalledTimes(1);
    expect(showDialog).toHaveBeenCalledWith(expect.objectContaining({ title: '密码已修改' }));
  });

  it('requires password and the exact destructive confirmation on the deletion page', async () => {
    const view = await render(
      <AccountDeletionScreen navigation={navigation as unknown as React.ComponentProps<typeof AccountDeletionScreen>['navigation']} />,
    );

    expect(view.getByText('删除后无法恢复')).toBeTruthy();
    expect(view.getByLabelText('当前密码')).toBeTruthy();
    expect(view.getByLabelText('删除账号确认文字')).toBeTruthy();
    expect(view.getByTestId('confirm-account-deletion').props.disabled).toBe(true);
    expect(StyleSheet.flatten(view.getByTestId('confirm-account-deletion').props.style)).toEqual(expect.objectContaining({
      height: ACCOUNT_SECURITY_GEOMETRY.actionHeight,
      borderRadius: ACCOUNT_SECURITY_GEOMETRY.actionRadius,
    }));

    await fireEvent.changeText(view.getByTestId('account-deletion-password'), 'Password123');
    await fireEvent.changeText(view.getByTestId('account-deletion-confirmation'), '删除账号');
    expect(view.getByTestId('confirm-account-deletion').props.disabled).toBe(false);
    await fireEvent.press(view.getByTestId('confirm-account-deletion'));

    await waitFor(() => {
      expect(deleteAccount).toHaveBeenCalledWith('Password123', '删除账号');
    });
    expect(navigation.reset).not.toHaveBeenCalled();
    expect(showDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: '账号已删除',
      tone: 'success',
    }));
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
    const view = await render(
      <AccountDeletionScreen navigation={navigation as unknown as React.ComponentProps<typeof AccountDeletionScreen>['navigation']} />,
    );

    await fireEvent.changeText(view.getByTestId('account-deletion-password'), 'Password123');
    await fireEvent.changeText(view.getByTestId('account-deletion-confirmation'), '删除账号');
    await fireEvent.press(view.getByTestId('confirm-account-deletion'));

    await waitFor(() => expect(showDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: '账号已删除',
      tone: 'warning',
      message: expect.stringContaining('2 项本机清理失败'),
    })));
  });

  it('keeps the previous reminder selected when local persistence fails', async () => {
    (saveNotificationPrefs as jest.Mock).mockRejectedValueOnce(new Error('storage full'));
    const view = await render(
      <NotificationSettingsScreen navigation={navigation as unknown as React.ComponentProps<typeof NotificationSettingsScreen>['navigation']} />,
    );

    await waitFor(() => expect(view.getByTestId('notification-reminder-15').props.accessibilityState.selected).toBe(true));
    expect(StyleSheet.flatten(view.getByTestId('notification-reminder-15').props.style).minHeight).toBe(52);
    await fireEvent.press(view.getByTestId('notification-reminder-30'));

    await waitFor(() => expect(showDialog).toHaveBeenCalledWith({
      title: '提醒设置未保存',
      message: '本机存储暂时不可用，默认提醒仍保持原设置。',
      tone: 'error',
    }));
    expect(view.getByTestId('notification-reminder-15').props.accessibilityState.selected).toBe(true);
    expect(view.getByTestId('notification-reminder-30').props.accessibilityState.selected).toBe(false);
  });

  it('refreshes notification permission after returning from system settings', async () => {
    (getNotificationPermissionStatus as jest.Mock)
      .mockResolvedValueOnce('denied')
      .mockResolvedValueOnce('granted');
    const view = await render(
      <NotificationSettingsScreen navigation={navigation as unknown as React.ComponentProps<typeof NotificationSettingsScreen>['navigation']} />,
    );

    await waitFor(() => expect(view.getByText('系统通知未开启')).toBeTruthy());
    const callback = (AppState.addEventListener as jest.Mock).mock.calls.at(-1)?.[1];
    callback?.('active');
    await waitFor(() => expect(view.getByText('系统通知已开启')).toBeTruthy());
  });

  it('reports notification permission failures without leaving the row busy', async () => {
    (getNotificationPermissionStatus as jest.Mock).mockResolvedValue('unknown');
    (ensureNotificationPermission as jest.Mock).mockRejectedValueOnce(new Error('native unavailable'));
    const view = await render(
      <NotificationSettingsScreen navigation={navigation as unknown as React.ComponentProps<typeof NotificationSettingsScreen>['navigation']} />,
    );

    await waitFor(() => expect(view.getByText('系统通知状态未知')).toBeTruthy());
    await fireEvent.press(view.getByTestId('notification-permission-button'));

    await waitFor(() => expect(showDialog).toHaveBeenCalledWith({
      title: '无法检查通知权限',
      message: '系统通知状态读取失败，请稍后重试或前往系统设置检查。',
      tone: 'error',
    }));
    expect(view.getByTestId('notification-permission-button').props.disabled).toBe(false);
  });

  it('opens the system notification page when permission is already granted', async () => {
    const view = await render(
      <NotificationSettingsScreen navigation={navigation as unknown as React.ComponentProps<typeof NotificationSettingsScreen>['navigation']} />,
    );

    await waitFor(() => expect(view.getByText('系统通知设置')).toBeTruthy());
    await fireEvent.press(view.getByTestId('notification-permission-button'));

    await waitFor(() => expect(openNotificationSettings).toHaveBeenCalledTimes(1));
    expect(ensureNotificationPermission).not.toHaveBeenCalled();
  });

  it('schedules an observable test reminder from the dedicated notification page', async () => {
    const view = await render(
      <NotificationSettingsScreen navigation={navigation as unknown as React.ComponentProps<typeof NotificationSettingsScreen>['navigation']} />,
    );

    await fireEvent.press(view.getByTestId('notification-test-button'));
    await waitFor(() => expect(scheduleTestNotification).toHaveBeenCalledTimes(1));
    expect(showDialog).toHaveBeenCalledWith({
      title: '测试提醒已安排',
      message: '老记将在 3 秒后发送一条系统通知。',
      tone: 'success',
    });
  });
});
