import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { ACTION_PANEL_GEOMETRY, AppActionSheet } from '../src/components/AppActionSheet';
import { Colors as C } from '../src/theme/colors';

function pressableStyle(node: { props: Record<string, unknown> }) {
  const style = node.props.style;
  return StyleSheet.flatten(typeof style === 'function' ? style({ pressed: false }) : style);
}

describe('AppActionSheet', () => {
  it('uses the source UDActionPanel geometry and flat text-only items', async () => {
    const onClose = jest.fn();
    const onDay = jest.fn();
    await render(
      <AppActionSheet
        visible
        title="日历视图"
        onClose={onClose}
        items={[
          { key: 'day', label: '单日视图', onPress: onDay },
          { key: 'month', label: '月视图', onPress: jest.fn() },
        ]}
      />,
    );

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
});
