import React from 'react';
import { Text, TouchableOpacity } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AppDialogProvider, useAppDialog } from '../src/components/AppDialog';

jest.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
jest.mock('@expo/vector-icons', () => {
  const React = require('react');
  const Ionicons = (props: object) => React.createElement('Ionicons', props);
  Ionicons.glyphMap = { 'alert-circle-outline': 1 };
  return { Ionicons };
});

function DialogHarness({ onAction, onDismiss }: { onAction: () => void; onDismiss: () => void }) {
  const { showDialog } = useAppDialog();
  return (
    <TouchableOpacity
      onPress={() => showDialog({
        title: '会议仍在录制',
        message: '离开前需要结束并保存。',
        onDismiss,
        actions: [
          { text: '结束并离开', role: 'primary', onPress: onAction },
          { text: '继续录音', role: 'cancel' },
        ],
      })}
    >
      <Text>打开弹窗</Text>
    </TouchableOpacity>
  );
}

describe('AppDialog', () => {
  it('renders the app-styled action flow and runs the chosen action', async () => {
    const onAction = jest.fn();
    await render(
      <AppDialogProvider>
        <DialogHarness onAction={onAction} onDismiss={jest.fn()} />
      </AppDialogProvider>,
    );

    await fireEvent.press(screen.getByText('打开弹窗'));
    expect(screen.getByText('会议仍在录制')).toBeTruthy();
    expect(screen.getByText('离开前需要结束并保存。')).toBeTruthy();
    await fireEvent.press(screen.getByText('结束并离开'));

    await waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('会议仍在录制')).toBeNull();
  });

  it('notifies the caller when Android dismisses the modal', async () => {
    const onDismiss = jest.fn();
    await render(
      <AppDialogProvider>
        <DialogHarness onAction={jest.fn()} onDismiss={onDismiss} />
      </AppDialogProvider>,
    );

    await fireEvent.press(screen.getByText('打开弹窗'));
    const modal = screen.container.queryAll(instance => instance.type === 'Modal', { includeSelf: true })[0];
    await act(() => modal.props.onRequestClose());

    expect(onDismiss).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText('会议仍在录制')).toBeNull());
  });
});
