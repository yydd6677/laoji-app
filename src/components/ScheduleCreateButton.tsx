import React from 'react';
import { StyleSheet } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTheme } from '../theme/ThemeProvider';
import { MotionPressable } from './MotionPressable';

/** One create intent. Input methods live inside the shared editor. */
export function ScheduleCreateButton({ bottom, onPress }: { bottom: number; onPress: () => void }) {
  const { colors: C, appearance } = useTheme();
  return <MotionPressable style={[s.button, { bottom, backgroundColor: C.primary, borderRadius: appearance.primaryActionRadius }]}
    onPress={onPress} accessibilityRole="button" accessibilityLabel="新建日程" testID="schedule-create">
    <Ionicons name="add" size={30} color={C.body} />
  </MotionPressable>;
}

const s = StyleSheet.create({
  button: { position: 'absolute', right: 18, width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
});
