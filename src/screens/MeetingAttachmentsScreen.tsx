import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { useFocusEffect, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { AppActionSheet, type AppActionSheetItem } from '../components/AppActionSheet';
import { useAppDialog } from '../components/AppDialog';
import { ScreenContainer } from '../components/ScreenContainer';
import { SettingsTitleBar } from '../components/SettingsGroup';
import { subscribeMeetingAttachmentsChanged } from '../application/meeting/attachmentSyncTrigger';
import type { MeetingAttachmentRecord } from '../data/repositories';
import type { ScopeKey } from '../domain/meeting';
import { readableErrorMessage } from '../services/errors';
import {
  addMeetingImageAttachment,
  addMeetingTextAttachment,
  deleteMeetingAttachment,
  loadMeetingAttachments,
  retryMeetingAttachment,
} from '../services/meetingAttachments';
import { useAuth } from '../store/AuthStore';
import { getFeishuTokens } from '../theme/feishuTokens';
import type { RootStackParamList } from '../types';
import { formatNativeMinutesTimestamp } from '../native/nativeMinutesSnapshots';

const { colors: F } = getFeishuTokens();

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'MeetingAttachments'>;
  route: RouteProp<RootStackParamList, 'MeetingAttachments'>;
};

function imageSizeLabel(bytes: number | null): string {
  if (!bytes || bytes < 1) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function attachmentTime(positionMs: number): string {
  return formatNativeMinutesTimestamp(positionMs / 1_000);
}

export function MeetingAttachmentsScreen({ navigation, route }: Props) {
  const { isGuest, session } = useAuth();
  const { showDialog } = useAppDialog();
  const scopeKey = isGuest ? 'guest' as ScopeKey : session ? `user:${session.user.id}` as ScopeKey : null;
  const [items, setItems] = useState<readonly MeetingAttachmentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [addMenuVisible, setAddMenuVisible] = useState(false);
  const [textEditorVisible, setTextEditorVisible] = useState(false);
  const [draft, setDraft] = useState('');

  const markerAvailable = Boolean(
    route.params.markerId
    && Number.isSafeInteger(route.params.positionMs)
    && (route.params.positionMs ?? -1) >= 0,
  );

  const refresh = useCallback(async () => {
    if (!scopeKey) {
      setItems([]);
      setLoading(false);
      setError('当前无法读取会议附件。');
      return;
    }
    setLoading(true);
    setError('');
    try {
      setItems(await loadMeetingAttachments(scopeKey, route.params.meetingId));
    } catch (reason) {
      setItems([]);
      setError(readableErrorMessage(reason, '会议附件暂时无法读取，请稍后重试。'));
    } finally {
      setLoading(false);
    }
  }, [route.params.meetingId, scopeKey]);

  useFocusEffect(useCallback(() => {
    void refresh();
    if (!scopeKey) return undefined;
    return subscribeMeetingAttachmentsChanged(changedScope => {
      if (changedScope === scopeKey) void refresh();
    });
  }, [refresh, scopeKey]));

  const retrySync = async (attachment: MeetingAttachmentRecord) => {
    if (!scopeKey || scopeKey === 'guest' || retryingId) return;
    setRetryingId(attachment.id);
    try {
      const retried = await retryMeetingAttachment({
        scopeKey,
        navigationMeetingId: route.params.meetingId,
        attachmentId: attachment.id,
      });
      if (!retried) throw new Error('附件同步状态已变化，请刷新后重试。');
      await refresh();
    } catch (reason) {
      showDialog({
        title: '重试失败',
        message: readableErrorMessage(reason, '附件同步暂时无法重试，请稍后再试。'),
        tone: 'error',
      });
    } finally {
      setRetryingId(null);
    }
  };

  const addText = async () => {
    if (!scopeKey || !markerAvailable || !route.params.markerId || busy || !draft.trim()) return;
    setBusy(true);
    try {
      await addMeetingTextAttachment({
        scopeKey,
        navigationMeetingId: route.params.meetingId,
        markerId: route.params.markerId,
        positionMs: route.params.positionMs!,
        text: draft,
      });
      setDraft('');
      setTextEditorVisible(false);
      await refresh();
    } catch (reason) {
      showDialog({
        title: '文字附件未保存',
        message: readableErrorMessage(reason, '文字附件暂时未能保存，请稍后重试。'),
        tone: 'error',
      });
    } finally {
      setBusy(false);
    }
  };

  const pickImage = async () => {
    if (!scopeKey || !markerAvailable || !route.params.markerId || busy) return;
    setBusy(true);
    try {
      if (Platform.OS === 'ios') {
        const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!permission.granted) {
          showDialog({ title: '无法访问相册', message: '请在系统设置中允许老记访问照片后重试。', tone: 'warning' });
          return;
        }
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: 'images',
        allowsEditing: false,
        quality: 0.9,
        selectionLimit: 1,
      });
      const image = result.canceled ? null : result.assets?.[0] ?? null;
      if (!image?.uri) return;
      await addMeetingImageAttachment({
        scopeKey,
        navigationMeetingId: route.params.meetingId,
        markerId: route.params.markerId,
        positionMs: route.params.positionMs!,
        sourceUri: image.uri,
        fileName: image.fileName,
        mimeType: image.mimeType,
        byteSize: image.fileSize,
      });
      await refresh();
    } catch (reason) {
      showDialog({
        title: '照片附件未保存',
        message: readableErrorMessage(reason, '照片附件暂时未能保存，请稍后重试。'),
        tone: 'error',
      });
    } finally {
      setBusy(false);
    }
  };

  const requestDelete = (attachment: MeetingAttachmentRecord) => {
    if (!scopeKey || deletingId) return;
    showDialog({
      title: '删除附件？',
      message: scopeKey === 'guest'
        ? '附件会从本机删除，会议文字和整理结果不会改变。'
        : '附件会从当前账号的会议记录中删除，会议文字和整理结果不会改变。',
      tone: 'danger',
      actions: [
        {
          text: '删除',
          role: 'destructive',
          onPress: async () => {
            setDeletingId(attachment.id);
            try {
              const result = await deleteMeetingAttachment({
                scopeKey,
                navigationMeetingId: route.params.meetingId,
                attachmentId: attachment.id,
              });
              await refresh();
              if (result.cleanupFailed) {
                showDialog({
                  title: '附件已删除',
                  message: '附件记录已删除，但本机文件清理尚未完成。',
                  tone: 'warning',
                });
              }
            } catch (reason) {
              showDialog({
                title: '删除失败',
                message: readableErrorMessage(reason, '附件暂时未能删除，请稍后重试。'),
                tone: 'error',
              });
            } finally {
              setDeletingId(null);
            }
          },
        },
        { text: '取消', role: 'cancel' },
      ],
    });
  };

  const addItems = useMemo<AppActionSheetItem[]>(() => [
    { key: 'text', label: '添加文字', onPress: () => setTextEditorVisible(true) },
    { key: 'image', label: '从相册选择', onPress: () => { void pickImage(); } },
  ], [pickImage]);

  return (
    <ScreenContainer edges={['top', 'bottom']} bg={F.backgroundBase}>
      <SettingsTitleBar
        title="附件"
        onBack={() => navigation.goBack()}
        trailing={markerAvailable ? (
          <Pressable
            style={({ pressed }) => [styles.headerAction, pressed && { backgroundColor: F.pressedFill }]}
            onPress={() => setAddMenuVisible(true)}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="添加附件"
          >
            {busy ? <ActivityIndicator size="small" color={F.primary} /> : (
              <Ionicons name="add" size={24} color={F.iconPrimary} />
            )}
          </Pressable>
        ) : undefined}
      />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {markerAvailable ? (
          <Text style={[styles.context, { color: F.textCaption }]}>标记 {attachmentTime(route.params.positionMs!)}</Text>
        ) : null}

        {textEditorVisible ? (
          <View style={[styles.editor, { backgroundColor: F.backgroundFloat }]}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              editable={!busy}
              maxLength={500}
              multiline
              autoFocus
              placeholder="输入文字"
              placeholderTextColor={F.textPlaceholder}
              style={[styles.input, { color: F.textTitle, backgroundColor: F.backgroundFloatOverlay }]}
              accessibilityLabel="附件文字"
            />
            <View style={styles.editorActions}>
              <Pressable
                style={({ pressed }) => [styles.textAction, pressed && { backgroundColor: F.pressedFill }]}
                onPress={() => { setTextEditorVisible(false); setDraft(''); }}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="取消添加文字"
              >
                <Text style={[styles.textActionLabel, { color: F.textTitle }]}>取消</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [
                  styles.saveAction,
                  { backgroundColor: !draft.trim() || busy ? F.backgroundBase : pressed ? F.primaryPressed : F.primary },
                ]}
                onPress={() => { void addText(); }}
                disabled={!draft.trim() || busy}
                accessibilityRole="button"
                accessibilityLabel="保存文字附件"
              >
                <Text style={[styles.saveActionLabel, { color: !draft.trim() || busy ? F.textDisabled : F.onPrimary }]}>保存</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        {loading && items.length === 0 ? (
          <View style={styles.state}><ActivityIndicator size="small" color={F.primary} /></View>
        ) : error ? (
          <View style={styles.state}>
            <Text style={[styles.stateText, { color: F.danger }]}>{error}</Text>
            <Pressable style={styles.retry} onPress={() => { void refresh(); }} accessibilityRole="button">
              <Text style={[styles.retryText, { color: F.primary }]}>重试</Text>
            </Pressable>
          </View>
        ) : items.length === 0 ? (
          <View style={styles.state}><Text style={[styles.stateText, { color: F.textCaption }]}>暂无附件</Text></View>
        ) : (
          <View style={[styles.list, { backgroundColor: F.backgroundFloat }]}>
            {items.map((item, index) => (
              <View
                key={item.id}
                style={[
                  styles.row,
                  index < items.length - 1 && { borderBottomColor: F.divider, borderBottomWidth: StyleSheet.hairlineWidth },
                ]}
                accessibilityLabel={item.kind === 'text'
                  ? `文字附件，${item.textContent}，${attachmentTime(item.positionMs)}`
                  : `照片附件，${item.fileName}，${attachmentTime(item.positionMs)}`}
              >
                {item.kind === 'image' && item.localUri ? (
                  <Image source={{ uri: item.localUri }} style={styles.thumbnail} resizeMode="cover" />
                ) : (
                  <View style={[styles.textIcon, { backgroundColor: F.primarySoft }]}>
                    <Ionicons name="document-text-outline" size={22} color={F.primary} />
                  </View>
                )}
                <View style={styles.rowBody}>
                  <Text style={[styles.rowTitle, { color: F.textTitle }]} numberOfLines={2}>
                    {item.kind === 'text' ? item.textContent : item.fileName}
                  </Text>
                  <View style={styles.rowMetaLine}>
                    <Text style={[styles.rowMeta, { color: F.textCaption }]} numberOfLines={1}>
                      {attachmentTime(item.positionMs)}{item.kind === 'image' ? `  ·  ${imageSizeLabel(item.byteSize)}` : ''}
                      {item.syncState === 'pending' ? '  ·  同步中' : ''}
                      {item.syncState === 'failed_retryable' || item.syncState === 'blocked' ? '  ·  同步失败' : ''}
                    </Text>
                    {scopeKey !== 'guest' && (
                      item.syncState === 'failed_retryable' || item.syncState === 'blocked'
                    ) ? (
                      <Pressable
                        style={({ pressed }) => [styles.syncRetry, pressed && { backgroundColor: F.pressedFill }]}
                        onPress={() => { void retrySync(item); }}
                        disabled={retryingId !== null}
                        accessibilityRole="button"
                        accessibilityLabel="重试同步附件"
                      >
                        {retryingId === item.id ? (
                          <ActivityIndicator size="small" color={F.primary} />
                        ) : (
                          <Text style={[styles.syncRetryText, { color: F.primary }]}>重试</Text>
                        )}
                      </Pressable>
                    ) : null}
                  </View>
                </View>
                <Pressable
                  style={({ pressed }) => [styles.deleteAction, pressed && { backgroundColor: F.pressedFill }]}
                  onPress={() => requestDelete(item)}
                  disabled={deletingId !== null}
                  accessibilityRole="button"
                  accessibilityLabel={`删除${item.kind === 'text' ? '文字' : '照片'}附件`}
                >
                  {deletingId === item.id ? <ActivityIndicator size="small" color={F.danger} /> : (
                    <Ionicons name="trash-outline" size={20} color={F.danger} />
                  )}
                </Pressable>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
      <AppActionSheet
        visible={addMenuVisible}
        title="添加附件"
        items={addItems}
        onClose={() => setAddMenuVisible(false)}
      />
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  headerAction: { width: 44, height: 44, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  scroll: { flex: 1 },
  content: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 32 },
  context: { fontSize: 13, lineHeight: 20, marginBottom: 8 },
  editor: { borderRadius: 8, padding: 12, marginBottom: 12 },
  input: { minHeight: 92, maxHeight: 180, borderRadius: 6, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, lineHeight: 24, textAlignVertical: 'top' },
  editorActions: { height: 48, marginTop: 8, flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center' },
  textAction: { minWidth: 76, height: 36, borderRadius: 6, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  textActionLabel: { fontSize: 16, lineHeight: 22, fontWeight: '400' },
  saveAction: { minWidth: 76, height: 36, marginLeft: 8, borderRadius: 6, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  saveActionLabel: { fontSize: 16, lineHeight: 22, fontWeight: '400' },
  state: { minHeight: 180, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  stateText: { fontSize: 14, lineHeight: 22, textAlign: 'center' },
  retry: { minWidth: 72, minHeight: 44, marginTop: 8, alignItems: 'center', justifyContent: 'center' },
  retryText: { fontSize: 16, lineHeight: 22 },
  list: { borderRadius: 8, overflow: 'hidden' },
  row: { minHeight: 88, paddingLeft: 12, flexDirection: 'row', alignItems: 'center' },
  thumbnail: { width: 64, height: 64, borderRadius: 6 },
  textIcon: { width: 48, height: 48, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  rowBody: { flex: 1, minWidth: 0, paddingHorizontal: 12, paddingVertical: 10 },
  rowTitle: { fontSize: 16, lineHeight: 22, fontWeight: '400' },
  rowMetaLine: { minHeight: 28, marginTop: 4, flexDirection: 'row', alignItems: 'center' },
  rowMeta: { flexShrink: 1, fontSize: 13, lineHeight: 18 },
  syncRetry: { minWidth: 48, minHeight: 44, marginLeft: 4, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  syncRetryText: { fontSize: 14, lineHeight: 20, fontWeight: '400' },
  deleteAction: { width: 48, height: 48, marginRight: 4, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
});
