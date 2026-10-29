import React, { useRef, useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeProvider';

/** A separate help target; it never receives the setting's toggle callback. */
export function SettingsHelp({ label, text, testID }: { label: string; text: string; testID: string }) {
  const { tokens } = useTheme();
  const colors = tokens.colors;
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const anchor = useRef<View>(null);
  const [position, setPosition] = useState<{ x: number; y: number; bottom: number } | null>(null);
  const [bubbleHeight, setBubbleHeight] = useState(0);
  const bubbleWidth = Math.min(320, width - 32);
  const top = position && position.bottom + 6 + bubbleHeight > height - insets.bottom - 16
    ? Math.max(insets.top + 16, position.y - bubbleHeight - 6)
    : (position?.bottom ?? insets.top) + 6;
  const close = () => setPosition(null);
  return (
    <>
      <View ref={anchor} collapsable={false}>
        <Pressable
          accessibilityRole="button" accessibilityLabel={`${label}说明`}
          accessibilityState={{ expanded: position !== null }} testID={testID}
          style={s.trigger}
          onPress={() => anchor.current?.measureInWindow((x, y, _w, h) => {
            // Android measureInWindow excludes the status bar; this modal's
            // translucent window includes it. Keep both in the same space.
            const offset = Platform.OS === 'android' ? insets.top : 0;
            setPosition({ x, y: y + offset, bottom: y + h + offset });
          })}
        >
          <Ionicons name="help-circle-outline" size={18} color={colors.iconTertiary} />
        </Pressable>
      </View>
      <Modal visible={position !== null} transparent animationType="none"
        statusBarTranslucent navigationBarTranslucent onRequestClose={close}>
        <View style={s.overlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={close}
            accessibilityRole="button" accessibilityLabel="关闭说明" testID={`${testID}-dismiss`} />
          <View accessibilityViewIsModal
            onLayout={event => setBubbleHeight(event.nativeEvent.layout.height)}
            style={[s.bubble, { width: bubbleWidth, top,
              left: Math.max(16, Math.min(position?.x ?? 16, width - bubbleWidth - 16)),
              backgroundColor: colors.backgroundFloat, borderColor: colors.divider, shadowColor: colors.shadow }]}
            testID={`${testID}-bubble`}>
            <Text style={[s.text, { color: colors.textTitle }]}>{text}</Text>
          </View>
        </View>
      </Modal>
    </>
  );
}

const s = StyleSheet.create({
  trigger: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  overlay: { flex: 1 },
  bubble: { position: 'absolute', padding: 16, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth,
    elevation: 5, shadowOpacity: 0.14, shadowRadius: 8, shadowOffset: { width: 0, height: 2 } },
  text: { fontSize: 14, lineHeight: 22 },
});
