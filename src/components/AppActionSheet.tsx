import React, { useEffect, useRef, useState } from 'react';
import { Animated, Modal, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors as C } from '../theme/colors';

export const ACTION_PANEL_GEOMETRY = {
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
} as const;

export type AppActionSheetItem = {
  key: string;
  label: string;
  destructive?: boolean;
  onPress: () => void;
};

export function AppActionSheet({
  visible,
  title,
  items,
  onClose,
}: {
  visible: boolean;
  title: string;
  items: AppActionSheetItem[];
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const progress = useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = useState(visible);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      progress.stopAnimation();
      Animated.timing(progress, {
        toValue: 1,
        duration: ACTION_PANEL_GEOMETRY.animationDuration,
        useNativeDriver: true,
      }).start();
      return;
    }

    if (!mounted) return;
    progress.stopAnimation();
    Animated.timing(progress, {
      toValue: 0,
      duration: ACTION_PANEL_GEOMETRY.animationDuration,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) setMounted(false);
    });
  }, [mounted, progress, visible]);

  const runItem = (item: AppActionSheetItem) => {
    onClose();
    item.onPress();
  };

  return (
    <Modal
      visible={mounted}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={s.root}>
        <Animated.View style={[s.backdrop, { opacity: progress }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="关闭菜单" />
        </Animated.View>
        <Animated.View
          style={[
            s.frame,
            {
              paddingBottom: insets.bottom + ACTION_PANEL_GEOMETRY.edgeMargin,
              opacity: progress,
              transform: [{
                translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [windowHeight, 0] }),
              }],
            },
          ]}
          accessibilityRole="menu"
          accessibilityLabel={title}
          accessibilityViewIsModal
        >
          <View style={s.panel} testID="app-action-sheet-panel">
            <View style={s.header} testID="app-action-sheet-header">
              <Text style={s.title} numberOfLines={1} testID="app-action-sheet-title">{title}</Text>
            </View>
            <View style={s.headerDivider} testID="app-action-sheet-header-divider" />
            {items.map((item, index) => {
              const color = item.destructive ? C.red : C.text;
              return (
                <Pressable
                  key={item.key}
                  style={({ pressed }) => [s.item, pressed && s.itemPressed]}
                  onPress={() => runItem(item)}
                  accessibilityRole="menuitem"
                  accessibilityLabel={item.label}
                  testID={`app-action-sheet-item-${item.key}`}
                >
                  <Text style={[s.itemLabel, { color }]} numberOfLines={1}>{item.label}</Text>
                  {index < items.length - 1 ? (
                    <View
                      pointerEvents="none"
                      style={s.itemDivider}
                      testID={`app-action-sheet-item-divider-${item.key}`}
                    />
                  ) : null}
                </Pressable>
              );
            })}
          </View>
          <Pressable
            style={({ pressed }) => [s.cancel, pressed && s.itemPressed]}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="取消"
            testID="app-action-sheet-cancel"
          >
            <Text style={s.cancelText}>取消</Text>
          </Pressable>
        </Animated.View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: C.overlay },
  frame: {
    width: '100%',
    alignSelf: 'center',
    paddingHorizontal: ACTION_PANEL_GEOMETRY.edgeMargin,
  },
  panel: {
    width: '100%',
    maxWidth: ACTION_PANEL_GEOMETRY.maxWidth,
    alignSelf: 'center',
    overflow: 'hidden',
    borderRadius: ACTION_PANEL_GEOMETRY.radius,
    backgroundColor: C.body,
  },
  header: {
    height: ACTION_PANEL_GEOMETRY.titleHeight,
    paddingHorizontal: ACTION_PANEL_GEOMETRY.titleHorizontalPadding,
    paddingVertical: ACTION_PANEL_GEOMETRY.titleVerticalPadding,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { maxWidth: '100%', fontSize: ACTION_PANEL_GEOMETRY.titleSize, lineHeight: 20, fontWeight: '400', color: C.faint, textAlign: 'center' },
  headerDivider: { height: ACTION_PANEL_GEOMETRY.dividerHeight, backgroundColor: C.divider },
  item: {
    position: 'relative',
    minHeight: ACTION_PANEL_GEOMETRY.itemHeight,
    paddingHorizontal: ACTION_PANEL_GEOMETRY.itemHorizontalPadding,
    paddingVertical: ACTION_PANEL_GEOMETRY.itemVerticalPadding,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.body,
  },
  itemPressed: { backgroundColor: C.inputBg },
  itemLabel: { maxWidth: '100%', fontSize: ACTION_PANEL_GEOMETRY.itemSize, lineHeight: 24, fontWeight: '400', textAlign: 'center' },
  itemDivider: { position: 'absolute', left: 0, right: 0, bottom: 0, height: ACTION_PANEL_GEOMETRY.dividerHeight, backgroundColor: C.divider },
  cancel: {
    width: '100%',
    maxWidth: ACTION_PANEL_GEOMETRY.maxWidth,
    alignSelf: 'center',
    height: ACTION_PANEL_GEOMETRY.cancelHeight,
    borderRadius: ACTION_PANEL_GEOMETRY.radius,
    backgroundColor: C.body,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: ACTION_PANEL_GEOMETRY.cancelGap,
  },
  cancelText: { fontSize: ACTION_PANEL_GEOMETRY.itemSize, lineHeight: 24, fontWeight: '400', color: C.text },
});
