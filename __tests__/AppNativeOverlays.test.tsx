import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { AppState, Text, TouchableOpacity } from 'react-native';
import {
  AppDialogProvider,
  useAppDialog,
} from '../src/components/AppDialog.android';
import { AppActionSheet } from '../src/components/AppActionSheet.android';
import { AppToast } from '../src/components/AppToast.android';

type OverlayEvent = {
  kind: 'dialog' | 'action-sheet' | 'toast';
  ownerId: string;
  index?: number;
  key?: string;
  type?: string;
  role?: string;
  reason?: string;
};

const mockPresentOverlay = jest.fn(async (
  _ownerId: string,
  _kind: OverlayEvent['kind'],
  _snapshot: any,
) => undefined);
const mockDismissOverlay = jest.fn(async (
  _ownerId: string,
  _kind: OverlayEvent['kind'],
  _reason: string,
) => undefined);
const mockActionListeners = new Set<(event: OverlayEvent) => void>();
const mockDismissListeners = new Set<(event: OverlayEvent) => void>();
let toastOwnerSequence = 0;

jest.mock('laoji-native-platform', () => ({
  createNativeOverlayOwnerId: (prefix: string) => (
    prefix === 'app-toast' ? `${prefix}-test-${++toastOwnerSequence}` : `${prefix}-test`
  ),
  presentNativeWindowOverlay: (ownerId: string, kind: OverlayEvent['kind'], snapshot: any) => (
    mockPresentOverlay(ownerId, kind, snapshot)
  ),
  dismissNativeWindowOverlay: (ownerId: string, kind: OverlayEvent['kind'], reason: string) => (
    mockDismissOverlay(ownerId, kind, reason)
  ),
  addNativeWindowOverlayActionListener: (listener: (event: OverlayEvent) => void) => {
    mockActionListeners.add(listener);
    return { remove: () => mockActionListeners.delete(listener) };
  },
  addNativeWindowOverlayDismissListener: (listener: (event: OverlayEvent) => void) => {
    mockDismissListeners.add(listener);
    return { remove: () => mockDismissListeners.delete(listener) };
  },
}));

function latestPresentation(kind: OverlayEvent['kind']) {
  return [...mockPresentOverlay.mock.calls].reverse().find(call => call[1] === kind);
}

function emitAction(event: OverlayEvent) {
  mockActionListeners.forEach(listener => listener(event));
}

function emitDismiss(event: OverlayEvent) {
  mockDismissListeners.forEach(listener => listener(event));
}

function DialogHarness({ onAction }: { onAction: jest.Mock }) {
  const { showDialog } = useAppDialog();
  return (
    <TouchableOpacity
      testID="show-dialog"
      onPress={() => showDialog({
        title: '删除日程',
        actions: [
          { text: '删除', role: 'destructive', onPress: onAction },
          { text: '取消', role: 'cancel' },
        ],
      })}
    >
      <Text>打开</Text>
    </TouchableOpacity>
  );
}

describe('native Android overlays [UI-OVERLAY-001/UI-MOTION-001]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    toastOwnerSequence = 0;
  });

  it('does not mount an invisible full-screen native adapter', async () => {
    const dialog = await render(<AppDialogProvider><Text>内容</Text></AppDialogProvider>);
    expect(dialog.queryByTestId('app-dialog-native-host')).toBeNull();

    const sheet = await render(
      <AppActionSheet visible={false} title="操作" items={[]} onClose={jest.fn()} />,
    );
    expect(sheet.queryByTestId('app-action-sheet-native-host')).toBeNull();
    expect(mockPresentOverlay).not.toHaveBeenCalled();
  });

  it('runs a dialog command only after the native close animation completes', async () => {
    const command = jest.fn();
    const view = await render(<AppDialogProvider><DialogHarness onAction={command} /></AppDialogProvider>);
    await fireEvent.press(view.getByTestId('show-dialog'));
    await waitFor(() => expect(latestPresentation('dialog')?.[2]).toMatchObject({ visible: true, title: '删除日程' }));
    const ownerId = latestPresentation('dialog')?.[0] as string;

    await act(async () => emitAction({ kind: 'dialog', ownerId, index: 0, role: 'destructive' }));
    expect(command).not.toHaveBeenCalled();
    await waitFor(() => expect(latestPresentation('dialog')?.[2]).toMatchObject({ visible: false }));
    await act(async () => emitDismiss({ kind: 'dialog', ownerId, reason: 'closed' }));
    expect(command).toHaveBeenCalledTimes(1);
  });

  it('clears private dialog content when the app leaves the foreground', async () => {
    const addEventListener = AppState.addEventListener as jest.Mock;
    addEventListener.mockClear();
    const view = await render(<AppDialogProvider><DialogHarness onAction={jest.fn()} /></AppDialogProvider>);
    await fireEvent.press(view.getByTestId('show-dialog'));
    await waitFor(() => expect(latestPresentation('dialog')).toBeTruthy());

    const appStateListener = addEventListener.mock.calls.at(-1)?.[1] as ((state: string) => void);
    await act(async () => appStateListener('background'));
    expect(view.queryByTestId('app-dialog-native-host')).toBeNull();
    expect(mockDismissOverlay).toHaveBeenCalledWith('app-dialog-test', 'dialog', 'unmounted');
  });

  it('filters disabled sheet actions and runs the selected item after native dismissal', async () => {
    const close = jest.fn();
    const selected = jest.fn();
    const view = await render(
      <AppActionSheet
        visible
        title="会议操作"
        onClose={close}
        items={[
          { key: 'busy', label: '正在同步', disabled: true, onPress: jest.fn() },
          { key: 'share', label: '分享会议文档', onPress: selected },
        ]}
      />,
    );
    await waitFor(() => expect(latestPresentation('action-sheet')).toBeTruthy());
    const [ownerId, , snapshot] = latestPresentation('action-sheet')!;
    expect(snapshot.items).toEqual([
      expect.objectContaining({ key: 'share', label: '分享会议文档' }),
    ]);
    await act(async () => emitAction({ kind: 'action-sheet', ownerId, key: 'share', index: 0 }));
    expect(close).toHaveBeenCalledTimes(1);
    expect(selected).not.toHaveBeenCalled();
    await act(async () => emitDismiss({ kind: 'action-sheet', ownerId, reason: 'item' }));
    expect(selected).toHaveBeenCalledTimes(1);
  });

  it('presents a sheet when a mounted adapter changes from hidden to visible', async () => {
    const close = jest.fn();
    const items = [{ key: 'profile', label: '个人资料', onPress: jest.fn() }];
    const view = await render(
      <AppActionSheet visible={false} title="会议记录" items={items} onClose={close} />,
    );
    expect(latestPresentation('action-sheet')).toBeUndefined();

    await view.rerender(
      <AppActionSheet visible title="会议记录" items={items} onClose={close} />,
    );
    await waitFor(() => expect(latestPresentation('action-sheet')?.[2]).toMatchObject({
      visible: true,
      title: '会议记录',
    }));
  });

  it('restarts a same-message toast when its presentation key changes', async () => {
    const dismiss = jest.fn();
    const view = await render(
      <AppToast
        visible
        message="请填写日程标题"
        autoHideDurationMs={4500}
        bottom={24}
        presentationKey={1}
        onDismiss={dismiss}
      />,
    );
    await waitFor(() => expect(latestPresentation('toast')?.[2]).toMatchObject({
      visible: true,
      message: '请填写日程标题',
      durationMs: 4500,
      bottom: 24,
      presentationKey: 1,
    }));
    const ownerId = latestPresentation('toast')?.[0] as string;
    await view.rerender(
      <AppToast
        visible
        message="请填写日程标题"
        autoHideDurationMs={4500}
        bottom={24}
        presentationKey={2}
        onDismiss={dismiss}
      />,
    );
    await waitFor(() => expect(mockPresentOverlay.mock.calls.filter(call => (
      call[0] === ownerId && call[1] === 'toast'
    ))).toHaveLength(2));
    expect(latestPresentation('toast')?.[2]).toMatchObject({ presentationKey: 2 });
  });

  it('uses latest-wins when two toast owners compete', async () => {
    const firstDismiss = jest.fn();
    const secondDismiss = jest.fn();
    await render(
      <>
        <AppToast visible message="第一条" onDismiss={firstDismiss} />
        <AppToast visible message="第二条" onDismiss={secondDismiss} />
      </>,
    );
    await waitFor(() => expect(mockPresentOverlay.mock.calls.filter(call => call[1] === 'toast')).toHaveLength(2));
    const toastCalls = mockPresentOverlay.mock.calls.filter(call => call[1] === 'toast');
    const firstOwner = toastCalls[0][0] as string;
    const secondOwner = toastCalls[1][0] as string;
    expect(firstOwner).not.toBe(secondOwner);
    await act(async () => emitDismiss({ kind: 'toast', ownerId: firstOwner, reason: 'replaced' }));
    expect(firstDismiss).toHaveBeenCalledTimes(1);
    expect(secondDismiss).not.toHaveBeenCalled();
  });

  it('uses the source-derived four-second default for a plain toast', async () => {
    await render(
      <AppToast visible message="资料格式不正确" onDismiss={jest.fn()} />,
    );
    await waitFor(() => expect(latestPresentation('toast')?.[2]).toMatchObject({
      visible: true,
      message: '资料格式不正确',
      durationMs: 4000,
      bottom: 80,
    }));
  });
});
