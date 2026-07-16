import React, { useCallback, useEffect, useRef, useState } from 'react';
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
  const [closing, setClosing] = useState(false);
  const mountedRef = useRef(visible);
  const closingRef = useRef(false);
  const transitionRef = useRef(0);
  const onCloseRef = useRef(onClose);
  const contentRef = useRef({ title, items });
  onCloseRef.current = onClose;
  if (visible && !closingRef.current) contentRef.current = { title, items };

  const finishPresentation = useCallback((afterExit?: () => void) => {
    if (!mountedRef.current || closingRef.current) return;

    closingRef.current = true;
    setClosing(true);
    const transition = transitionRef.current + 1;
    transitionRef.current = transition;
    progress.stopAnimation();
    Animated.timing(progress, {
      toValue: 0,
      duration: ACTION_PANEL_GEOMETRY.animationDuration,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (!finished || transitionRef.current !== transition) return;

      mountedRef.current = false;
      closingRef.current = false;
      setMounted(false);
      setClosing(false);
      afterExit?.();
    });
  }, [progress]);

  useEffect(() => {
    if (visible) {
      transitionRef.current += 1;
      mountedRef.current = true;
      closingRef.current = false;
      setMounted(true);
      setClosing(false);
      progress.stopAnimation();
      progress.setValue(0);
      Animated.timing(progress, {
        toValue: 1,
        duration: ACTION_PANEL_GEOMETRY.animationDuration,
        useNativeDriver: true,
      }).start();
      return;
    }

    finishPresentation();
  }, [finishPresentation, progress, visible]);

  useEffect(() => () => {
    transitionRef.current += 1;
    progress.stopAnimation();
  }, [progress]);

  const requestClose = () => {
    finishPresentation(() => onCloseRef.current());
  };

  const runItem = (item: AppActionSheetItem) => {
    finishPresentation(() => {
      onCloseRef.current();
      item.onPress();
    });
  };

  if (!mounted) return null;
  const presented = contentRef.current;

  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={requestClose}
    >
      <View style={s.root} accessibilityViewIsModal>
        <Animated.View
          pointerEvents="auto"
          style={[s.backdrop, { opacity: progress }]}
          testID="app-action-sheet-backdrop"
        >
          <Pressable style={StyleSheet.absoluteFill} onPress={requestClose} accessibilityLabel="关闭菜单" />
        </Animated.View>
        <Animated.View
          pointerEvents={closing ? 'none' : 'auto'}
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
          accessibilityLabel={presented.title}
        >
          <View style={s.panel} testID="app-action-sheet-panel">
            <View style={s.header} testID="app-action-sheet-header">
              <Text style={s.title} numberOfLines={1} testID="app-action-sheet-title">{presented.title}</Text>
            </View>
            <View style={s.headerDivider} testID="app-action-sheet-header-divider" />
            {presented.items.map((item, index) => {
              const color = item.destructive ? C.red : C.text;
              return (
                <Pressable
                  key={item.key}
                  style={({ pressed }) => [s.item, pressed && s.itemPressed]}
                  onPress={() => runItem(item)}
                  disabled={closing}
                  accessibilityRole="menuitem"
                  accessibilityLabel={item.label}
                  testID={`app-action-sheet-item-${item.key}`}
                >
                  <Text style={[s.itemLabel, { color }]} numberOfLines={1}>{item.label}</Text>
                  {index < presented.items.length - 1 ? (
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
            onPress={requestClose}
            disabled={closing}
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
