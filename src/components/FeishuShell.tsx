import React from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  FEISHU_DIMENSIONS,
  FEISHU_FONT_SIZES,
  FEISHU_RADII,
  getFeishuTokens,
  type FeishuColorScheme,
} from '../theme/feishuTokens';

export const FEISHU_SHELL_GEOMETRY = Object.freeze({
  titleBarHeight: FEISHU_DIMENSIONS.titleBarHeight,
  titleLeadingSlotWidth: 56,
  titleTrailingSlotWidth: FEISHU_DIMENSIONS.saveActionWidth,
  viewBarHeight: FEISHU_DIMENSIONS.viewBarHeight,
  viewBarActionWidth: 50,
  fabSize: FEISHU_DIMENSIONS.fabSize,
  fabInset: FEISHU_DIMENSIONS.fabInset,
  emptyIllustrationSize: FEISHU_DIMENSIONS.emptyIllustrationSize,
  emptyCopyHeight: 64,
  retryButtonWidth: FEISHU_DIMENSIONS.retryButtonWidth,
  retryButtonHeight: FEISHU_DIMENSIONS.retryButtonHeight,
} as const);

type SchemeProp = {
  scheme?: FeishuColorScheme;
};

export function FeishuTitleBar({
  title,
  leading,
  trailing,
  scheme = 'light',
  testID = 'feishu-title-bar',
}: SchemeProp & {
  title: string;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  testID?: string;
}) {
  const { colors } = getFeishuTokens(scheme);

  return (
    <View
      style={[styles.titleBar, { backgroundColor: colors.backgroundBody }]}
      testID={testID}
    >
      <View style={styles.titleLeadingSlot} testID={`${testID}-leading`}>
        {leading}
      </View>
      <Text
        style={[styles.title, { color: colors.textTitle }]}
        numberOfLines={1}
        accessibilityRole="header"
        testID={`${testID}-title`}
      >
        {title}
      </Text>
      <View style={styles.titleTrailingSlot} testID={`${testID}-trailing`}>
        {trailing}
      </View>
    </View>
  );
}

export function FeishuViewBar({
  children,
  trailing,
  scheme = 'light',
  testID = 'feishu-view-bar',
}: SchemeProp & {
  children: React.ReactNode;
  trailing?: React.ReactNode;
  testID?: string;
}) {
  const { colors } = getFeishuTokens(scheme);

  return (
    <View
      style={[
        styles.viewBar,
        {
          backgroundColor: colors.backgroundBody,
          borderBottomColor: colors.divider,
        },
      ]}
      testID={testID}
    >
      <View style={styles.viewBarContent} testID={`${testID}-content`}>
        {children}
      </View>
      <View style={styles.viewBarTrailingSlot} testID={`${testID}-trailing`}>
        {trailing}
      </View>
    </View>
  );
}

export function FeishuFab({
  onPress,
  accessibilityLabel,
  icon,
  disabled = false,
  scheme = 'light',
  style,
  testID = 'feishu-fab',
}: SchemeProp & {
  onPress: () => void;
  accessibilityLabel: string;
  icon?: React.ReactNode;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const { colors } = getFeishuTokens(scheme);

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        styles.fab,
        {
          backgroundColor: disabled
            ? colors.primaryLoading
            : pressed
              ? colors.primaryPressed
              : colors.primary,
          shadowColor: colors.shadow,
        },
        style,
      ]}
      testID={testID}
    >
      {icon ?? <Ionicons name="add" size={28} color={colors.onPrimary} />}
    </Pressable>
  );
}

export function FeishuRetryButton({
  label = '重试',
  onPress,
  disabled = false,
  scheme = 'light',
  testID = 'feishu-retry-button',
}: SchemeProp & {
  label?: string;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
}) {
  const { colors } = getFeishuTokens(scheme);

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        styles.retryButton,
        {
          backgroundColor: pressed ? colors.pressedFill : colors.backgroundBody,
          borderColor: disabled ? colors.iconDisabled : colors.iconTertiary,
        },
      ]}
      testID={testID}
    >
      <Text
        style={[
          styles.retryLabel,
          { color: disabled ? colors.textDisabled : colors.textTitle },
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function FeishuEmptyState({
  illustration,
  title,
  description,
  retryLabel = '重试',
  onRetry,
  retryDisabled = false,
  accessibilityLabel,
  scheme = 'light',
  testID = 'feishu-empty-state',
}: SchemeProp & {
  illustration?: React.ReactNode;
  title?: string;
  description: string;
  retryLabel?: string;
  onRetry?: () => void;
  retryDisabled?: boolean;
  accessibilityLabel?: string;
  testID?: string;
}) {
  const { colors } = getFeishuTokens(scheme);
  const spokenLabel = accessibilityLabel ?? [title, description].filter(Boolean).join('，');

  return (
    <View
      style={styles.emptyState}
      testID={testID}
    >
      <View
        style={[
          styles.emptyIllustration,
          { backgroundColor: colors.backgroundBodyOverlay },
        ]}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        testID={`${testID}-illustration`}
      >
        {illustration}
      </View>
      <View
        style={styles.emptyCopySlot}
        accessible
        accessibilityLabel={spokenLabel}
        testID={`${testID}-copy-slot`}
      >
        {title ? (
          <Text
            style={[styles.emptyTitle, { color: colors.textTitle }]}
            numberOfLines={1}
          >
            {title}
          </Text>
        ) : null}
        <Text
          style={[styles.emptyDescription, { color: colors.textCaption }]}
          numberOfLines={2}
        >
          {description}
        </Text>
      </View>
      <View style={styles.emptyActionSlot} testID={`${testID}-action-slot`}>
        {onRetry ? (
          <FeishuRetryButton
            label={retryLabel}
            onPress={onRetry}
            disabled={retryDisabled}
            scheme={scheme}
            testID={`${testID}-retry`}
          />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  titleBar: {
    position: 'relative',
    width: '100%',
    height: FEISHU_SHELL_GEOMETRY.titleBarHeight,
    justifyContent: 'center',
  },
  titleLeadingSlot: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: FEISHU_SHELL_GEOMETRY.titleLeadingSlotWidth,
    height: FEISHU_SHELL_GEOMETRY.titleBarHeight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleTrailingSlot: {
    position: 'absolute',
    right: 0,
    top: 0,
    width: FEISHU_SHELL_GEOMETRY.titleTrailingSlotWidth,
    height: FEISHU_SHELL_GEOMETRY.titleBarHeight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    position: 'absolute',
    left: FEISHU_SHELL_GEOMETRY.titleTrailingSlotWidth,
    right: FEISHU_SHELL_GEOMETRY.titleTrailingSlotWidth,
    fontSize: FEISHU_FONT_SIZES.title3,
    lineHeight: 24,
    fontWeight: '600',
    textAlign: 'center',
  },
  viewBar: {
    position: 'relative',
    width: '100%',
    height: FEISHU_SHELL_GEOMETRY.viewBarHeight,
    borderBottomWidth: FEISHU_DIMENSIONS.divider,
    justifyContent: 'center',
  },
  viewBarContent: {
    height: FEISHU_SHELL_GEOMETRY.viewBarHeight,
    paddingLeft: 16,
    paddingRight: FEISHU_SHELL_GEOMETRY.viewBarActionWidth,
    justifyContent: 'center',
  },
  viewBarTrailingSlot: {
    position: 'absolute',
    right: 0,
    top: 0,
    width: FEISHU_SHELL_GEOMETRY.viewBarActionWidth,
    height: FEISHU_SHELL_GEOMETRY.viewBarHeight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fab: {
    width: FEISHU_SHELL_GEOMETRY.fabSize,
    height: FEISHU_SHELL_GEOMETRY.fabSize,
    borderRadius: FEISHU_SHELL_GEOMETRY.fabSize / 2,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.16,
    shadowRadius: 7,
    elevation: 6,
  },
  retryButton: {
    width: FEISHU_SHELL_GEOMETRY.retryButtonWidth,
    height: FEISHU_SHELL_GEOMETRY.retryButtonHeight,
    borderRadius: FEISHU_RADII.s,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  retryLabel: {
    maxWidth: '100%',
    fontSize: FEISHU_FONT_SIZES.body1,
    lineHeight: 20,
    fontWeight: '400',
    textAlign: 'center',
  },
  emptyState: {
    width: '100%',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  emptyIllustration: {
    width: FEISHU_SHELL_GEOMETRY.emptyIllustrationSize,
    height: FEISHU_SHELL_GEOMETRY.emptyIllustrationSize,
    borderRadius: FEISHU_RADII.l,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  emptyCopySlot: {
    width: '100%',
    maxWidth: 280,
    height: FEISHU_SHELL_GEOMETRY.emptyCopyHeight,
    marginTop: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTitle: {
    maxWidth: '100%',
    fontSize: FEISHU_FONT_SIZES.body0,
    lineHeight: 22,
    fontWeight: '600',
    textAlign: 'center',
  },
  emptyDescription: {
    maxWidth: '100%',
    fontSize: FEISHU_FONT_SIZES.body1,
    lineHeight: 20,
    fontWeight: '400',
    textAlign: 'center',
  },
  emptyActionSlot: {
    width: FEISHU_SHELL_GEOMETRY.retryButtonWidth,
    height: FEISHU_SHELL_GEOMETRY.retryButtonHeight,
    marginTop: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
