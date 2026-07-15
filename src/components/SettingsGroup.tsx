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
import { Colors as C } from '../theme/colors';

export const SETTINGS_GROUP_GEOMETRY = {
  marginHorizontal: 16,
  marginTop: 16,
  radius: 10,
  rowHeight: 54,
  avatarRowHeight: 64,
  horizontalPadding: 16,
  titleSize: 16,
  valueSize: 14,
  arrowSize: 16,
} as const;

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
              color={C.faint}
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
    backgroundColor: C.body,
  },
  row: {
    position: 'relative',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SETTINGS_GROUP_GEOMETRY.horizontalPadding,
    backgroundColor: C.body,
  },
  disabled: { opacity: 0.45 },
  label: {
    flexShrink: 1,
    maxWidth: 164,
    fontSize: SETTINGS_GROUP_GEOMETRY.titleSize,
    lineHeight: 22,
    fontWeight: '400',
    color: C.text,
  },
  centeredLabel: {
    flex: 1,
    maxWidth: '100%',
    textAlign: 'center',
  },
  destructiveLabel: { color: C.red },
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
    color: C.faint,
  },
  divider: {
    position: 'absolute',
    left: SETTINGS_GROUP_GEOMETRY.horizontalPadding,
    right: 0,
    bottom: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: C.divider,
  },
});
