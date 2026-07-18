import React, { useEffect, useRef } from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  FEISHU_DIMENSIONS,
  FEISHU_FONT_SIZES,
  FEISHU_RADII,
  getFeishuTokens,
  type FeishuColorScheme,
  type FeishuSemanticColors,
} from '../theme/feishuTokens';

export type FeishuHostLifecycle = 'active' | 'inactive' | 'background';
export type FeishuOverlayActionRole = 'primary' | 'secondary' | 'destructive';

export type FeishuOverlayAction = Readonly<{
  key: string;
  label: string;
  role: FeishuOverlayActionRole;
  onPress: () => void;
  disabled?: boolean;
}>;

export type FeishuToastAction = Readonly<{
  label: string;
  onPress: () => void;
  disabled?: boolean;
}>;

export const FEISHU_OVERLAY_GEOMETRY = Object.freeze({
  toastMaxWidth: FEISHU_DIMENSIONS.toastMaxWidth,
  toastActionMaxWidth: FEISHU_DIMENSIONS.toastActionMaxWidth,
  toastMinHeight: 40,
  dialogMaxWidth: FEISHU_DIMENSIONS.dialogMaxWidth,
  dialogBodyHeight: 144,
  dialogActionHeight: FEISHU_DIMENSIONS.dialogActionHeight,
  sheetMaxWidth: FEISHU_DIMENSIONS.sheetMaxWidth,
  sheetEdgeMargin: FEISHU_DIMENSIONS.sheetEdgeMargin,
  sheetHeaderHeight: FEISHU_DIMENSIONS.sheetHeaderHeight,
  sheetItemHeight: FEISHU_DIMENSIONS.sheetItemHeight,
  sheetCancelHeight: FEISHU_DIMENSIONS.sheetCancelHeight,
  sheetCancelGap: 12,
} as const);

function actionColor(
  role: FeishuOverlayActionRole,
  colors: FeishuSemanticColors,
  disabled = false,
) {
  if (disabled) return colors.textDisabled;
  if (role === 'primary') return colors.primary;
  if (role === 'destructive') return colors.danger;
  return colors.textTitle;
}

export function FeishuToast({
  nativeID,
  visible,
  message,
  onDismiss,
  action,
  hostVisible = true,
  lifecycleState = 'active',
  autoHideDurationMs = 3000,
  bottom = 80,
  scheme = 'light',
  testID = 'feishu-toast',
}: {
  // CAL-REPEAT-RRULE-001: evidence is carried by the actual native toast layer.
  nativeID?: string;
  visible: boolean;
  message: string;
  onDismiss: () => void;
  action?: FeishuToastAction;
  hostVisible?: boolean;
  lifecycleState?: FeishuHostLifecycle;
  autoHideDurationMs?: number | null;
  bottom?: number;
  scheme?: FeishuColorScheme;
  testID?: string;
}) {
  const { colors } = getFeishuTokens(scheme);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const presented = visible && hostVisible && lifecycleState === 'active';

  useEffect(() => {
    if (!presented || autoHideDurationMs === null) return undefined;
    const timeout = setTimeout(
      () => onDismissRef.current(),
      Math.max(0, autoHideDurationMs),
    );
    return () => clearTimeout(timeout);
  }, [autoHideDurationMs, message, presented]);

  if (!presented) return null;

  const runAction = () => {
    action?.onPress();
    onDismissRef.current();
  };

  return (
    <View
      nativeID={nativeID}
      pointerEvents="box-none"
      style={[styles.toastLayer, { bottom }]}
      testID={`${testID}-layer`}
    >
      <View
        style={[styles.toast, { backgroundColor: colors.backgroundTips }]}
        testID={testID}
      >
        <Text
          style={[styles.toastMessage, { color: colors.onTips }]}
          numberOfLines={2}
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          accessibilityLabel={message}
        >
          {message}
        </Text>
        {action ? (
          <Pressable
            onPress={runAction}
            disabled={action.disabled}
            accessibilityRole="button"
            accessibilityLabel={action.label}
            accessibilityState={{ disabled: Boolean(action.disabled) }}
            hitSlop={10}
            style={[
              styles.toastAction,
              { borderLeftColor: 'rgba(255,255,255,0.20)' },
            ]}
            testID={`${testID}-action`}
          >
            <Text
              style={[
                styles.toastActionLabel,
                { color: action.disabled ? colors.textDisabled : colors.primaryPressed },
              ]}
              numberOfLines={1}
            >
              {action.label}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

export function FeishuDialog({
  visible,
  title,
  message,
  actions,
  onRequestClose,
  scheme = 'light',
  testID = 'feishu-dialog',
}: {
  visible: boolean;
  title: string;
  message?: string;
  actions: readonly FeishuOverlayAction[];
  onRequestClose: () => void;
  scheme?: FeishuColorScheme;
  testID?: string;
}) {
  const { colors } = getFeishuTokens(scheme);
  if (!visible) return null;

  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={onRequestClose}
    >
      <View
        style={[styles.dialogBackdrop, { backgroundColor: colors.backgroundMask }]}
        accessibilityViewIsModal
        testID={`${testID}-backdrop`}
      >
        <View
          style={[
            styles.dialogCard,
            {
              backgroundColor: colors.backgroundFloat,
              shadowColor: colors.shadow,
            },
          ]}
          accessibilityRole="alert"
          accessibilityLabel={[title, message].filter(Boolean).join('，')}
          testID={testID}
        >
          <View style={styles.dialogBody} testID={`${testID}-body`}>
            <View style={styles.dialogTitleSlot}>
              <Text
                style={[styles.dialogTitle, { color: colors.textTitle }]}
                numberOfLines={2}
              >
                {title}
              </Text>
            </View>
            <View style={styles.dialogMessageSlot}>
              {message ? (
                <Text
                  style={[styles.dialogMessage, { color: colors.textCaption }]}
                  numberOfLines={3}
                >
                  {message}
                </Text>
              ) : null}
            </View>
          </View>
          <View
            style={[styles.dialogActions, { borderTopColor: colors.divider }]}
            testID={`${testID}-actions`}
          >
            {actions.map((action, index) => (
              <Pressable
                key={action.key}
                onPress={action.onPress}
                disabled={action.disabled}
                accessibilityRole="button"
                accessibilityLabel={action.label}
                accessibilityState={{ disabled: Boolean(action.disabled) }}
                style={[
                  styles.dialogAction,
                  index > 0 && {
                    borderLeftWidth: FEISHU_DIMENSIONS.divider,
                    borderLeftColor: colors.divider,
                  },
                ]}
                testID={`${testID}-action-${action.key}`}
              >
                <Text
                  style={[
                    styles.dialogActionLabel,
                    { color: actionColor(action.role, colors, action.disabled) },
                  ]}
                  numberOfLines={2}
                >
                  {action.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      </View>
    </Modal>
  );
}

export function FeishuSheet({
  visible,
  title,
  actions,
  onRequestClose,
  presentationAllowed = true,
  cancelLabel = '取消',
  bottomInset = 0,
  scheme = 'light',
  testID = 'feishu-sheet',
}: {
  visible: boolean;
  title: string;
  actions: readonly FeishuOverlayAction[];
  onRequestClose: () => void;
  presentationAllowed?: boolean;
  cancelLabel?: string;
  bottomInset?: number;
  scheme?: FeishuColorScheme;
  testID?: string;
}) {
  const { colors } = getFeishuTokens(scheme);
  if (!visible || !presentationAllowed) return null;

  const runAction = (action: FeishuOverlayAction) => {
    onRequestClose();
    action.onPress();
  };

  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={onRequestClose}
    >
      <View style={styles.sheetRoot} accessibilityViewIsModal>
        <Pressable
          style={[styles.sheetBackdrop, { backgroundColor: colors.backgroundMask }]}
          onPress={onRequestClose}
          accessibilityRole="button"
          accessibilityLabel="关闭菜单"
          testID={`${testID}-backdrop`}
        />
        <View
          style={[
            styles.sheetFrame,
            { paddingBottom: bottomInset + FEISHU_OVERLAY_GEOMETRY.sheetEdgeMargin },
          ]}
          accessibilityRole="menu"
          accessibilityLabel={title}
          testID={testID}
        >
          <View
            style={[styles.sheetPanel, { backgroundColor: colors.backgroundFloat }]}
            testID={`${testID}-panel`}
          >
            <View style={styles.sheetHeader} testID={`${testID}-header`}>
              <Text
                style={[styles.sheetTitle, { color: colors.textPlaceholder }]}
                numberOfLines={1}
              >
                {title}
              </Text>
            </View>
            <View style={[styles.divider, { backgroundColor: colors.divider }]} />
            {actions.map((action, index) => (
              <Pressable
                key={action.key}
                onPress={() => runAction(action)}
                disabled={action.disabled}
                accessibilityRole="menuitem"
                accessibilityLabel={action.label}
                accessibilityState={{ disabled: Boolean(action.disabled) }}
                style={({ pressed }) => [
                  styles.sheetItem,
                  {
                    backgroundColor: pressed
                      ? colors.backgroundFloatOverlay
                      : colors.backgroundFloat,
                  },
                ]}
                testID={`${testID}-action-${action.key}`}
              >
                <Text
                  style={[
                    styles.sheetItemLabel,
                    { color: actionColor(action.role, colors, action.disabled) },
                  ]}
                  numberOfLines={1}
                >
                  {action.label}
                </Text>
                {index < actions.length - 1 ? (
                  <View
                    pointerEvents="none"
                    style={[styles.sheetItemDivider, { backgroundColor: colors.divider }]}
                  />
                ) : null}
              </Pressable>
            ))}
          </View>
          <Pressable
            onPress={onRequestClose}
            accessibilityRole="button"
            accessibilityLabel={cancelLabel}
            style={({ pressed }) => [
              styles.sheetCancel,
              {
                backgroundColor: pressed
                  ? colors.backgroundFloatOverlay
                  : colors.backgroundFloat,
              },
            ]}
            testID={`${testID}-cancel`}
          >
            <Text style={[styles.sheetCancelLabel, { color: colors.textTitle }]}>
              {cancelLabel}
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  toastLayer: {
    position: 'absolute',
    left: 16,
    right: 16,
    zIndex: 100,
    alignItems: 'center',
  },
  toast: {
    width: '100%',
    maxWidth: FEISHU_OVERLAY_GEOMETRY.toastMaxWidth,
    minHeight: FEISHU_OVERLAY_GEOMETRY.toastMinHeight,
    borderRadius: FEISHU_RADII.m,
    paddingLeft: 20,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    overflow: 'hidden',
  },
  toastMessage: {
    flex: 1,
    minWidth: 0,
    paddingRight: 20,
    fontSize: FEISHU_FONT_SIZES.body1,
    lineHeight: 20,
    fontWeight: '400',
  },
  toastAction: {
    width: FEISHU_OVERLAY_GEOMETRY.toastActionMaxWidth,
    alignSelf: 'stretch',
    borderLeftWidth: 1,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toastActionLabel: {
    maxWidth: '100%',
    fontSize: FEISHU_FONT_SIZES.body1,
    lineHeight: 20,
    fontWeight: '600',
    textAlign: 'center',
  },
  dialogBackdrop: {
    flex: 1,
    paddingHorizontal: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dialogCard: {
    width: '100%',
    maxWidth: FEISHU_OVERLAY_GEOMETRY.dialogMaxWidth,
    borderRadius: FEISHU_RADII.m,
    overflow: 'hidden',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 10,
  },
  dialogBody: {
    width: '100%',
    height: FEISHU_OVERLAY_GEOMETRY.dialogBodyHeight,
    paddingHorizontal: 20,
    paddingVertical: 12,
    alignItems: 'center',
  },
  dialogTitleSlot: {
    width: '100%',
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dialogTitle: {
    maxWidth: '100%',
    fontSize: FEISHU_FONT_SIZES.title3,
    lineHeight: 24,
    fontWeight: '600',
    textAlign: 'center',
  },
  dialogMessageSlot: {
    width: '100%',
    height: 72,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dialogMessage: {
    maxWidth: '100%',
    fontSize: FEISHU_FONT_SIZES.body1,
    lineHeight: 20,
    fontWeight: '400',
    textAlign: 'center',
  },
  dialogActions: {
    width: '100%',
    minHeight: FEISHU_OVERLAY_GEOMETRY.dialogActionHeight,
    borderTopWidth: FEISHU_DIMENSIONS.divider,
    flexDirection: 'row',
  },
  dialogAction: {
    flex: 1,
    minWidth: 0,
    minHeight: FEISHU_OVERLAY_GEOMETRY.dialogActionHeight,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dialogActionLabel: {
    maxWidth: '100%',
    fontSize: FEISHU_FONT_SIZES.body1,
    lineHeight: 20,
    fontWeight: '600',
    textAlign: 'center',
  },
  sheetRoot: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheetBackdrop: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  },
  sheetFrame: {
    width: '100%',
    paddingHorizontal: FEISHU_OVERLAY_GEOMETRY.sheetEdgeMargin,
  },
  sheetPanel: {
    width: '100%',
    maxWidth: FEISHU_OVERLAY_GEOMETRY.sheetMaxWidth,
    alignSelf: 'center',
    borderRadius: FEISHU_RADII.l,
    overflow: 'hidden',
  },
  sheetHeader: {
    height: FEISHU_OVERLAY_GEOMETRY.sheetHeaderHeight,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetTitle: {
    maxWidth: '100%',
    fontSize: FEISHU_FONT_SIZES.body1,
    lineHeight: 20,
    fontWeight: '400',
    textAlign: 'center',
  },
  divider: {
    width: '100%',
    height: FEISHU_DIMENSIONS.divider,
  },
  sheetItem: {
    position: 'relative',
    width: '100%',
    height: FEISHU_OVERLAY_GEOMETRY.sheetItemHeight,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetItemLabel: {
    maxWidth: '100%',
    fontSize: FEISHU_FONT_SIZES.title3,
    lineHeight: 24,
    fontWeight: '400',
    textAlign: 'center',
  },
  sheetItemDivider: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: FEISHU_DIMENSIONS.divider,
  },
  sheetCancel: {
    width: '100%',
    maxWidth: FEISHU_OVERLAY_GEOMETRY.sheetMaxWidth,
    height: FEISHU_OVERLAY_GEOMETRY.sheetCancelHeight,
    marginTop: FEISHU_OVERLAY_GEOMETRY.sheetCancelGap,
    alignSelf: 'center',
    borderRadius: FEISHU_RADII.l,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetCancelLabel: {
    maxWidth: '100%',
    fontSize: FEISHU_FONT_SIZES.title3,
    lineHeight: 24,
    fontWeight: '400',
    textAlign: 'center',
  },
});
