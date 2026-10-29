import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Dimensions, Keyboard, KeyboardAvoidingView, Platform, View, type ViewProps } from 'react-native';
import { readNativeKeyboardFrame } from 'laoji-native-platform';

type KeyboardFrameSnapshot = { visible: boolean; top: number };

export function keyboardOverlap(bottom: number, frame: KeyboardFrameSnapshot | null): number {
  return frame?.visible && Number.isFinite(bottom) && Number.isFinite(frame.top)
    ? Math.max(0, bottom - frame.top) : 0;
}

/** One measured frame: Android system IME insets, iOS platform avoidance. */
export function KeyboardFrame({ children, style, onLayout, ...props }: ViewProps) {
  const view = useRef<View | null>(null);
  const frame = useRef<KeyboardFrameSnapshot | null>(null);
  const generation = useRef(0);
  const [overlap, setOverlap] = useState(0);

  const measure = useCallback(() => {
    const request = generation.current;
    view.current?.measureInWindow((_x, y, _width, height) => {
      if (request === generation.current) setOverlap(keyboardOverlap(y + height, frame.current));
    });
  }, []);

  const refresh = useCallback(() => {
    const request = ++generation.current;
    void readNativeKeyboardFrame().then(next => {
      if (request !== generation.current) return;
      frame.current = next;
      measure();
    }).catch(() => { /* Preserve current geometry until the next real inset/layout event. */ });
  }, [measure]);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const shown = Keyboard.addListener('keyboardDidShow', refresh);
    const hidden = Keyboard.addListener('keyboardDidHide', () => {
      // Hidden means zero; Android's event.screenY is not the screen bottom.
      ++generation.current;
      frame.current = null;
      setOverlap(0);
    });
    const resized = Dimensions.addEventListener('change', refresh);
    refresh();
    return () => { ++generation.current; shown.remove(); hidden.remove(); resized.remove(); };
  }, [refresh]);

  if (Platform.OS !== 'android') {
    return <KeyboardAvoidingView {...props} style={style} onLayout={onLayout} behavior="padding">{children}</KeyboardAvoidingView>;
  }
  return (
    <View {...props} ref={view} style={[style, { paddingBottom: overlap }]} onLayout={event => {
      measure();
      onLayout?.(event);
    }}>{children}</View>
  );
}
