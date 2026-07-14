import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import {
  NOTIFICATION_PERMISSION_PRIMER_KEY,
  NotificationPermissionPrimer,
} from '../src/components/NotificationPermissionPrimer';
import { AppDialogProvider } from '../src/components/AppDialog';
import { getAppStorageItem, setAppStorageItem } from '../src/services/appStorage';
import {
  ensureNotificationPermission,
  getNotificationPermissionState,
  openNotificationSettings,
  prepareNotificationChannel,
} from '../src/services/notifications';

jest.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
jest.mock('@expo/vector-icons', () => {
  const ReactModule = require('react');
  const Ionicons = (props: object) => ReactModule.createElement('Ionicons', props);
  Ionicons.glyphMap = {};
  return { Ionicons };
});
jest.mock('../src/services/appStorage', () => ({
  getAppStorageItem: jest.fn(),
  setAppStorageItem: jest.fn(),
}));
jest.mock('../src/services/notifications', () => ({
  ensureNotificationPermission: jest.fn(),
  getNotificationPermissionState: jest.fn(),
  openNotificationSettings: jest.fn(),
  prepareNotificationChannel: jest.fn(),
}));
jest.mock('../src/store/AuthStore', () => ({
  useAuth: () => ({ initializing: false }),
}));

describe('NotificationPermissionPrimer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getAppStorageItem as jest.Mock).mockResolvedValue(null);
    (setAppStorageItem as jest.Mock).mockResolvedValue(undefined);
    (prepareNotificationChannel as jest.Mock).mockResolvedValue(undefined);
    (getNotificationPermissionState as jest.Mock).mockResolvedValue({
      status: 'undetermined',
      granted: false,
      canAskAgain: true,
    });
    (ensureNotificationPermission as jest.Mock).mockResolvedValue(true);
    (openNotificationSettings as jest.Mock).mockResolvedValue(undefined);
  });

  it('explains the reason before invoking the system permission request', async () => {
    await render(
      <AppDialogProvider>
        <NotificationPermissionPrimer />
      </AppDialogProvider>,
    );

    await waitFor(() => expect(screen.getByText('开启日程提醒')).toBeTruthy());
    expect(screen.getByText('点击“继续开启”后，手机会显示系统权限窗口。')).toBeTruthy();
    expect(ensureNotificationPermission).not.toHaveBeenCalled();
    expect(prepareNotificationChannel).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByText('继续开启'));

    await waitFor(() => expect(ensureNotificationPermission).toHaveBeenCalledTimes(1));
    expect(setAppStorageItem).toHaveBeenCalledWith(
      NOTIFICATION_PERMISSION_PRIMER_KEY,
      'shown',
    );
  });

  it('offers a direct system-settings route when permission remains denied', async () => {
    (ensureNotificationPermission as jest.Mock).mockResolvedValueOnce(false);
    await render(
      <AppDialogProvider>
        <NotificationPermissionPrimer />
      </AppDialogProvider>,
    );

    await waitFor(() => expect(screen.getByText('继续开启')).toBeTruthy());
    await fireEvent.press(screen.getByText('继续开启'));
    await waitFor(() => expect(screen.getByText('通知尚未开启')).toBeTruthy());
    await fireEvent.press(screen.getByText('打开系统设置'));

    expect(openNotificationSettings).toHaveBeenCalledTimes(1);
  });

  it('explains where notifications are managed instead of silently skipping an existing grant', async () => {
    (getNotificationPermissionState as jest.Mock).mockResolvedValueOnce({
      status: 'granted',
      granted: true,
      canAskAgain: true,
    });
    await render(
      <AppDialogProvider>
        <NotificationPermissionPrimer />
      </AppDialogProvider>,
    );

    await waitFor(() => expect(screen.getByText('日程提醒已开启')).toBeTruthy());
    expect(screen.getByText(/应用通知.*通知管理/)).toBeTruthy();
    expect(ensureNotificationPermission).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByText('知道了'));
    expect(setAppStorageItem).toHaveBeenCalledWith(
      NOTIFICATION_PERMISSION_PRIMER_KEY,
      'shown',
    );
  });

  it('does not show the explanation again after it has been handled', async () => {
    (getAppStorageItem as jest.Mock).mockResolvedValueOnce('shown');
    await render(
      <AppDialogProvider>
        <NotificationPermissionPrimer />
      </AppDialogProvider>,
    );

    await waitFor(() => expect(getAppStorageItem).toHaveBeenCalledWith(
      NOTIFICATION_PERMISSION_PRIMER_KEY,
    ));
    expect(screen.queryByText('开启日程提醒')).toBeNull();
    expect(ensureNotificationPermission).not.toHaveBeenCalled();
  });
});
