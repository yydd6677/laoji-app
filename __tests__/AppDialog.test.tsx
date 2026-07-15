import React from 'react';
import { StyleSheet, Text, TouchableOpacity } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import {
  APP_DIALOG_GEOMETRY,
  AppDialogProvider,
  useAppDialog,
} from '../src/components/AppDialog';

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
    expect(screen.queryByTestId('app-dialog-icon')).toBeNull();
    expect(StyleSheet.flatten(screen.getByTestId('app-dialog-card').props.style)).toEqual(expect.objectContaining({
      maxWidth: APP_DIALOG_GEOMETRY.maxWidth,
      borderRadius: APP_DIALOG_GEOMETRY.radius,
    }));
    expect(StyleSheet.flatten(screen.getByTestId('app-dialog-title-region').props.style)).toEqual(expect.objectContaining({
      maxWidth: APP_DIALOG_GEOMETRY.contentWidth,
      minHeight: APP_DIALOG_GEOMETRY.titleHeight,
      marginTop: 20,
    }));
    expect(StyleSheet.flatten(screen.getByTestId('app-dialog-content-region').props.style).marginTop).toBe(12);
    expect(StyleSheet.flatten(screen.getByTestId('app-dialog-actions').props.style)).toEqual(expect.objectContaining({
      marginTop: 20,
      borderTopWidth: 1,
      flexDirection: 'row-reverse',
    }));
    expect(StyleSheet.flatten(screen.getByTestId('app-dialog-action-0').props.style)).toEqual(expect.objectContaining({
      minHeight: APP_DIALOG_GEOMETRY.actionHeight,
      borderLeftWidth: 1,
    }));
    await fireEvent.press(screen.getByText('结束并离开'));

    await waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('会议仍在录制')).toBeNull();
  });

  it('uses an explicit extra icon and vertical source rows for three or more actions', async () => {
    function MultiActionHarness() {
      const { showDialog } = useAppDialog();
      return (
        <TouchableOpacity onPress={() => showDialog({
          title: '分享会议',
          message: '选择分享内容。',
          hint: '录音文件可能较大。',
          icon: 'alert-circle-outline',
          tone: 'warning',
          actions: [
            { text: '完整资料包', role: 'primary' },
            { text: '会议文档', role: 'secondary' },
            { text: '取消', role: 'cancel' },
          ],
        })}>
          <Text>打开多选弹窗</Text>
        </TouchableOpacity>
      );
    }

    await render(
      <AppDialogProvider>
        <MultiActionHarness />
      </AppDialogProvider>,
    );

    await fireEvent.press(screen.getByText('打开多选弹窗'));
    expect(screen.getByTestId('app-dialog-icon')).toBeTruthy();
    expect(screen.getByText('录音文件可能较大。')).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByTestId('app-dialog-actions').props.style).flexDirection).toBeUndefined();
    expect(StyleSheet.flatten(screen.getByTestId('app-dialog-action-1').props.style)).toEqual(expect.objectContaining({
      minHeight: APP_DIALOG_GEOMETRY.actionHeight,
      borderTopWidth: 1,
    }));
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
