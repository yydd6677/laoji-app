import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Animated, StyleSheet } from 'react-native';
import { ACTION_PANEL_GEOMETRY, AppActionSheet } from '../src/components/AppActionSheet';
import { Colors as C } from '../src/theme/colors';

// CAL-REPEAT-RRULE-001: caller evidence must reach the rendered modal root.

function pressableStyle(node: { props: Record<string, unknown> }) {
  const style = node.props.style;
  return StyleSheet.flatten(typeof style === 'function' ? style({ pressed: false }) : style);
}

function deferTimingAnimations() {
  const timing = Animated.timing as jest.Mock;
  const originalImplementation = timing.getMockImplementation();
  const completions: Array<(result: { finished: boolean }) => void> = [];
  timing.mockImplementation((value, config) => ({
    start: jest.fn((completion?: (result: { finished: boolean }) => void) => {
      value?.setValue?.(config?.toValue);
      if (completion) completions.push(completion);
    }),
  }));
  return {
    completions,
    restore: () => timing.mockImplementation(originalImplementation),
  };
}

describe('AppActionSheet', () => {
  it('uses the source UDActionPanel geometry and flat text-only items', async () => {
    const onClose = jest.fn();
    const onDay = jest.fn();
    const view = await render(
      <AppActionSheet
        feishuEvidence="feishu:CAL-REPEAT-RRULE-001:test-repeat-sheet"
        visible
        title="日历视图"
        onClose={onClose}
        items={[
          { key: 'day', label: '单日视图', onPress: onDay },
          { key: 'month', label: '月视图', onPress: jest.fn() },
        ]}
      />,
    );

    expect(view.container.queryAll(
      instance => instance.props.nativeID === 'feishu:CAL-REPEAT-RRULE-001:test-repeat-sheet',
      { includeSelf: true },
    )).toHaveLength(1);

    expect(ACTION_PANEL_GEOMETRY).toEqual({
      edgeMargin: 12,
      maxWidth: 450,
      radius: 8,
      titleHeight: 52,
      titleHorizontalPadding: 12,
      titleVerticalPadding: 16,
      titleSize: 14,
      itemHeight: 52,
      itemHorizontalPadding: 12,
      itemVerticalPadding: 14,
      itemSize: 17,
      dividerHeight: 0.5,
      cancelGap: 12,
      cancelHeight: 48,
      animationDuration: 300,
    });
    expect(StyleSheet.flatten(screen.getByTestId('app-action-sheet-panel').props.style)).toEqual(
      expect.objectContaining({ width: '100%', maxWidth: 450, alignSelf: 'center', borderRadius: 8, backgroundColor: C.body }),
    );
    expect(StyleSheet.flatten(screen.getByTestId('app-action-sheet-header').props.style)).toEqual(
      expect.objectContaining({ height: 52, paddingHorizontal: 12, paddingVertical: 16 }),
    );
    expect(StyleSheet.flatten(screen.getByTestId('app-action-sheet-title').props.style)).toEqual(
      expect.objectContaining({ fontSize: 14, fontWeight: '400', color: C.faint, textAlign: 'center' }),
    );
    expect(pressableStyle(screen.getByTestId('app-action-sheet-item-day'))).toEqual(
      expect.objectContaining({ minHeight: 52, paddingHorizontal: 12, paddingVertical: 14 }),
    );
    expect(StyleSheet.flatten(screen.getByTestId('app-action-sheet-header-divider').props.style).height).toBe(0.5);
    expect(StyleSheet.flatten(screen.getByTestId('app-action-sheet-item-divider-day').props.style).height).toBe(0.5);
    expect(StyleSheet.flatten(screen.getByTestId('app-action-sheet-backdrop').props.style)).toEqual(
      expect.objectContaining({ backgroundColor: C.overlay }),
    );
    expect(screen.queryByTestId('app-action-sheet-handle')).toBeNull();

    await fireEvent.press(screen.getByLabelText('单日视图'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onDay).toHaveBeenCalledTimes(1);
  });

  it('closes from the explicit cancel command', async () => {
    const onClose = jest.fn();
    await render(
      <AppActionSheet
        visible
        title="新建日程"
        onClose={onClose}
        items={[
          { key: 'voice', label: '语音输入', onPress: jest.fn() },
        ]}
      />,
    );

    expect(pressableStyle(screen.getByTestId('app-action-sheet-cancel'))).toEqual(
      expect.objectContaining({ width: '100%', maxWidth: 450, alignSelf: 'center', height: 48, marginTop: 12, borderRadius: 8, backgroundColor: C.body }),
    );
    await fireEvent.press(screen.getByText('取消'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('supports the source no-title panel and keeps disabled choices visible', async () => {
    const disabledAction = jest.fn();
    await render(
      <AppActionSheet
        visible
        onClose={jest.fn()}
        items={[{ key: 'series', label: '编辑所有日程', disabled: true, onPress: disabledAction }]}
      />,
    );

    expect(screen.queryByTestId('app-action-sheet-header')).toBeNull();
    const item = screen.getByTestId('app-action-sheet-item-series');
    expect(item.props.accessibilityState).toEqual({ disabled: true });
    expect(StyleSheet.flatten(screen.getByText('编辑所有日程').props.style).color).toBe(C.disabled);
    await fireEvent.press(item);
    expect(disabledAction).not.toHaveBeenCalled();
  });

  it('routes Android back through the complete exit before notifying its owner', async () => {
    const onClose = jest.fn();
    const view = await render(
      <AppActionSheet
        visible
        title="新建日程"
        onClose={onClose}
        items={[{ key: 'voice', label: '语音输入', onPress: jest.fn() }]}
      />,
    );
    const modal = view.container.queryAll(instance => instance.type === 'Modal', { includeSelf: true })[0];
    const deferred = deferTimingAnimations();

    try {
      await act(() => modal.props.onRequestClose());
      await act(() => modal.props.onRequestClose());

      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByTestId('app-action-sheet-backdrop')).toBeTruthy();
      expect(screen.getByText('语音输入')).toBeTruthy();
      expect(deferred.completions).toHaveLength(1);

      await act(() => deferred.completions[0]({ finished: true }));
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('app-action-sheet-panel')).toBeNull();
      expect(view.container.queryAll(instance => instance.type === 'Modal', { includeSelf: true })).toHaveLength(0);
    } finally {
      deferred.restore();
    }
  });
});
