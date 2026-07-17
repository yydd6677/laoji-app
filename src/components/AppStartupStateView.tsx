import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as SplashScreen from 'expo-splash-screen';
import {
  FEISHU_DIMENSIONS,
  FEISHU_FONT_SIZES,
  FEISHU_LIGHT_COLORS,
  FEISHU_RADII,
} from '../theme/feishuTokens';

export type AppStartupFailureStage =
  | 'authentication'
  | 'configuration'
  | 'navigation'
  | 'runtime';

export const UI_BOOT_READINESS_GEOMETRY = Object.freeze({
  visualSize: FEISHU_DIMENSIONS.startupStateVisualSize,
  copyMarginTop: 10,
  retryMarginTop: 16,
  retryWidth: FEISHU_DIMENSIONS.retryButtonWidth,
  retryHeight: FEISHU_DIMENSIONS.retryButtonHeight,
} as const);

const FAILURE_COPY: Record<AppStartupFailureStage, {
  description: string;
  code: string;
}> = {
  authentication: {
    description: '本机账号状态恢复超时，请重试。',
    code: 'LAOJI-START-AUTH',
  },
  configuration: {
    description: '应用配置不可用，请更新应用后重试。',
    code: 'LAOJI-START-CONFIG',
  },
  navigation: {
    description: '页面状态恢复超时，请重试。',
    code: 'LAOJI-START-NAV',
  },
  runtime: {
    description: '启动过程中出现异常，请重试。',
    code: 'LAOJI-START-RUNTIME',
  },
};

export async function releaseNativeSplash(): Promise<void> {
  try {
    await SplashScreen.hideAsync();
  } catch {
    // The rendered recovery surface remains usable when the native splash API is unavailable.
  }
}

export function AppStartupStateView({
  phase,
  failureStage = 'runtime',
  onRetry,
}: {
  phase: 'loading' | 'error';
  feishuEvidence?: string;
  failureStage?: AppStartupFailureStage;
  onRetry?: () => void;
}) {
  if (phase === 'loading') {
    return (
      <View
        style={styles.root}
        testID="app-startup-loading"
        accessibilityLiveRegion="polite"
      >
        <View
          style={styles.visualSlot}
          accessibilityElementsHidden
          testID="app-startup-visual"
        >
          <ActivityIndicator size="large" color={FEISHU_LIGHT_COLORS.primary} />
        </View>
        <Text style={styles.loadingText}>正在打开老记</Text>
      </View>
    );
  }

  const copy = FAILURE_COPY[failureStage];
  return (
    <View
      style={styles.root}
      testID="app-startup-error"
      accessibilityLiveRegion="assertive"
    >
      <View
        style={styles.visualSlot}
        accessibilityElementsHidden
        testID="app-startup-visual"
      >
        <Ionicons
          name="alert-circle-outline"
          size={56}
          color={FEISHU_LIGHT_COLORS.iconTertiary}
        />
      </View>
      <Text style={styles.errorTitle}>启动未完成</Text>
      <Text style={styles.errorDescription}>{copy.description}</Text>
      <Text style={styles.errorCode}>{`错误代码：${copy.code}`}</Text>
      {onRetry ? (
        <Pressable
          nativeID="feishu:UI-BOOT-READINESS-001:startup-retry"
          accessibilityRole="button"
          accessibilityLabel="重试"
          onPress={onRetry}
          style={({ pressed }) => [
            styles.retryButton,
            pressed && styles.retryButtonPressed,
          ]}
        >
          <Text style={styles.retryText}>重试</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    width: '100%',
    minHeight: 320,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    backgroundColor: FEISHU_LIGHT_COLORS.backgroundBody,
  },
  visualSlot: {
    width: UI_BOOT_READINESS_GEOMETRY.visualSize,
    height: UI_BOOT_READINESS_GEOMETRY.visualSize,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: {
    fontSize: FEISHU_FONT_SIZES.body1,
    lineHeight: 20,
    color: FEISHU_LIGHT_COLORS.textCaption,
    textAlign: 'center',
  },
  errorTitle: {
    marginTop: UI_BOOT_READINESS_GEOMETRY.copyMarginTop,
    fontSize: FEISHU_FONT_SIZES.body0,
    lineHeight: 22,
    fontWeight: '500',
    color: FEISHU_LIGHT_COLORS.textTitle,
    textAlign: 'center',
  },
  errorDescription: {
    maxWidth: 280,
    marginTop: 4,
    fontSize: FEISHU_FONT_SIZES.body1,
    lineHeight: 20,
    color: FEISHU_LIGHT_COLORS.textCaption,
    textAlign: 'center',
  },
  errorCode: {
    marginTop: 4,
    fontSize: FEISHU_FONT_SIZES.caption1,
    lineHeight: 18,
    color: FEISHU_LIGHT_COLORS.textPlaceholder,
    textAlign: 'center',
  },
  retryButton: {
    width: UI_BOOT_READINESS_GEOMETRY.retryWidth,
    height: UI_BOOT_READINESS_GEOMETRY.retryHeight,
    marginTop: UI_BOOT_READINESS_GEOMETRY.retryMarginTop,
    borderRadius: FEISHU_RADII.s,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: FEISHU_LIGHT_COLORS.primary,
  },
  retryButtonPressed: {
    backgroundColor: FEISHU_LIGHT_COLORS.primaryPressed,
  },
  retryText: {
    fontSize: FEISHU_FONT_SIZES.body0,
    lineHeight: 22,
    fontWeight: '500',
    color: FEISHU_LIGHT_COLORS.onPrimary,
    textAlign: 'center',
  },
});
