import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet, Text } from 'react-native';
import {
  FEISHU_SHELL_GEOMETRY,
  FeishuEmptyState,
  FeishuFab,
  FeishuTitleBar,
  FeishuViewBar,
} from '../src/components/FeishuShell';
import { FEISHU_DARK_COLORS, FEISHU_DIMENSIONS } from '../src/theme/feishuTokens';

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

function pressableStyle(node: { props: Record<string, unknown> }, pressed = false) {
  const style = node.props.style;
  return StyleSheet.flatten(
    typeof style === 'function' ? style({ pressed }) : style,
  );
}

describe('Feishu shell primitives', () => {
  it('keeps title and view bars fixed while optional slots change', async () => {
    const view = await render(
      <FeishuTitleBar title="会议详情" scheme="dark" trailing={<Text>保存</Text>} />,
    );

    expect(StyleSheet.flatten(screen.getByTestId('feishu-title-bar').props.style)).toEqual(
      expect.objectContaining({
        height: 44,
        backgroundColor: FEISHU_DARK_COLORS.backgroundBody,
      }),
    );
    expect(StyleSheet.flatten(screen.getByTestId('feishu-title-bar-title').props.style)).toEqual(
      expect.objectContaining({
        left: FEISHU_SHELL_GEOMETRY.titleTrailingSlotWidth,
        right: FEISHU_SHELL_GEOMETRY.titleTrailingSlotWidth,
        fontSize: 17,
        color: FEISHU_DARK_COLORS.textTitle,
      }),
    );
    const trailingBefore = StyleSheet.flatten(
      screen.getByTestId('feishu-title-bar-trailing').props.style,
    );

    await view.rerender(
      <FeishuTitleBar
        title="会议详情"
        scheme="dark"
        leading={<Text>返回</Text>}
        trailing={<Text>保存</Text>}
      />,
    );
    expect(StyleSheet.flatten(screen.getByTestId('feishu-title-bar-trailing').props.style))
      .toEqual(trailingBefore);

    await view.rerender(
      <FeishuViewBar trailing={<Text>切换</Text>}><Text>单日视图</Text></FeishuViewBar>,
    );
    expect(StyleSheet.flatten(screen.getByTestId('feishu-view-bar').props.style)).toEqual(
      expect.objectContaining({ height: 50, borderBottomWidth: FEISHU_DIMENSIONS.divider }),
    );
    expect(StyleSheet.flatten(screen.getByTestId('feishu-view-bar-trailing').props.style))
      .toEqual(expect.objectContaining({ width: 50, height: 50 }));
  });

  it('renders a 48dp accessible FAB with stable pressed geometry', async () => {
    const onPress = jest.fn();
    await render(<FeishuFab onPress={onPress} accessibilityLabel="新建日程" />);

    const fab = screen.getByLabelText('新建日程');
    expect(pressableStyle(fab)).toEqual(expect.objectContaining({
      width: 48,
      height: 48,
      borderRadius: 24,
    }));
    expect(pressableStyle(fab, true)).toEqual(expect.objectContaining({
      width: 48,
      height: 48,
    }));
    expect(fab.props.accessibilityRole).toBe('button');
    expect(fab.props.accessibilityState).toEqual({ disabled: false });

    await fireEvent.press(fab);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('reserves copy and action slots around the 100dp empty illustration', async () => {
    const onRetry = jest.fn();
    const view = await render(
      <FeishuEmptyState
        title="暂无结果"
        description="没有找到相关会议"
        onRetry={onRetry}
        scheme="dark"
      />,
    );

    expect(StyleSheet.flatten(screen.getByTestId(
      'feishu-empty-state-illustration',
      { includeHiddenElements: true },
    ).props.style))
      .toEqual(expect.objectContaining({
        width: 100,
        height: 100,
        backgroundColor: FEISHU_DARK_COLORS.backgroundBodyOverlay,
      }));
    expect(StyleSheet.flatten(screen.getByTestId('feishu-empty-state-copy-slot').props.style).height)
      .toBe(FEISHU_SHELL_GEOMETRY.emptyCopyHeight);
    const actionSlotBefore = StyleSheet.flatten(
      screen.getByTestId('feishu-empty-state-action-slot').props.style,
    );
    expect(actionSlotBefore).toEqual(expect.objectContaining({ width: 76, height: 36 }));
    expect(pressableStyle(screen.getByTestId('feishu-empty-state-retry'))).toEqual(
      expect.objectContaining({ width: 76, height: 36 }),
    );
    expect(screen.getByTestId('feishu-empty-state-copy-slot').props.accessibilityLabel)
      .toBe('暂无结果，没有找到相关会议');
    expect(screen.getByLabelText('重试').props.accessibilityRole).toBe('button');

    await fireEvent.press(screen.getByLabelText('重试'));
    expect(onRetry).toHaveBeenCalledTimes(1);

    await view.rerender(
      <FeishuEmptyState description="没有找到相关会议" onRetry={onRetry} scheme="dark" />,
    );
    expect(StyleSheet.flatten(screen.getByTestId('feishu-empty-state-action-slot').props.style))
      .toEqual(actionSlotBefore);
  });
});
