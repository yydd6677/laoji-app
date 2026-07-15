import React, { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useEvents } from '../store/EventsStore';
import { useAppDialog } from './AppDialog';
import { Colors as C } from '../theme/colors';
import { BOTTOM_TAB_BAR_GEOMETRY, getBottomTabBarFloatingTopInset } from './BottomTabBar';

export function EventUndoBanner() {
  const { lastDeleted, undoDelete } = useEvents();
  const { showDialog } = useAppDialog();
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);

  if (!lastDeleted) return null;

  const handleUndo = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await undoDelete();
    } catch {
      showDialog({ title: '撤销失败', message: '日程未能恢复，请检查网络后重试。', tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <View
      style={[
        s.banner,
        {
          bottom: getBottomTabBarFloatingTopInset(insets.bottom)
            + BOTTOM_TAB_BAR_GEOMETRY.floatingOverlayGap,
        },
      ]}
      accessibilityRole="alert"
      testID="event-undo-banner"
    >
      <Ionicons name="trash-outline" size={17} color="#fff" />
      <Text style={s.text} numberOfLines={1}>已删除“{lastDeleted.title}”</Text>
      <TouchableOpacity
        onPress={() => { void handleUndo(); }}
        disabled={busy}
        style={s.undoButton}
        accessibilityRole="button"
        accessibilityLabel="撤销删除日程"
      >
        <Text style={s.undoText}>{busy ? '恢复中' : '撤销'}</Text>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  banner: {
    position: 'absolute',
    left: 16,
    right: 76,
    minHeight: 50,
    zIndex: 50,
    elevation: 6,
    borderRadius: 6,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: C.text,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.16,
    shadowRadius: 7,
  },
  text: { flex: 1, color: '#fff', fontSize: 13, fontWeight: '500' },
  undoButton: { minWidth: 52, minHeight: 36, alignItems: 'center', justifyContent: 'center' },
  undoText: { color: '#8FB4FF', fontSize: 13, fontWeight: '600' },
});
