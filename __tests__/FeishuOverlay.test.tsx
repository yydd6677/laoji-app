import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { StyleSheet, View } from 'react-native';
import {
  FEISHU_OVERLAY_GEOMETRY,
  FeishuDialog,
  FeishuSheet,
  FeishuToast,
} from '../src/components/FeishuOverlay';
import { FEISHU_DARK_COLORS, FEISHU_DIMENSIONS } from '../src/theme/feishuTokens';

function pressableStyle(node: { props: Record<string, unknown> }, pressed = false) {
  const style = node.props.style;
  return StyleSheet.flatten(
    typeof style === 'function' ? style({ pressed }) : style,
  );
}

describe('Feishu controlled toast', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('does not present or consume its timeout while the host is backgrounded', async () => {
    const onDismiss = jest.fn();
    const view = await render(
      <View>
        <FeishuToast
          visible
          message="保存成功"
          onDismiss={onDismiss}
          lifecycleState="background"
          autoHideDurationMs={1200}
        />
      </View>,
    );

    expect(view.queryByTestId('feishu-toast')).toBeNull();
    await act(async () => { jest.advanceTimersByTime(2000); });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('presents and consumes its timeout while the host is visible and active', async () => {
    const onDismiss = jest.fn();
    const activeView = await render(
      <FeishuToast
        visible
        message="保存成功"
        onDismiss={onDismiss}
        lifecycleState="active"
        autoHideDurationMs={1200}
        scheme="dark"
      />,
    );
    expect(StyleSheet.flatten(activeView.getByTestId('feishu-toast').props.style)).toEqual(
      expect.objectContaining({
        maxWidth: FEISHU_OVERLAY_GEOMETRY.toastMaxWidth,
        minHeight: FEISHU_OVERLAY_GEOMETRY.toastMinHeight,
        backgroundColor: FEISHU_DARK_COLORS.backgroundTips,
      }),
    );
    const alert = activeView.getByLabelText('保存成功');
    expect(alert.props.accessibilityRole).toBe('alert');
    expect(alert.props.accessibilityLiveRegion).toBe('polite');

    await act(async () => { jest.advanceTimersByTime(1199); });
    expect(onDismiss).not.toHaveBeenCalled();
    await act(async () => { jest.advanceTimersByTime(1); });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('keeps an optional action independently accessible', async () => {
    const onDismiss = jest.fn();
    const onAction = jest.fn();
    const view = await render(
      <FeishuToast
        visible
        message="同步失败"
        onDismiss={onDismiss}
        autoHideDurationMs={null}
        action={{ label: '重试', onPress: onAction }}
      />,
    );

    const action = view.getByLabelText('重试');
    expect(action.props.accessibilityRole).toBe('button');
    expect(StyleSheet.flatten(action.props.style)).toEqual(expect.objectContaining({
      width: FEISHU_OVERLAY_GEOMETRY.toastActionMaxWidth,
    }));
    await fireEvent.press(action);
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe('Feishu dialog and sheet roles', () => {
  it('anchors dialog actions below a stable body and maps semantic roles in dark mode', async () => {
    const onClose = jest.fn();
    const view = await render(
      <FeishuDialog
        visible
        title="删除日程？"
        message="删除后无法恢复。"
        onRequestClose={onClose}
        scheme="dark"
        actions={[
          { key: 'cancel', label: '取消', role: 'secondary', onPress: jest.fn() },
          { key: 'delete', label: '删除', role: 'destructive', onPress: jest.fn() },
        ]}
      />,
    );

    expect(StyleSheet.flatten(view.getByTestId('feishu-dialog').props.style)).toEqual(
      expect.objectContaining({
        maxWidth: FEISHU_OVERLAY_GEOMETRY.dialogMaxWidth,
        backgroundColor: FEISHU_DARK_COLORS.backgroundFloat,
      }),
    );
    expect(view.getByTestId('feishu-dialog').props.accessibilityRole).toBe('alert');
    expect(StyleSheet.flatten(view.getByTestId('feishu-dialog-body').props.style).height)
      .toBe(FEISHU_OVERLAY_GEOMETRY.dialogBodyHeight);
    const actionsBefore = StyleSheet.flatten(view.getByTestId('feishu-dialog-actions').props.style);
    expect(actionsBefore).toEqual(expect.objectContaining({
      minHeight: 50,
      borderTopWidth: FEISHU_DIMENSIONS.divider,
    }));
    expect(StyleSheet.flatten(view.getByText('取消').props.style).color)
      .toBe(FEISHU_DARK_COLORS.textTitle);
    expect(StyleSheet.flatten(view.getByText('删除').props.style).color)
      .toBe(FEISHU_DARK_COLORS.danger);
    expect(view.getByLabelText('删除').props.accessibilityRole).toBe('button');

    await view.rerender(
      <FeishuDialog
        visible
        title="删除日程？"
        onRequestClose={onClose}
        scheme="dark"
        actions={[
          { key: 'cancel', label: '取消', role: 'secondary', onPress: jest.fn() },
          { key: 'delete', label: '删除', role: 'destructive', onPress: jest.fn() },
        ]}
      />,
    );
    expect(StyleSheet.flatten(view.getByTestId('feishu-dialog-actions').props.style))
      .toEqual(actionsBefore);
  });

  it('guards sheet presentation and exposes menu, item and cancel roles', async () => {
    const onClose = jest.fn();
    const onDelete = jest.fn();
    const props = {
      visible: true,
      title: '更多操作',
      onRequestClose: onClose,
      bottomInset: 20,
      scheme: 'dark' as const,
      actions: [
        { key: 'share', label: '分享', role: 'primary' as const, onPress: jest.fn() },
        { key: 'delete', label: '删除', role: 'destructive' as const, onPress: onDelete },
      ],
    };
    const view = await render(
      <View><FeishuSheet {...props} presentationAllowed={false} /></View>,
    );
    expect(view.queryByTestId('feishu-sheet')).toBeNull();

    await view.rerender(
      <View><FeishuSheet {...props} presentationAllowed /></View>,
    );
    const sheet = view.getByTestId('feishu-sheet');
    expect(sheet.props.accessibilityRole).toBe('menu');
    expect(StyleSheet.flatten(sheet.props.style)).toEqual(expect.objectContaining({
      paddingBottom: 20 + FEISHU_OVERLAY_GEOMETRY.sheetEdgeMargin,
    }));
    expect(StyleSheet.flatten(view.getByTestId('feishu-sheet-panel').props.style)).toEqual(
      expect.objectContaining({
        maxWidth: FEISHU_OVERLAY_GEOMETRY.sheetMaxWidth,
        backgroundColor: FEISHU_DARK_COLORS.backgroundFloat,
      }),
    );
    expect(StyleSheet.flatten(view.getByTestId('feishu-sheet-header').props.style).height)
      .toBe(FEISHU_OVERLAY_GEOMETRY.sheetHeaderHeight);
    expect(pressableStyle(view.getByTestId('feishu-sheet-action-delete'))).toEqual(
      expect.objectContaining({ height: FEISHU_OVERLAY_GEOMETRY.sheetItemHeight }),
    );
    expect(pressableStyle(view.getByTestId('feishu-sheet-cancel'))).toEqual(
      expect.objectContaining({ height: FEISHU_OVERLAY_GEOMETRY.sheetCancelHeight }),
    );
    expect(view.getByLabelText('删除').props.accessibilityRole).toBe('menuitem');
    expect(view.getByLabelText('取消').props.accessibilityRole).toBe('button');
    expect(StyleSheet.flatten(view.getByText('删除').props.style).color)
      .toBe(FEISHU_DARK_COLORS.danger);

    await fireEvent.press(view.getByLabelText('删除'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});
