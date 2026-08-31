import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getUiTokens } from '../theme/uiTokens';

const MOTION_MS = 300;
const MAX_NAME_LENGTH = 120;

export interface MeetingSpeakerAssignmentValue {
  displayName: string;
  applyToCluster: boolean;
  speakerProfileId: string | null;
  consentToProfileUpdate: boolean;
}

export interface MeetingSpeakerAssignmentProfile {
  id: string;
  name: string;
}

interface PresentedSpeakerAssignment {
  targetKey: string;
  speakerLabel: string;
  clusterCount: number;
  candidates: readonly string[];
  profiles: readonly MeetingSpeakerAssignmentProfile[];
}

export function MeetingSpeakerAssignmentSheet({
  visible,
  targetKey,
  speakerLabel,
  clusterCount,
  candidates,
  profiles,
  profilesLoading,
  profilesError,
  saving,
  error,
  onClearError,
  onClose,
  onSave,
}: {
  visible: boolean;
  targetKey: string;
  speakerLabel: string;
  clusterCount: number;
  candidates: readonly string[];
  profiles: readonly MeetingSpeakerAssignmentProfile[];
  profilesLoading: boolean;
  profilesError: string;
  saving: boolean;
  error: string;
  onClearError: () => void;
  onClose: () => void;
  onSave: (value: MeetingSpeakerAssignmentValue) => void;
}) {
  const { colors } = getUiTokens();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const progress = useRef(new Animated.Value(0)).current;
  const mountedRef = useRef(visible);
  const closingRef = useRef(false);
  const closeRef = useRef(onClose);
  const presentedRef = useRef<PresentedSpeakerAssignment>({
    targetKey,
    speakerLabel,
    clusterCount,
    candidates,
    profiles,
  });
  closeRef.current = onClose;
  if (visible && !closingRef.current) {
    presentedRef.current = { targetKey, speakerLabel, clusterCount, candidates, profiles };
  }

  const [mounted, setMounted] = useState(visible);
  const [closing, setClosing] = useState(false);
  const [displayName, setDisplayName] = useState(speakerLabel);
  const [applyToCluster, setApplyToCluster] = useState(false);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [profileConsent, setProfileConsent] = useState(false);
  const [localError, setLocalError] = useState('');
  const [androidKeyboardInset, setAndroidKeyboardInset] = useState(0);

  const finishClose = useCallback((notify: boolean) => {
    if (!mountedRef.current || closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    Keyboard.dismiss();
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
      setDisplayName(speakerLabel.slice(0, MAX_NAME_LENGTH));
      setApplyToCluster(false);
      setSelectedProfileId(null);
      setProfileConsent(false);
      setLocalError('');
      setAndroidKeyboardInset(0);
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
  }, [finishClose, progress, speakerLabel, targetKey, visible]);

  useEffect(() => () => progress.stopAnimation(), [progress]);

  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    const shown = Keyboard.addListener('keyboardDidShow', event => {
      const inset = Math.max(0, height - event.endCoordinates.screenY);
      setAndroidKeyboardInset(Math.min(height, inset));
    });
    const hidden = Keyboard.addListener('keyboardDidHide', () => {
      setAndroidKeyboardInset(0);
    });
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, [height]);

  if (!mounted) return null;
  const presented = presentedRef.current;
  const normalizedName = displayName.normalize('NFKC').replace(/[\t ]+/g, ' ').trim();
  const initialName = presented.speakerLabel.normalize('NFKC').replace(/[\t ]+/g, ' ').trim();
  const candidateQuery = normalizedName === initialName ? '' : normalizedName;
  const canSave = normalizedName.length > 0
    && (!selectedProfileId || profileConsent)
    && !saving
    && !closing;
  const canBatch = presented.clusterCount > 1;
  const sheetHeight = Math.max(
    0,
    Math.min(600, height - androidKeyboardInset - Math.max(insets.top, 16)),
  );
  const visibleCandidates = presented.candidates.filter(candidate => {
    const normalizedCandidate = candidate.normalize('NFKC').trim();
    if (!normalizedCandidate || normalizedCandidate === normalizedName) return false;
    return !candidateQuery || normalizedCandidate.includes(candidateQuery);
  });

  const requestClose = () => {
    if (!saving) finishClose(true);
  };

  const updateName = (value: string) => {
    setDisplayName(value);
    setSelectedProfileId(null);
    setProfileConsent(false);
    setLocalError('');
    onClearError();
  };

  const submit = () => {
    if (!canSave) {
      setLocalError('请输入人名');
      return;
    }
    Keyboard.dismiss();
    onSave({
      displayName: normalizedName,
      applyToCluster: !selectedProfileId && canBatch && applyToCluster,
      speakerProfileId: selectedProfileId,
      consentToProfileUpdate: Boolean(selectedProfileId && profileConsent),
    });
  };

  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={requestClose}
    >
      <View style={styles.root} accessibilityViewIsModal>
        <Animated.View style={[styles.backdrop, { backgroundColor: colors.backgroundMask, opacity: progress }]}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={requestClose}
            accessibilityRole="button"
            accessibilityLabel="取消修改讲话人"
          />
        </Animated.View>
        <KeyboardAvoidingView
          style={[
            styles.keyboardHost,
            Platform.OS === 'android' ? { paddingBottom: androidKeyboardInset } : null,
          ]}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          pointerEvents={closing ? 'none' : 'auto'}
        >
          <Animated.View
            style={[
              styles.sheet,
              {
                height: sheetHeight,
                paddingBottom: insets.bottom,
                backgroundColor: colors.backgroundFloat,
                transform: [{
                  translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [height, 0] }),
                }],
              },
            ]}
          >
            <View style={styles.titleBar}>
              <Pressable
                style={({ pressed }) => [
                  styles.titleAction,
                  pressed && !saving && { backgroundColor: colors.pressedFill },
                ]}
                onPress={requestClose}
                disabled={saving}
                accessibilityRole="button"
                accessibilityLabel="取消修改讲话人"
                accessibilityState={{ disabled: saving }}
              >
                <Text style={[styles.titleActionText, { color: saving ? colors.textDisabled : colors.textTitle }]}>取消</Text>
              </Pressable>
              <Text style={[styles.title, { color: colors.textTitle }]}>修改讲话人</Text>
              <View style={styles.titleAction} />
            </View>

            <View
              style={[
                styles.inputFrame,
                {
                  backgroundColor: colors.backgroundBodyOverlay,
                  borderColor: (localError || error) ? colors.danger : 'transparent',
                },
              ]}
            >
              <Ionicons name="search" size={18} color={colors.iconTertiary} />
              <TextInput
                value={displayName}
                onChangeText={updateName}
                editable={!saving}
                maxLength={MAX_NAME_LENGTH}
                placeholder="输入人名"
                placeholderTextColor={colors.textPlaceholder}
                selectionColor={colors.primary}
                returnKeyType="done"
                onSubmitEditing={submit}
                style={[styles.input, { color: colors.textTitle }]}
                accessibilityLabel="输入人名"
              />
            </View>
            <View style={styles.errorSlot}>
              <Text style={[styles.errorText, { color: colors.danger }]} numberOfLines={1}>
                {localError || error}
              </Text>
            </View>

            <ScrollView
              style={styles.candidateList}
              keyboardDismissMode="on-drag"
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              bounces={false}
            >
              {presented.profiles.length > 0 || profilesLoading || profilesError ? (
                <Text style={[styles.sectionLabel, { color: colors.textCaption }]}>讲话人资料</Text>
              ) : null}
              {profilesLoading ? (
                <View style={styles.profileState}>
                  <ActivityIndicator size="small" color={colors.primary} />
                </View>
              ) : null}
              {!profilesLoading && profilesError ? (
                <Text style={[styles.profileError, { color: colors.textCaption }]} numberOfLines={2}>
                  {profilesError}
                </Text>
              ) : null}
              {presented.profiles.map(profile => {
                const selected = profile.id === selectedProfileId;
                return (
                  <Pressable
                    key={profile.id}
                    style={({ pressed }) => [
                      styles.candidate,
                      pressed && { backgroundColor: colors.pressedFill },
                    ]}
                    onPress={() => {
                      setDisplayName(profile.name.slice(0, MAX_NAME_LENGTH));
                      setSelectedProfileId(profile.id);
                      setProfileConsent(false);
                      setLocalError('');
                      onClearError();
                    }}
                    disabled={saving}
                    accessibilityRole="radio"
                    accessibilityLabel={`关联讲话人资料${profile.name}`}
                    accessibilityState={{ selected, disabled: saving }}
                  >
                    <View style={[styles.candidateAvatar, { backgroundColor: colors.backgroundBase }]}>
                      <Ionicons name="person" size={16} color={selected ? colors.primary : colors.iconSecondary} />
                    </View>
                    <Text style={[styles.candidateText, { color: colors.textTitle }]} numberOfLines={1}>
                      {profile.name}
                    </Text>
                    <Ionicons
                      name={selected ? 'checkmark-circle' : 'ellipse-outline'}
                      size={20}
                      color={selected ? colors.primary : colors.iconTertiary}
                    />
                  </Pressable>
                );
              })}
              {visibleCandidates.length > 0 ? (
                <Text style={[styles.sectionLabel, { color: colors.textCaption }]}>本场名称</Text>
              ) : null}
              {visibleCandidates.map(candidate => (
                <Pressable
                  key={candidate}
                  style={({ pressed }) => [
                    styles.candidate,
                    pressed && { backgroundColor: colors.pressedFill },
                  ]}
                  onPress={() => updateName(candidate)}
                  disabled={saving}
                  accessibilityRole="button"
                  accessibilityLabel={`使用人名${candidate}`}
                >
                  <View style={[styles.candidateAvatar, { backgroundColor: colors.backgroundBase }]}>
                    <Ionicons name="person" size={16} color={colors.iconSecondary} />
                  </View>
                  <Text style={[styles.candidateText, { color: colors.textTitle }]} numberOfLines={1}>
                    {candidate}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>

            <View style={[styles.bottomBar, { borderTopColor: colors.divider }]}>
              {selectedProfileId ? (
                <Pressable
                  style={({ pressed }) => [
                    styles.batchAction,
                    pressed && !saving && { backgroundColor: colors.pressedFill },
                  ]}
                  onPress={() => setProfileConsent(value => !value)}
                  disabled={saving}
                  accessibilityRole="checkbox"
                  accessibilityLabel="同意将本场讲话人关联用于以后会议识别"
                  accessibilityState={{ checked: profileConsent, disabled: saving }}
                >
                  <View
                    style={[
                      styles.checkbox,
                      {
                        borderColor: profileConsent ? colors.primary : colors.iconTertiary,
                        backgroundColor: profileConsent ? colors.primary : colors.backgroundFloat,
                      },
                    ]}
                  >
                    {profileConsent ? <Ionicons name="checkmark" size={14} color={colors.onPrimary} /> : null}
                  </View>
                  <Text style={[styles.batchText, { color: colors.textTitle }]} numberOfLines={2}>
                    用于以后会议识别
                  </Text>
                </Pressable>
              ) : canBatch ? (
                <Pressable
                  style={({ pressed }) => [
                    styles.batchAction,
                    pressed && !saving && { backgroundColor: colors.pressedFill },
                  ]}
                  onPress={() => setApplyToCluster(value => !value)}
                  disabled={saving}
                  accessibilityRole="checkbox"
                  accessibilityLabel={`同时修改本场${presented.clusterCount}处${presented.speakerLabel}`}
                  accessibilityState={{ checked: applyToCluster, disabled: saving }}
                >
                  <View
                    style={[
                      styles.checkbox,
                      {
                        borderColor: applyToCluster ? colors.primary : colors.iconTertiary,
                        backgroundColor: applyToCluster ? colors.primary : colors.backgroundFloat,
                      },
                    ]}
                  >
                    {applyToCluster ? <Ionicons name="checkmark" size={14} color={colors.onPrimary} /> : null}
                  </View>
                  <Text style={[styles.batchText, { color: colors.textTitle }]} numberOfLines={2}>
                    {`同时修改本场 ${presented.clusterCount} 处“${presented.speakerLabel}”`}
                  </Text>
                </Pressable>
              ) : <View style={styles.batchSpacer} />}
              <Pressable
                style={({ pressed }) => [
                  styles.doneButton,
                  {
                    backgroundColor: !canSave
                      ? colors.backgroundBase
                      : pressed ? colors.primaryPressed : colors.primary,
                  },
                ]}
                onPress={submit}
                disabled={!canSave}
                accessibilityRole="button"
                accessibilityLabel="完成修改讲话人"
                accessibilityState={{ disabled: !canSave, busy: saving }}
              >
                {saving ? (
                  <ActivityIndicator size="small" color={colors.onPrimary} />
                ) : (
                  <Text style={[styles.doneText, { color: canSave ? colors.onPrimary : colors.textDisabled }]}>完成</Text>
                )}
              </Pressable>
            </View>
          </Animated.View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject },
  keyboardHost: { flex: 1, justifyContent: 'flex-end' },
  sheet: { width: '100%', borderTopLeftRadius: 12, borderTopRightRadius: 12, overflow: 'hidden' },
  titleBar: { height: 52, flexDirection: 'row', alignItems: 'center' },
  titleAction: { width: 72, height: 44, alignItems: 'center', justifyContent: 'center' },
  titleActionText: { fontSize: 16, lineHeight: 24, fontWeight: '400' },
  title: { flex: 1, textAlign: 'center', fontSize: 17, lineHeight: 24, fontWeight: '400' },
  inputFrame: {
    height: 40,
    marginTop: 4,
    marginHorizontal: 16,
    paddingHorizontal: 12,
    borderRadius: 6,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  input: { flex: 1, height: 40, marginLeft: 8, paddingVertical: 0, fontSize: 16, lineHeight: 24 },
  errorSlot: { height: 30, paddingHorizontal: 16, justifyContent: 'center' },
  errorText: { fontSize: 12, lineHeight: 18 },
  candidateList: { flex: 1 },
  sectionLabel: { height: 32, paddingHorizontal: 16, paddingTop: 10, fontSize: 12, lineHeight: 18 },
  profileState: { height: 44, alignItems: 'center', justifyContent: 'center' },
  profileError: { minHeight: 44, paddingHorizontal: 16, paddingVertical: 10, fontSize: 13, lineHeight: 20 },
  candidate: { height: 52, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center' },
  candidateAvatar: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  candidateText: { flex: 1, marginLeft: 12, fontSize: 16, lineHeight: 24, fontWeight: '400' },
  bottomBar: { minHeight: 56, borderTopWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center' },
  batchAction: { minHeight: 55, flex: 1, paddingLeft: 12, paddingRight: 8, flexDirection: 'row', alignItems: 'center' },
  batchSpacer: { flex: 1 },
  checkbox: { width: 20, height: 20, borderRadius: 4, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  batchText: { flex: 1, marginLeft: 8, fontSize: 14, lineHeight: 20, fontWeight: '400' },
  doneButton: { minWidth: 60, height: 28, marginRight: 16, paddingHorizontal: 8, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  doneText: { fontSize: 14, lineHeight: 20, fontWeight: '400' },
});
