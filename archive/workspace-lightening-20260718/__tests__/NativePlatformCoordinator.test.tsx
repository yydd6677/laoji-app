import React from 'react';
import { render, waitFor } from '@testing-library/react-native';
import { activateMinutesPlaybackStorageScope } from 'laoji-native-platform';
import { NativePlatformCoordinator } from '../src/components/NativePlatformCoordinator';
import { useAuth } from '../src/store/AuthStore';

jest.mock('laoji-native-platform', () => ({
  activateMinutesPlaybackStorageScope: jest.fn(async () => undefined),
  hasNativeTransfer: () => false,
  nativeTransfer: null,
}));
jest.mock('../src/store/AuthStore', () => ({ useAuth: jest.fn() }));

describe('NativePlatformCoordinator MIN-PLAYER-RECOVERY-001 scope activation', () => {
  it('waits for auth initialization then activates guest user switch and signed-out scopes', async () => {
    (useAuth as jest.Mock).mockReturnValue({ initializing: true, mode: 'signed_out', session: null, accessToken: null });
    const view = await render(<NativePlatformCoordinator />);
    expect(activateMinutesPlaybackStorageScope).not.toHaveBeenCalled();

    (useAuth as jest.Mock).mockReturnValue({ initializing: false, mode: 'guest', session: null, accessToken: null });
    await view.rerender(<NativePlatformCoordinator />);
    await waitFor(() => expect(activateMinutesPlaybackStorageScope).toHaveBeenLastCalledWith('guest'));

    (useAuth as jest.Mock).mockReturnValue({
      initializing: false,
      mode: 'authenticated',
      session: { user: { id: '7' } },
      accessToken: 'token-7',
    });
    await view.rerender(<NativePlatformCoordinator />);
    await waitFor(() => expect(activateMinutesPlaybackStorageScope).toHaveBeenLastCalledWith('user:7'));

    (useAuth as jest.Mock).mockReturnValue({ initializing: false, mode: 'signed_out', session: null, accessToken: null });
    await view.rerender(<NativePlatformCoordinator />);
    await waitFor(() => expect(activateMinutesPlaybackStorageScope).toHaveBeenLastCalledWith('signed_out'));
  });
});
