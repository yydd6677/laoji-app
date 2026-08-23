import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
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
import type { MeetingSummaryCitation } from '../domain/meeting';
import { getFeishuTokens } from '../theme/feishuTokens';

const MOTION_MS = 240;

function clockLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function citationTitle(citation: MeetingSummaryCitation): string {
  if (citation.sourceType === 'manual_note') return '我的笔记';
  if (citation.sourceType === 'attachment') return citation.sourceLabel?.trim() || '附件';
  const speaker = citation.sourceLabel?.trim();
  return speaker ? `${speaker} · ${clockLabel(citation.startMs)}` : clockLabel(citation.startMs);
}

export function MeetingSummaryEvidenceSheet({
  visible,
  sectionTitle,
  citations,
  onClose,
  onOpenCitation,
}: {
  visible: boolean;
  sectionTitle: string;
  citations: readonly MeetingSummaryCitation[];
  onClose: () => void;
  onOpenCitation: (citation: MeetingSummaryCitation) => void;
}) {
  const { colors } = getFeishuTokens();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const progress = useRef(new Animated.Value(0)).current;
  const mountedRef = useRef(visible);
  const closingRef = useRef(false);
  const closeRef = useRef(onClose);
  const openRef = useRef(onOpenCitation);
  closeRef.current = onClose;
  openRef.current = onOpenCitation;
  const [mounted, setMounted] = useState(visible);

  const finishClose = useCallback((notify: boolean, afterExit?: () => void) => {
    if (!mountedRef.current || closingRef.current) return;
    closingRef.current = true;
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
      if (afterExit) afterExit();
      else if (notify) closeRef.current();
    });
  }, [progress]);

  useEffect(() => {
    if (visible) {
      mountedRef.current = true;
      closingRef.current = false;
      setMounted(true);
      progress.stopAnimation();
      progress.setValue(0);
      Animated.timing(progress, { toValue: 1, duration: MOTION_MS, useNativeDriver: true }).start();
      return;
    }
    finishClose(false);
  }, [finishClose, progress, visible]);

  useEffect(() => () => progress.stopAnimation(), [progress]);

  if (!mounted) return null;
  const requestClose = () => finishClose(true);

  return (
    <Modal visible transparent animationType="none" statusBarTranslucent onRequestClose={requestClose}>
      <View style={styles.root} accessibilityViewIsModal>
        <Animated.View style={[styles.backdrop, { backgroundColor: colors.backgroundMask, opacity: progress }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={requestClose} accessibilityLabel="关闭整理依据" />
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
        >
          <View style={[styles.titleBar, { borderBottomColor: colors.divider }]}>
            <View style={styles.titleAction} />
            <View style={styles.titleBody}>
              <Text style={[styles.title, { color: colors.textTitle }]} numberOfLines={1}>整理依据</Text>
              <Text style={[styles.subtitle, { color: colors.textCaption }]} numberOfLines={1}>{sectionTitle}</Text>
            </View>
            <Pressable
              style={({ pressed }) => [styles.titleAction, pressed && { backgroundColor: colors.pressedFill }]}
              onPress={requestClose}
              accessibilityRole="button"
              accessibilityLabel="关闭整理依据"
            >
              <Ionicons name="close" size={24} color={colors.iconPrimary} />
            </Pressable>
          </View>
          <ScrollView showsVerticalScrollIndicator={false} bounces={false}>
            {citations.map((citation, index) => {
              const seekable = citation.sourceType === undefined || citation.sourceType === 'transcript';
              return (
                <Pressable
                  key={citation.id}
                  style={({ pressed }) => [
                    styles.row,
                    index < citations.length - 1 && {
                      borderBottomColor: colors.divider,
                      borderBottomWidth: StyleSheet.hairlineWidth,
                    },
                    pressed && seekable && { backgroundColor: colors.pressedFill },
                  ]}
                  disabled={!seekable}
                  onPress={() => {
                    const selected = citation;
                    finishClose(true, () => openRef.current(selected));
                  }}
                  accessibilityRole={seekable ? 'button' : 'text'}
                  accessibilityLabel={`${citationTitle(citation)}${seekable ? '，跳到文字记录' : ''}`}
                  accessibilityState={{ disabled: !seekable }}
                >
                  <View style={styles.rowBody}>
                    <Text style={[styles.rowTitle, { color: colors.textTitle }]}>{citationTitle(citation)}</Text>
                    {citation.excerpt?.trim() ? (
                      <Text style={[styles.excerpt, { color: colors.textCaption }]} numberOfLines={4}>
                        {citation.excerpt.trim()}
                      </Text>
                    ) : null}
                  </View>
                  {seekable ? <Ionicons name="chevron-forward" size={18} color={colors.iconSecondary} /> : null}
                </Pressable>
              );
            })}
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject },
  sheet: { borderTopLeftRadius: 12, borderTopRightRadius: 12, overflow: 'hidden' },
  titleBar: { minHeight: 58, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
  titleAction: { width: 60, height: 48, alignItems: 'center', justifyContent: 'center' },
  titleBody: { flex: 1, alignItems: 'center', paddingVertical: 7 },
  title: { fontSize: 17, lineHeight: 23, fontWeight: '500', textAlign: 'center' },
  subtitle: { marginTop: 1, fontSize: 12, lineHeight: 17, textAlign: 'center' },
  row: { minHeight: 72, paddingLeft: 16, paddingRight: 14, flexDirection: 'row', alignItems: 'center' },
  rowBody: { flex: 1, paddingVertical: 11 },
  rowTitle: { fontSize: 14, lineHeight: 21, fontWeight: '500' },
  excerpt: { marginTop: 3, fontSize: 14, lineHeight: 21 },
});
