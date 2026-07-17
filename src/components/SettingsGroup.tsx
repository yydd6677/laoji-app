import React from 'react';
import {
  StyleProp,
  StyleSheet,
  Text,
  TextStyle,
  TouchableOpacity,
  View,
  ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { FeishuTitleBar } from './FeishuShell';
import {
  FEISHU_DIMENSIONS,
  FEISHU_FONT_SIZES,
  getFeishuTokens,
} from '../theme/feishuTokens';

const { colors: F } = getFeishuTokens();

// UI-SHELL-001 / UI-TOKENS-001: settings pages share the 44dp shell and semantic rows.

export const SETTINGS_GROUP_GEOMETRY = {
  marginHorizontal: 0,
  marginTop: 12,
  radius: 0,
  rowHeight: 52,
  avatarRowHeight: 64,
  horizontalPadding: 16,
  titleSize: FEISHU_FONT_SIZES.body0,
  valueSize: FEISHU_FONT_SIZES.body1,
  arrowSize: 16,
  divider: FEISHU_DIMENSIONS.divider,
} as const;

export function SettingsTitleBar({
  title,
  onBack,
  trailing,
  testID = 'app-back-header',
}: {
  title: string;
  onBack: () => void;
  trailing?: React.ReactNode;
  testID?: string;
}) {
  return (
    <FeishuTitleBar
      title={title}
      testID={testID}
      leading={(
        <TouchableOpacity
          style={s.backButton}
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="返回"
          testID={`${testID}-back`}
        >
          <Ionicons
            name="chevron-back"
            size={24}
            color={F.iconPrimary}
            testID="app-back-icon"
          />
        </TouchableOpacity>
      )}
      trailing={trailing}
    />
  );
}

export function SettingsGroup({
  children,
  style,
  testID,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  return (
    <View style={[s.group, style]} testID={testID}>
      {children}
    </View>
  );
}

export function SettingsRow({
  label,
  value,
  right,
  onPress,
  last = false,
  height = SETTINGS_GROUP_GEOMETRY.rowHeight,
  centered = false,
  destructive = false,
  disabled = false,
  selected,
  showChevron = Boolean(onPress) && !centered,
  accessibilityLabel,
  accessibilityHint,
  testID,
  style,
  labelStyle,
}: {
  label: string;
  value?: string;
  right?: React.ReactNode;
  onPress?: () => void;
  last?: boolean;
  height?: number;
  centered?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  selected?: boolean;
  showChevron?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
  labelStyle?: StyleProp<TextStyle>;
}) {
  const content = (
    <>
      <Text
        style={[
          s.label,
          centered && s.centeredLabel,
          destructive && s.destructiveLabel,
          labelStyle,
        ]}
        numberOfLines={2}
      >
        {label}
      </Text>
      {!centered ? (
        <View style={s.rightArea}>
          {value ? <Text style={s.value} numberOfLines={1}>{value}</Text> : null}
          {right}
          {showChevron ? (
            <Ionicons
              name="chevron-forward"
              size={SETTINGS_GROUP_GEOMETRY.arrowSize}
              color={F.iconTertiary}
            />
          ) : null}
        </View>
      ) : null}
      {!last ? <View pointerEvents="none" style={s.divider} /> : null}
    </>
  );

  const rowStyle = [s.row, { minHeight: height }, disabled && s.disabled, style];
  if (!onPress) {
    return <View style={rowStyle} testID={testID}>{content}</View>;
  }

  return (
    <TouchableOpacity
      style={rowStyle}
      onPress={onPress}
      activeOpacity={0.72}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled, ...(selected === undefined ? {} : { selected }) }}
      testID={testID}
    >
      {content}
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  group: {
    marginHorizontal: SETTINGS_GROUP_GEOMETRY.marginHorizontal,
    marginTop: SETTINGS_GROUP_GEOMETRY.marginTop,
    borderRadius: SETTINGS_GROUP_GEOMETRY.radius,
    overflow: 'hidden',
    backgroundColor: F.backgroundBody,
  },
  row: {
    position: 'relative',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SETTINGS_GROUP_GEOMETRY.horizontalPadding,
    backgroundColor: F.backgroundBody,
  },
  disabled: { opacity: 0.45 },
  label: {
    flexShrink: 1,
    maxWidth: 164,
    fontSize: SETTINGS_GROUP_GEOMETRY.titleSize,
    lineHeight: 22,
    fontWeight: '400',
    color: F.textTitle,
  },
  centeredLabel: {
    flex: 1,
    maxWidth: '100%',
    textAlign: 'center',
  },
  destructiveLabel: { color: F.danger },
  rightArea: {
    flex: 1,
    minWidth: 0,
    marginLeft: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 6,
  },
  value: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: SETTINGS_GROUP_GEOMETRY.valueSize,
    lineHeight: 20,
    fontWeight: '400',
    color: F.textCaption,
  },
  divider: {
    position: 'absolute',
    left: SETTINGS_GROUP_GEOMETRY.horizontalPadding,
    right: 0,
    bottom: 0,
    height: SETTINGS_GROUP_GEOMETRY.divider,
    backgroundColor: F.divider,
  },
  backButton: {
    width: 44,
    height: FEISHU_DIMENSIONS.titleBarHeight,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
