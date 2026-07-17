import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import {
  FEISHU_SAVE_GEOMETRY,
  FeishuSaveAction,
} from '../src/components/FeishuForm';
import { FEISHU_DARK_COLORS, FEISHU_LIGHT_COLORS } from '../src/theme/feishuTokens';

describe('Feishu save action', () => {
  it('implements enabled, disabled-with-toast and fully-disabled as distinct states', async () => {
    const onSave = jest.fn();
    const onDisabledPress = jest.fn();
    const view = await render(
      <FeishuSaveAction
        state="enabled"
        onSave={onSave}
        onDisabledPress={onDisabledPress}
      />,
    );

    const enabled = screen.getByTestId('feishu-save-action');
    expect(StyleSheet.flatten(enabled.props.style({ pressed: false }))).toEqual(
      expect.objectContaining(FEISHU_SAVE_GEOMETRY),
    );
    expect(StyleSheet.flatten(screen.getByTestId('feishu-save-action-label').props.style).color)
      .toBe(FEISHU_LIGHT_COLORS.primary);
    expect(enabled.props.accessibilityState).toEqual({ disabled: false });
    await fireEvent.press(enabled);
    expect(onSave).toHaveBeenCalledTimes(1);

    await view.rerender(
      <FeishuSaveAction
        state="disabled-with-toast"
        onSave={onSave}
        onDisabledPress={onDisabledPress}
        disabledHint="请先填写标题"
      />,
    );
    const guarded = screen.getByTestId('feishu-save-action');
    expect(guarded.props.disabled).toBe(false);
    expect(guarded.props.accessibilityState).toEqual({ disabled: false });
    expect(guarded.props.accessibilityHint).toBe('请先填写标题');
    expect(StyleSheet.flatten(screen.getByTestId('feishu-save-action-label').props.style).color)
      .toBe(FEISHU_LIGHT_COLORS.textDisabled);
    await fireEvent.press(guarded);
    expect(onDisabledPress).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledTimes(1);

    await view.rerender(
      <FeishuSaveAction
        state="fully-disabled"
        onSave={onSave}
        onDisabledPress={onDisabledPress}
        scheme="dark"
      />,
    );
    const disabled = screen.getByTestId('feishu-save-action');
    expect(disabled.props.disabled).toBe(true);
    expect(disabled.props.accessibilityState).toEqual({ disabled: true });
    expect(StyleSheet.flatten(screen.getByTestId('feishu-save-action-label').props.style).color)
      .toBe(FEISHU_DARK_COLORS.textDisabled);
    await fireEvent.press(disabled);
    expect(onDisabledPress).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});
