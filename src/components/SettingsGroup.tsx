import React from 'react';
import {
  StyleProp,
  StyleSheet,
  Text,
  TextStyle,
  View,
  ViewStyle,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { AppTitleBar } from './AppShell';
import { MotionPressable } from './MotionPressable';
import { useTheme } from '../theme/ThemeProvider';
import {
  UI_DIMENSIONS,
  UI_FONT_SIZES,
} from '../theme/uiTokens';

// UI-SHELL-001 / UI-TOKENS-001: settings pages share the 44dp shell and semantic rows.

export const SETTINGS_GROUP_GEOMETRY = {
  marginTop: 12,
  rowHeight: 52,
  avatarRowHeight: 64,
  horizontalPadding: 16,
  titleSize: UI_FONT_SIZES.body0,
  valueSize: UI_FONT_SIZES.body1,
  arrowSize: 16,
  divider: UI_DIMENSIONS.divider,
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
  const { tokens } = useTheme();
  const colors = tokens.colors;
  return (
    <AppTitleBar
      title={title}
      testID={testID}
      leading={(
        <MotionPressable
          style={s.backButton}
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="返回"
          testID={`${testID}-back`}
          feedback="quiet"
          pressedStyle={{ backgroundColor: colors.pressedFill }}
        >
          <Ionicons
            name="chevron-back"
            size={24}
            color={colors.iconPrimary}
            testID="app-back-icon"
          />
        </MotionPressable>
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
  const { tokens, appearance } = useTheme();
  const colors = tokens.colors;
  const flat = appearance.surfaceMode === 'flat';
  const editorial = appearance.surfaceMode === 'editorial';
  const layered = appearance.surfaceMode === 'layered';
  return (
    <View
      style={[
        s.group,
        {
          marginHorizontal: flat ? 0 : editorial ? 16 : 12,
          borderRadius: flat || editorial ? 0 : appearance.cardRadius,
          backgroundColor: layered
            ? colors.backgroundBodyOverlay
            : editorial || flat
              ? colors.backgroundBody
              : colors.backgroundFloat,
          borderWidth: flat || editorial ? 0 : appearance.borderWidth,
          borderColor: colors.divider,
          borderTopWidth: editorial ? StyleSheet.hairlineWidth : undefined,
          borderBottomWidth: editorial ? StyleSheet.hairlineWidth : undefined,
          shadowColor: appearance.shadowOpacity > 0 ? colors.shadow : undefined,
          shadowOpacity: appearance.surfaceMode === 'soft' ? appearance.shadowOpacity : 0,
          shadowRadius: appearance.surfaceMode === 'soft' ? appearance.shadowRadius : 0,
          elevation: appearance.surfaceMode === 'soft' ? appearance.elevation : 0,
        },
        style,
      ]}
      testID={testID}
    >
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
  const { tokens, appearance } = useTheme();
  const colors = tokens.colors;
  const rowBackground = appearance.surfaceMode === 'layered'
    ? colors.backgroundBodyOverlay
    : appearance.surfaceMode === 'soft'
      ? colors.backgroundFloat
      : colors.backgroundBody;
  const content = (
    <>
      <Text
        style={[
          s.label,
          { color: colors.textTitle },
          centered && s.centeredLabel,
          destructive && { color: colors.danger },
          labelStyle,
        ]}
        numberOfLines={2}
      >
        {label}
      </Text>
      {!centered ? (
        <View style={s.rightArea}>
          {value ? (
            <Text style={[s.value, { color: colors.textCaption }]} numberOfLines={1}>
              {value}
            </Text>
          ) : null}
          {right}
          {showChevron ? (
            <Ionicons
              name="chevron-forward"
              size={SETTINGS_GROUP_GEOMETRY.arrowSize}
              color={colors.iconTertiary}
            />
          ) : null}
        </View>
      ) : null}
      {!last ? (
        <View
          pointerEvents="none"
          style={[
            s.divider,
            {
              left: appearance.surfaceMode === 'editorial' ? 0 : SETTINGS_GROUP_GEOMETRY.horizontalPadding,
              backgroundColor: colors.divider,
            },
          ]}
        />
      ) : null}
    </>
  );

  const rowStyle = [
    s.row,
    { minHeight: height, backgroundColor: rowBackground },
    disabled && s.disabled,
    style,
  ];
  if (!onPress) {
    return <View style={rowStyle} testID={testID}>{content}</View>;
  }

  return (
    <MotionPressable
      style={rowStyle}
      onPress={onPress}
      pressedStyle={{ backgroundColor: colors.backgroundBodyOverlay }}
      feedback="quiet"
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled, ...(selected === undefined ? {} : { selected }) }}
      testID={testID}
    >
      {content}
    </MotionPressable>
  );
}

const s = StyleSheet.create({
  group: {
    marginTop: SETTINGS_GROUP_GEOMETRY.marginTop,
    overflow: 'hidden',
  },
  row: {
    position: 'relative',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SETTINGS_GROUP_GEOMETRY.horizontalPadding,
  },
  disabled: { opacity: 0.45 },
  label: {
    flexShrink: 1,
    maxWidth: 164,
    fontSize: SETTINGS_GROUP_GEOMETRY.titleSize,
    lineHeight: 22,
    fontWeight: '400',
  },
  centeredLabel: {
    flex: 1,
    maxWidth: '100%',
    textAlign: 'center',
  },
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
    flex: 1,
    minWidth: 0,
    paddingHorizontal: 1,
    fontSize: SETTINGS_GROUP_GEOMETRY.valueSize,
    lineHeight: 20,
    fontWeight: '400',
    textAlign: 'right',
  },
  divider: {
    position: 'absolute',
    left: SETTINGS_GROUP_GEOMETRY.horizontalPadding,
    right: 0,
    bottom: 0,
    height: SETTINGS_GROUP_GEOMETRY.divider,
  },
  backButton: {
    width: 44,
    height: UI_DIMENSIONS.titleBarHeight,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
