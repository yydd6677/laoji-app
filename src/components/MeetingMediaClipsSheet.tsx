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
import type { MeetingMediaClip } from '../domain/meeting';
import { getFeishuTokens } from '../theme/feishuTokens';

const MOTION_MS = 300;

function timeLabel(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function clipMeta(clip: MeetingMediaClip): string {
  const source = clip.sourceKind === 'marker' ? '标记' : '文字记录';
  const inclusions = [
    clip.includeSpeaker ? '讲话人' : null,
    clip.includeText ? '文字' : null,
  ].filter(Boolean).join('、');
  return `${source} · ${timeLabel(clip.startMs)}–${timeLabel(clip.endMs)}${inclusions ? ` · ${inclusions}` : ''}`;
}

export function MeetingMediaClipsSheet({
  visible,
  clips,
  loading,
  busyClipId,
  error,
  onClose,
  onOpenSource,
  onRetry,
  onShare,
  onDelete,
}: {
  visible: boolean;
  clips: readonly MeetingMediaClip[];
  loading: boolean;
  busyClipId: string | null;
  error: string;
  onClose: () => void;
  onOpenSource: (clip: MeetingMediaClip) => void;
  onRetry: (clip: MeetingMediaClip) => void;
  onShare: (clip: MeetingMediaClip) => void;
  onDelete: (clip: MeetingMediaClip) => void;
}) {
  const { colors } = getFeishuTokens();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const progress = useRef(new Animated.Value(0)).current;
  const mountedRef = useRef(visible);
  const closingRef = useRef(false);
  const closeRef = useRef(onClose);
  const [mounted, setMounted] = useState(visible);
  const [closing, setClosing] = useState(false);
  closeRef.current = onClose;

  const finishClose = useCallback((notify: boolean) => {
    if (!mountedRef.current || closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    progress.stopAnimation();
    Animated.timing(progress, { toValue: 0, duration: MOTION_MS, useNativeDriver: true })
      .start(({ finished }) => {
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
      Animated.timing(progress, { toValue: 1, duration: MOTION_MS, useNativeDriver: true }).start();
      return;
    }
    finishClose(false);
  }, [finishClose, progress, visible]);

  useEffect(() => () => progress.stopAnimation(), [progress]);
  if (!mounted) return null;
  const requestClose = () => { if (!busyClipId) finishClose(true); };

  return (
    <Modal visible transparent animationType="none" statusBarTranslucent onRequestClose={requestClose}>
      <View style={styles.root} accessibilityViewIsModal>
        <Animated.View style={[styles.backdrop, { backgroundColor: colors.backgroundMask, opacity: progress }]}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={requestClose}
            accessibilityRole="button"
            accessibilityLabel="关闭音频片段"
          />
        </Animated.View>
        <Animated.View
          pointerEvents={closing ? 'none' : 'auto'}
          style={[
            styles.sheet,
            {
              maxHeight: Math.min(height * 0.82, 720),
              paddingBottom: Math.max(12, insets.bottom),
              backgroundColor: colors.backgroundFloat,
              transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [height, 0] }) }],
            },
          ]}
        >
          <View style={[styles.titleBar, { borderBottomColor: colors.divider }]}>
            <Pressable
              style={({ pressed }) => [styles.titleAction, pressed && !busyClipId && { backgroundColor: colors.pressedFill }]}
              onPress={requestClose}
              disabled={Boolean(busyClipId)}
              accessibilityRole="button"
              accessibilityLabel="关闭音频片段"
            >
              <Ionicons name="close" size={24} color={busyClipId ? colors.iconDisabled : colors.iconPrimary} />
            </Pressable>
            <Text style={[styles.title, { color: colors.textTitle }]}>音频片段</Text>
            <View style={styles.titleAction} />
          </View>

          <ScrollView style={styles.list} showsVerticalScrollIndicator={false} bounces={false}>
            {loading && clips.length === 0 ? (
              <View style={styles.empty}><ActivityIndicator size="small" color={colors.primary} /></View>
            ) : clips.length === 0 ? (
              <View style={styles.empty}>
                <Text style={[styles.emptyText, { color: colors.textCaption }]}>暂无音频片段</Text>
              </View>
            ) : clips.filter(clip => clip.status !== 'deleting').map(clip => {
              const busy = Boolean(busyClipId);
              const showingProgress = busyClipId === clip.id || clip.status === 'pending';
              const ready = clip.status === 'ready';
              return (
                <View key={clip.id} style={[styles.row, { borderBottomColor: colors.divider }]}>
                  <View style={[styles.iconSlot, { backgroundColor: ready ? colors.primarySoft : colors.backgroundBase }]}>
                    {showingProgress ? <ActivityIndicator size="small" color={colors.primary} /> : (
                      <Ionicons name="musical-notes-outline" size={20} color={ready ? colors.primary : colors.iconDisabled} />
                    )}
                  </View>
                  <View style={styles.rowBody}>
                    <Text style={[styles.rowTitle, { color: colors.textTitle }]} numberOfLines={1}>
                      {timeLabel(clip.startMs)}–{timeLabel(clip.endMs)}
                    </Text>
                    <Text style={[styles.rowMeta, { color: clip.status === 'failed' ? colors.danger : colors.textCaption }]} numberOfLines={2}>
                      {clip.status === 'failed' ? '生成失败' : clip.status === 'pending' ? '正在生成' : clipMeta(clip)}
                    </Text>
                  </View>
                  {clip.status === 'failed' ? (
                    <IconAction
                      name="refresh-outline"
                      label="重试生成音频片段"
                      disabled={busy}
                      colors={colors}
                      onPress={() => onRetry(clip)}
                    />
                  ) : (
                    <>
                      <IconAction
                        name="locate-outline"
                        label="定位片段来源"
                        disabled={busy}
                        colors={colors}
                        onPress={() => onOpenSource(clip)}
                      />
                      <IconAction
                        name="share-social-outline"
                        label="分享音频片段"
                        disabled={!ready || busy}
                        colors={colors}
                        onPress={() => onShare(clip)}
                      />
                    </>
                  )}
                  <IconAction
                    name="trash-outline"
                    label="删除音频片段"
                    disabled={Boolean(busyClipId)}
                    colors={colors}
                    destructive
                    onPress={() => onDelete(clip)}
                  />
                </View>
              );
            })}
          </ScrollView>
          <View style={styles.errorSlot}>
            <Text style={[styles.errorText, { color: colors.danger }]} numberOfLines={2}>{error || ' '}</Text>
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

function IconAction({
  name,
  label,
  disabled,
  destructive = false,
  colors,
  onPress,
}: {
  name: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  disabled: boolean;
  destructive?: boolean;
  colors: ReturnType<typeof getFeishuTokens>['colors'];
  onPress: () => void;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.iconAction, pressed && !disabled && { backgroundColor: colors.pressedFill }]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
    >
      <Ionicons
        name={name}
        size={20}
        color={disabled ? colors.iconDisabled : destructive ? colors.danger : colors.iconSecondary}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject },
  sheet: { borderTopLeftRadius: 12, borderTopRightRadius: 12, overflow: 'hidden' },
  titleBar: { height: 52, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
  titleAction: { width: 60, height: 44, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, textAlign: 'center', fontSize: 17, lineHeight: 24, fontWeight: '400' },
  list: { flexGrow: 0, flexShrink: 1 },
  empty: { height: 144, alignItems: 'center', justifyContent: 'center' },
  emptyText: { fontSize: 14, lineHeight: 22 },
  row: { minHeight: 76, paddingLeft: 16, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
  iconSlot: { width: 36, height: 36, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  rowBody: { flex: 1, minWidth: 80, paddingHorizontal: 12, paddingVertical: 10 },
  rowTitle: { fontSize: 15, lineHeight: 22, fontWeight: '400', fontVariant: ['tabular-nums'] },
  rowMeta: { marginTop: 2, fontSize: 12, lineHeight: 18 },
  iconAction: { width: 44, height: 44, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  errorSlot: { minHeight: 34, paddingHorizontal: 16, justifyContent: 'center' },
  errorText: { fontSize: 12, lineHeight: 18 },
});
