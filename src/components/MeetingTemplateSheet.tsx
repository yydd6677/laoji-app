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
import {
  MEETING_TEMPLATES,
  meetingTemplateSectionLabel,
  type MeetingTemplate,
} from '../domain/meeting';
import { getFeishuTokens } from '../theme/feishuTokens';

const MOTION_MS = 300;

export function MeetingTemplateSheet({
  visible,
  selectedTemplate,
  busy = false,
  onClose,
  onSelect,
}: {
  visible: boolean;
  selectedTemplate: Pick<MeetingTemplate, 'id' | 'revision'>;
  busy?: boolean;
  onClose: () => void;
  onSelect: (template: MeetingTemplate) => void;
}) {
  const { colors } = getFeishuTokens();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const progress = useRef(new Animated.Value(0)).current;
  const mountedRef = useRef(visible);
  const closingRef = useRef(false);
  const closeRef = useRef(onClose);
  const selectRef = useRef(onSelect);
  closeRef.current = onClose;
  selectRef.current = onSelect;
  const [mounted, setMounted] = useState(visible);
  const [closing, setClosing] = useState(false);

  const finishClose = useCallback((notify: boolean, afterExit?: () => void) => {
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
      afterExit?.();
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
  const requestSelect = (template: MeetingTemplate) => {
    if (busy) return;
    const select = selectRef.current;
    finishClose(true, () => select(template));
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
            accessibilityLabel="关闭整理模板"
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
            <Text style={[styles.title, { color: colors.textTitle }]}>整理模板</Text>
            <Pressable
              style={({ pressed }) => [
                styles.titleAction,
                pressed && !busy && { backgroundColor: colors.pressedFill },
              ]}
              onPress={requestClose}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="关闭整理模板"
              accessibilityState={{ disabled: busy }}
            >
              <Ionicons
                name="close"
                size={24}
                color={busy ? colors.iconDisabled : colors.iconPrimary}
              />
            </Pressable>
          </View>
          <ScrollView showsVerticalScrollIndicator={false} bounces={false}>
            {MEETING_TEMPLATES.map((template, index) => {
              const selected = template.id === selectedTemplate.id
                && template.revision === selectedTemplate.revision;
              return (
                <Pressable
                  key={`${template.id}@${template.revision}`}
                  style={({ pressed }) => [
                    styles.row,
                    index < MEETING_TEMPLATES.length - 1 && {
                      borderBottomColor: colors.divider,
                      borderBottomWidth: StyleSheet.hairlineWidth,
                    },
                    pressed && !busy && { backgroundColor: colors.pressedFill },
                  ]}
                  onPress={() => requestSelect(template)}
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityLabel={`${template.title}，${meetingTemplateSectionLabel(template)}`}
                  accessibilityState={{ selected, disabled: busy }}
                >
                  <View style={styles.rowBody}>
                    <Text
                      style={[styles.rowTitle, { color: selected ? colors.primary : colors.textTitle }]}
                      numberOfLines={1}
                    >
                      {template.title}
                    </Text>
                    <Text style={[styles.rowMeta, { color: colors.textCaption }]} numberOfLines={1}>
                      {meetingTemplateSectionLabel(template)}
                    </Text>
                  </View>
                  <View style={styles.rowStatus}>
                    {selected ? <Ionicons name="checkmark" size={22} color={colors.primary} /> : null}
                  </View>
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
  titleBar: { height: 52, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
  titleAction: { width: 60, height: 44, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, textAlign: 'center', fontSize: 17, lineHeight: 24, fontWeight: '500' },
  row: { minHeight: 72, paddingLeft: 16, paddingRight: 12, flexDirection: 'row', alignItems: 'center' },
  rowBody: { flex: 1, paddingVertical: 11 },
  rowTitle: { fontSize: 16, lineHeight: 24, fontWeight: '400' },
  rowMeta: { marginTop: 2, fontSize: 13, lineHeight: 20 },
  rowStatus: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
});
