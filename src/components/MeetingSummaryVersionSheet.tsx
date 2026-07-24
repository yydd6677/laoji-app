import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getFeishuTokens } from '../theme/feishuTokens';

export interface MeetingSummaryVersionChoice {
  id: string;
  title: string;
  metadata: string;
  current: boolean;
}

const MOTION_MS = 300;

export function MeetingSummaryVersionSheet({
  visible,
  choices,
  loading,
  error,
  switchingId,
  onClose,
  onRetry,
  onSelect,
}: {
  visible: boolean;
  choices: readonly MeetingSummaryVersionChoice[];
  loading: boolean;
  error: string;
  switchingId: string | null;
  onClose: () => void;
  onRetry: () => void;
  onSelect: (versionId: string) => void;
}) {
  const { colors } = getFeishuTokens();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const progress = useRef(new Animated.Value(0)).current;
  const mountedRef = useRef(visible);
  const closingRef = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [mounted, setMounted] = useState(visible);
  const [closing, setClosing] = useState(false);
  const busy = loading || switchingId !== null;

  const finishClose = useCallback((notify: boolean) => {
    if (!mountedRef.current || closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    progress.stopAnimation();
    Animated.timing(progress, {
      toValue: 0,
      duration: MOTION_MS,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (!finished) return;
      mountedRef.current = false;
      closingRef.current = false;
      setMounted(false);
      setClosing(false);
      if (notify) closeRef.current();
    });
  }, [progress]);

  useEffect(() => {
    if (visible) {
      mountedRef.current = true;
      closingRef.current = false;
      setMounted(true);
      setClosing(false);
      progress.stopAnimation();
      progress.setValue(0);
      Animated.timing(progress, {
        toValue: 1,
        duration: MOTION_MS,
        useNativeDriver: true,
      }).start();
      return;
    }
    finishClose(false);
  }, [finishClose, progress, visible]);

  useEffect(() => () => progress.stopAnimation(), [progress]);

  if (!mounted) return null;
  const requestClose = () => {
    if (!busy) finishClose(true);
  };

  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={requestClose}
    >
      <View style={styles.root} accessibilityViewIsModal>
        <Animated.View
          style={[styles.backdrop, { backgroundColor: colors.backgroundMask, opacity: progress }]}
        >
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={requestClose}
            accessibilityLabel="关闭整理结果版本"
          />
        </Animated.View>
        <Animated.View
          style={[
            styles.sheet,
            {
              maxHeight: Math.min(height * 0.72, 620),
              paddingBottom: Math.max(12, insets.bottom),
              backgroundColor: colors.backgroundFloat,
              transform: [{
                translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [height, 0] }),
              }],
            },
          ]}
          pointerEvents={closing ? 'none' : 'auto'}
        >
          <View style={[styles.titleBar, { borderBottomColor: colors.divider }]}>
            <View style={styles.titleAction} />
            <Text style={[styles.title, { color: colors.textTitle }]}>整理结果版本</Text>
            <Pressable
              style={({ pressed }) => [
                styles.titleAction,
                pressed && { backgroundColor: colors.pressedFill },
              ]}
              onPress={requestClose}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="关闭整理结果版本"
              accessibilityState={{ disabled: busy }}
            >
              <Ionicons
                name="close"
                size={24}
                color={busy ? colors.iconDisabled : colors.iconPrimary}
              />
            </Pressable>
          </View>

          {loading && choices.length === 0 ? (
            <View style={styles.state}>
              <ActivityIndicator color={colors.primary} />
              <Text style={[styles.stateText, { color: colors.textCaption }]}>正在加载版本</Text>
            </View>
          ) : error ? (
            <View style={styles.state}>
              <Text style={[styles.stateText, { color: colors.danger }]}>{error}</Text>
              <Pressable
                style={({ pressed }) => [
                  styles.retry,
                  { backgroundColor: pressed ? colors.primaryPressed : colors.primary },
                ]}
                onPress={onRetry}
                accessibilityRole="button"
                accessibilityLabel="重试加载整理结果版本"
              >
                <Text style={[styles.retryText, { color: colors.onPrimary }]}>重试</Text>
              </Pressable>
            </View>
          ) : choices.length === 0 ? (
            <View style={styles.state}>
              <Text style={[styles.stateText, { color: colors.textCaption }]}>暂无可用版本</Text>
            </View>
          ) : (
            <ScrollView showsVerticalScrollIndicator={false} bounces={false}>
              {choices.map((choice, index) => {
                const switching = switchingId === choice.id;
                return (
                  <Pressable
                    key={choice.id}
                    style={({ pressed }) => [
                      styles.row,
                      index < choices.length - 1 && { borderBottomColor: colors.divider, borderBottomWidth: StyleSheet.hairlineWidth },
                      pressed && !choice.current && !busy && { backgroundColor: colors.pressedFill },
                    ]}
                    onPress={() => onSelect(choice.id)}
                    disabled={choice.current || busy}
                    accessibilityRole="button"
                    accessibilityLabel={`${choice.title}，${choice.metadata}`}
                    accessibilityState={{ selected: choice.current, disabled: choice.current || busy, busy: switching }}
                  >
                    <View style={styles.rowBody}>
                      <Text
                        style={[styles.rowTitle, { color: choice.current ? colors.primary : colors.textTitle }]}
                        numberOfLines={1}
                      >
                        {choice.title}
                      </Text>
                      <Text style={[styles.rowMeta, { color: colors.textCaption }]} numberOfLines={1}>
                        {choice.metadata}
                      </Text>
                    </View>
                    <View style={styles.rowStatus}>
                      {switching ? (
                        <ActivityIndicator color={colors.primary} />
                      ) : choice.current ? (
                        <Ionicons name="checkmark" size={22} color={colors.primary} />
                      ) : null}
                    </View>
                  </Pressable>
                );
              })}
            </ScrollView>
          )}
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject },
  sheet: { borderTopLeftRadius: 12, borderTopRightRadius: 12, overflow: 'hidden' },
  titleBar: { height: 52, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
  titleAction: { width: 60, height: 44, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, textAlign: 'center', fontSize: 17, lineHeight: 24, fontWeight: '500' },
  state: { minHeight: 150, paddingHorizontal: 24, alignItems: 'center', justifyContent: 'center', gap: 16 },
  stateText: { fontSize: 14, lineHeight: 22, textAlign: 'center' },
  retry: { width: 76, height: 36, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  retryText: { fontSize: 16, lineHeight: 24, fontWeight: '400' },
  row: { minHeight: 72, paddingLeft: 16, paddingRight: 12, flexDirection: 'row', alignItems: 'center' },
  rowBody: { flex: 1, paddingVertical: 11 },
  rowTitle: { fontSize: 16, lineHeight: 24, fontWeight: '400' },
  rowMeta: { marginTop: 2, fontSize: 13, lineHeight: 20 },
  rowStatus: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
});
