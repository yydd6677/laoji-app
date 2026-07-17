import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import {
  FEISHU_DIMENSIONS,
  FEISHU_FONT_SIZES,
  getFeishuTokens,
  type FeishuColorScheme,
} from '../theme/feishuTokens';

export type FeishuSaveState = 'enabled' | 'disabled-with-toast' | 'fully-disabled';

export const FEISHU_SAVE_GEOMETRY = Object.freeze({
  width: FEISHU_DIMENSIONS.saveActionWidth,
  height: FEISHU_DIMENSIONS.titleBarHeight,
} as const);

export function FeishuSaveAction({
  state,
  onSave,
  onDisabledPress,
  disabledHint,
  label = '保存',
  scheme = 'light',
  testID = 'feishu-save-action',
}: {
  state: FeishuSaveState;
  onSave: () => void;
  onDisabledPress?: () => void;
  disabledHint?: string;
  label?: string;
  scheme?: FeishuColorScheme;
  testID?: string;
}) {
  const { colors } = getFeishuTokens(scheme);
  const fullyDisabled = state === 'fully-disabled';
  const visuallyDisabled = state !== 'enabled';

  const handlePress = () => {
    if (state === 'enabled') {
      onSave();
      return;
    }
    if (state === 'disabled-with-toast') onDisabledPress?.();
  };

  return (
    <Pressable
      onPress={handlePress}
      disabled={fullyDisabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={state === 'disabled-with-toast' ? disabledHint : undefined}
      accessibilityState={{ disabled: fullyDisabled }}
      style={({ pressed }) => [
        styles.action,
        pressed && !visuallyDisabled && { backgroundColor: colors.pressedFill },
      ]}
      testID={testID}
    >
      <Text
        style={[
          styles.label,
          { color: visuallyDisabled ? colors.textDisabled : colors.primary },
        ]}
        numberOfLines={1}
        testID={`${testID}-label`}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  action: {
    width: FEISHU_SAVE_GEOMETRY.width,
    height: FEISHU_SAVE_GEOMETRY.height,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    maxWidth: '100%',
    paddingHorizontal: 4,
    fontSize: FEISHU_FONT_SIZES.title3,
    lineHeight: 24,
    fontWeight: '400',
    textAlign: 'center',
  },
});
