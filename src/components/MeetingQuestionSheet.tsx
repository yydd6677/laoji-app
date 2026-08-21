import { Ionicons } from '@expo/vector-icons';
import React, { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type {
  MeetingQuestionCitation,
  MeetingQuestionTurn,
  MeetingSummaryAttachmentAuthorization,
  ScopeKey,
} from '../domain/meeting';
import type { MeetingAttachmentRecord } from '../data/repositories';
import { MeetingSummaryAttachmentSheet } from './MeetingSummaryAttachmentSheet';
import { readableErrorMessage } from '../services/errors';
import { authorizeMeetingQuestionAttachments } from '../services/meetingQuestionAttachments';
import { loadMeetingAttachments } from '../services/meetingAttachments';
import {
  askMeetingQuestion,
  MeetingQuestionEvidenceChangedError,
  isMeetingQuestionCitationCurrent,
  prepareMeetingQuestionSession,
  type MeetingQuestionSession,
} from '../services/meetingQuestions';
import { Q2EvidenceChangedError } from '../services/meetingQuestionsQ2';
import { beginSummaryV3InteractiveWork } from '../services/meetingSummaryV3Upgrade';
import { getFeatureFlags } from '../config/featureFlags';
import { getFeishuTokens } from '../theme/feishuTokens';

const MOTION_MS = 300;

export type MeetingQuestionCitationTarget =
  | {
    kind: 'transcript';
    meetingId: string;
    transcriptRevisionId: string;
    segmentId: string;
    positionMs: number;
  }
  | {
    kind: 'summary';
    meetingId: string;
    transcriptRevisionId: string;
    summaryVersionId: string | null;
    sectionId: string;
  }
  | {
    kind: 'manual_note';
    meetingId: string;
    transcriptRevisionId: string;
    manualNoteRevision: number | null;
    revision: number;
  }
  | {
    kind: 'attachment';
    meetingId: string;
    transcriptRevisionId: string;
    attachmentId: string;
    attachmentRevisionId: string;
    positionMs: number;
  };

function citationTarget(
  citation: MeetingQuestionCitation,
  session: MeetingQuestionSession,
): MeetingQuestionCitationTarget {
  if (citation.kind === 'transcript') {
    return {
      kind: 'transcript',
      meetingId: session.evidence.meetingId,
      transcriptRevisionId: session.evidence.transcriptRevisionId,
      segmentId: citation.segmentId,
      positionMs: citation.startMs,
    };
  }
  if (citation.kind === 'summary') {
    return {
      kind: 'summary',
      meetingId: session.evidence.meetingId,
      transcriptRevisionId: session.evidence.transcriptRevisionId,
      summaryVersionId: session.evidence.summaryVersionId,
      sectionId: citation.sectionId,
    };
  }
  if (citation.kind === 'attachment') {
    return {
      kind: 'attachment',
      meetingId: session.evidence.meetingId,
      transcriptRevisionId: session.evidence.transcriptRevisionId,
      attachmentId: citation.attachmentId,
      attachmentRevisionId: citation.attachmentRevisionId,
      positionMs: citation.positionMs,
    };
  }
  return {
    kind: 'manual_note',
    meetingId: session.evidence.meetingId,
    transcriptRevisionId: session.evidence.transcriptRevisionId,
    manualNoteRevision: session.evidence.manualNoteRevision,
    revision: citation.manualNoteRevision,
  };
}

function QuestionTurnView({
  turn,
  onCitation,
}: {
  turn: MeetingQuestionTurn;
  onCitation: (citation: MeetingQuestionCitation) => void;
}) {
  const { colors } = getFeishuTokens();
  const [citationsExpanded, setCitationsExpanded] = useState(false);
  return (
    <View style={styles.turn} testID={`meeting-question-turn-${turn.ordinal}`}>
      <View style={[styles.questionBubble, { backgroundColor: colors.primarySoft }]}>
        <Text selectable style={[styles.questionText, { color: colors.textTitle }]}>{turn.question}</Text>
      </View>
      <View style={[styles.answerCard, { backgroundColor: colors.backgroundFloat }]}>
        <Text selectable style={[styles.answerText, { color: colors.textTitle }]}>{turn.answer}</Text>
        {turn.citations.length > 0 ? (
          <View style={styles.citations}>
            <Pressable
              testID={`meeting-question-citations-toggle-${turn.ordinal}`}
              style={({ pressed }) => [
                styles.citationsToggle,
                { backgroundColor: pressed ? colors.pressedFill : colors.backgroundFloatOverlay },
              ]}
              onPress={() => setCitationsExpanded(expanded => !expanded)}
              accessibilityRole="button"
              accessibilityLabel={`${citationsExpanded ? '收起' : '展开'}${turn.citations.length}条引用`}
              accessibilityState={{ expanded: citationsExpanded }}
            >
              <Ionicons name="link-outline" size={15} color={colors.textLink} />
              <Text style={[styles.citationsToggleLabel, { color: colors.textLink }]}>
                {`引用 ${turn.citations.length} 条`}
              </Text>
              <Ionicons
                name={citationsExpanded ? 'chevron-up' : 'chevron-down'}
                size={15}
                color={colors.iconTertiary}
              />
            </Pressable>
            {citationsExpanded ? turn.citations.map(citation => (
              <Pressable
                key={citation.id}
                style={({ pressed }) => [
                  styles.citation,
                  { backgroundColor: pressed ? colors.pressedFill : colors.backgroundFloatOverlay },
                ]}
                onPress={() => onCitation(citation)}
                accessibilityRole="button"
                accessibilityLabel={`查看来源：${citation.sourceLabel}`}
              >
                <View style={styles.citationTitleRow}>
                  <Ionicons name="link-outline" size={15} color={colors.textLink} />
                  <Text style={[styles.citationLabel, { color: colors.textLink }]} numberOfLines={1}>
                    {citation.sourceLabel}
                  </Text>
                  <Ionicons name="chevron-forward" size={14} color={colors.iconTertiary} />
                </View>
                <Text style={[styles.citationExcerpt, { color: colors.textCaption }]} numberOfLines={2}>
                  {citation.sourceExcerpt}
                </Text>
              </Pressable>
            )) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

function PendingQuestionView({ question }: { question: string }) {
  const { colors } = getFeishuTokens();
  return (
    <View
      style={styles.turn}
      testID="meeting-question-pending-turn"
      accessibilityLiveRegion="polite"
    >
      <View style={[styles.questionBubble, { backgroundColor: colors.primarySoft }]}>
        <Text selectable style={[styles.questionText, { color: colors.textTitle }]}>{question}</Text>
      </View>
      <View style={[styles.answerCard, styles.loadingAnswer, { backgroundColor: colors.backgroundFloat }]}>
        <ActivityIndicator size="small" color={colors.primary} />
        <Text style={[styles.loadingAnswerText, { color: colors.textCaption }]}>正在回答</Text>
      </View>
    </View>
  );
}

/**
 * [INFERENCE] LaoJi-only Minutes secondary page. The title bar, state hierarchy,
 * input geometry, tokens and motion follow the nearest Feishu page families.
 */
export function MeetingQuestionSheet({
  visible,
  meetingTitle,
  meetingId,
  scopeKey,
  accessToken,
  onClose,
  onOpenCitation,
}: {
  visible: boolean;
  meetingTitle: string;
  meetingId: string;
  scopeKey: ScopeKey | null;
  accessToken?: string | null;
  onClose: () => void;
  onOpenCitation: (target: MeetingQuestionCitationTarget) => void;
}) {
  const { colors } = getFeishuTokens();
  const questionAttachmentsEnabled = getFeatureFlags().meetingQuestionsQ2Candidate;
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const progress = useRef(new Animated.Value(0)).current;
  const listRef = useRef<FlatList<MeetingQuestionTurn> | null>(null);
  const inputRef = useRef<TextInput | null>(null);
  const closeRef = useRef(onClose);
  const citationRef = useRef(onOpenCitation);
  const mountedRef = useRef(visible);
  const closingRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const requestControllerRef = useRef<AbortController | null>(null);
  const [mounted, setMounted] = useState(visible);
  const [closing, setClosing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [session, setSession] = useState<MeetingQuestionSession | null>(null);
  const [draft, setDraft] = useState('');
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [attachmentSheetVisible, setAttachmentSheetVisible] = useState(false);
  const [attachmentLoading, setAttachmentLoading] = useState(false);
  const [attachments, setAttachments] = useState<readonly MeetingAttachmentRecord[]>([]);
  closeRef.current = onClose;
  citationRef.current = onOpenCitation;

  const finishClose = useCallback((notify: boolean, afterExit?: () => void) => {
    if (!mountedRef.current || closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    Keyboard.dismiss();
    requestControllerRef.current?.abort();
    setAttachmentSheetVisible(false);
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

  const loadSession = useCallback(async (
    includeManualNote: boolean,
    forceNew = false,
    attachmentAuthorization?: MeetingSummaryAttachmentAuthorization | null,
  ) => {
    if (!scopeKey) {
      setSession(null);
      setError('登录状态尚未准备好，请稍后重试。');
      return;
    }
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    // A visible sheet can survive while the parent detail route changes.
    // Clear the old session before the asynchronous read so its answers and
    // citations cannot be mistaken for the new meeting's evidence.
    requestControllerRef.current?.abort();
    setSession(null);
    setPendingQuestion(null);
    setSending(false);
    setLoading(true);
    setError('');
    setStatus('');
    try {
      const next = await prepareMeetingQuestionSession({
        scopeKey,
        navigationMeetingId: meetingId,
        includeManualNote,
        attachmentAuthorization,
        forceNew,
      });
      if (!mountedRef.current || loadGenerationRef.current !== generation) return;
      setSession(next);
    } catch (reason) {
      if (!mountedRef.current || loadGenerationRef.current !== generation) return;
      setSession(null);
      setError(readableErrorMessage(reason, '会议问答暂时无法打开，请稍后重试。'));
    } finally {
      if (mountedRef.current && loadGenerationRef.current === generation) setLoading(false);
    }
  }, [meetingId, scopeKey]);

  useEffect(() => {
    if (visible) {
      mountedRef.current = true;
      closingRef.current = false;
      setMounted(true);
      setClosing(false);
      setDraft('');
      setPendingQuestion(null);
      setStatus('');
      setAttachmentSheetVisible(false);
      setAttachmentLoading(false);
      progress.stopAnimation();
      progress.setValue(0);
      Animated.timing(progress, {
        toValue: 1,
        duration: MOTION_MS,
        useNativeDriver: true,
      }).start();
      void loadSession(true);
      return;
    }
    finishClose(false);
  }, [finishClose, loadSession, progress, visible]);

  useEffect(() => () => {
    loadGenerationRef.current += 1;
    requestControllerRef.current?.abort();
    progress.stopAnimation();
  }, [progress]);

  useEffect(() => {
    if (!session?.thread.turns.length && !pendingQuestion) return;
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
  }, [pendingQuestion, session?.thread.turns.length]);

  if (!mounted) return null;
  const turns = session?.thread.turns ?? [];
  const canSend = Boolean(session && draft.trim() && !loading && !sending && !closing);
  const includeManualNote = session?.thread.includeManualNote === true;
  const selectedAttachmentIds = session?.evidence.attachments.map(item => item.attachmentId) ?? [];

  const openAttachmentSelection = async () => {
    if (!scopeKey || attachmentLoading || sending || closing) return;
    setAttachmentLoading(true);
    setError('');
    setStatus('');
    try {
      const available = (await loadMeetingAttachments(scopeKey, meetingId))
        .filter(attachment => attachment.kind === 'text');
      if (!mountedRef.current) return;
      if (available.length === 0) {
        setStatus('当前会议没有可用于问答的文字附件。');
        return;
      }
      setAttachments(available);
      setAttachmentSheetVisible(true);
    } catch (reason) {
      if (mountedRef.current) {
        setError(readableErrorMessage(reason, '附件暂时无法读取，请稍后重试。'));
      }
    } finally {
      if (mountedRef.current) setAttachmentLoading(false);
    }
  };

  const send = async () => {
    if (!canSend || !session || !scopeKey) return;
    const submittedDraft = draft;
    const question = submittedDraft.trim();
    const controller = new AbortController();
    requestControllerRef.current?.abort();
    requestControllerRef.current = controller;
    setPendingQuestion(question);
    setDraft('');
    inputRef.current?.blur();
    Keyboard.dismiss();
    setSending(true);
    setError('');
    setStatus('');
    const releaseInteractivePriority = beginSummaryV3InteractiveWork();
    try {
      const next = await askMeetingQuestion({
        scopeKey,
        navigationMeetingId: meetingId,
        session,
        question,
        accessToken,
        signal: controller.signal,
      });
      if (!mountedRef.current || controller.signal.aborted) return;
      setSession(next);
      setPendingQuestion(null);
    } catch (reason) {
      if (!mountedRef.current || controller.signal.aborted) return;
      setPendingQuestion(null);
      setDraft(submittedDraft);
      if (reason instanceof MeetingQuestionEvidenceChangedError || reason instanceof Q2EvidenceChangedError) {
        await loadSession(includeManualNote, true);
        if (mountedRef.current) setStatus('会议内容已更新，已切换到新的问答记录。');
      } else {
        setError(readableErrorMessage(reason, '暂时未能回答，请稍后重试。'));
      }
    } finally {
      releaseInteractivePriority();
      if (requestControllerRef.current === controller) requestControllerRef.current = null;
      if (mountedRef.current) setSending(false);
    }
  };

  const openCitation = (citation: MeetingQuestionCitation) => {
    if (
      !session
      || !isMeetingQuestionCitationCurrent(citation, session.evidence)
    ) {
      setError('这条引用已不属于当前会议内容，请重新打开问答。');
      return;
    }
    const target = citationTarget(citation, session);
    finishClose(true, () => citationRef.current(target));
  };

  return (
    <Fragment>
    <Modal visible transparent animationType="none" statusBarTranslucent onRequestClose={() => finishClose(true)}>
      <Animated.View
        style={[
          styles.page,
          {
            paddingTop: insets.top,
            backgroundColor: colors.backgroundBodyOverlay,
            opacity: progress,
            transform: [{
              translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [Math.min(28, width * 0.08), 0] }),
            }],
          },
        ]}
        pointerEvents={closing ? 'none' : 'auto'}
        accessibilityViewIsModal
        testID="meeting-question-sheet"
      >
        <KeyboardAvoidingView
          style={styles.page}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <View style={[styles.titleBar, { backgroundColor: colors.backgroundBody, borderBottomColor: colors.divider }]}>
            <Pressable
              style={({ pressed }) => [styles.titleAction, pressed && { backgroundColor: colors.pressedFill }]}
              onPress={() => finishClose(true)}
              accessibilityRole="button"
              accessibilityLabel="关闭会议问答"
            >
              <Ionicons name="chevron-back" size={22} color={colors.iconPrimary} />
            </Pressable>
            <View style={styles.titleContent}>
              <Text style={[styles.title, { color: colors.textTitle }]}>会议问答</Text>
              <Text style={[styles.subtitle, { color: colors.textCaption }]} numberOfLines={1}>{meetingTitle}</Text>
            </View>
            {turns.length > 0 ? (
              <Pressable
                style={({ pressed }) => [styles.newThread, pressed && { backgroundColor: colors.pressedFill }]}
                onPress={() => {
                  if (!sending) {
                    void loadSession(
                      includeManualNote,
                      true,
                      session?.evidence.attachmentAuthorization ?? null,
                    );
                  }
                }}
                disabled={sending || loading}
                accessibilityRole="button"
                accessibilityLabel="开始新问答"
              >
                <Text style={[styles.newThreadText, { color: sending || loading ? colors.textDisabled : colors.textLink }]}>新对话</Text>
              </Pressable>
            ) : <View style={styles.titleAction} />}
          </View>

          {session ? (
            <View style={[styles.scopeBar, { backgroundColor: colors.backgroundBody, borderBottomColor: colors.divider }]}>
              <Text style={[styles.scopeLabel, { color: colors.textCaption }]}>
                {[
                  '文字记录',
                  session.thread.summaryVersionId && session.evidence.summary.length > 0
                    ? '整理结果'
                    : null,
                  session.evidence.includeManualNote ? '我的笔记' : null,
                  session.evidence.attachments.length > 0
                    ? `附件（${session.evidence.attachments.length}）`
                    : null,
                ].filter(Boolean).join(' · ')}
              </Text>
              {questionAttachmentsEnabled ? <Pressable
                style={({ pressed }) => [
                  styles.attachmentAction,
                  pressed && !attachmentLoading && { backgroundColor: colors.pressedFill },
                ]}
                onPress={() => { void openAttachmentSelection(); }}
                disabled={attachmentLoading || sending || closing}
                accessibilityRole="button"
                accessibilityLabel="选择问答附件"
                accessibilityState={{
                  busy: attachmentLoading,
                  disabled: attachmentLoading || sending || closing,
                }}
                testID="meeting-question-attachments"
              >
                {attachmentLoading
                  ? <ActivityIndicator size="small" color={colors.primary} />
                  : <Ionicons name="attach-outline" size={20} color={colors.iconSecondary} />}
              </Pressable> : null}
            </View>
          ) : null}

          {loading ? (
            <View style={styles.centerState}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={[styles.stateText, { color: colors.textCaption }]}>正在读取会议来源</Text>
            </View>
          ) : session ? (
            <FlatList
              ref={listRef}
              style={styles.list}
              contentContainerStyle={[
                styles.listContent,
                turns.length === 0 && !pendingQuestion && styles.emptyListContent,
              ]}
              data={turns}
              keyExtractor={turn => turn.id}
              renderItem={({ item }) => <QuestionTurnView turn={item} onCitation={openCitation} />}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              ListEmptyComponent={!pendingQuestion ? (
                <View style={styles.emptyState}>
                  <Ionicons name="chatbubble-ellipses-outline" size={32} color={colors.iconTertiary} />
                  <Text style={[styles.emptyText, { color: colors.textCaption }]}>暂无问答</Text>
                </View>
              ) : null}
              ListFooterComponent={pendingQuestion
                ? <PendingQuestionView question={pendingQuestion} />
                : null}
            />
          ) : (
            <View style={styles.centerState}>
              <Ionicons name="alert-circle-outline" size={28} color={colors.iconTertiary} />
              <Text style={[styles.stateText, { color: colors.textCaption }]}>{error || '会议问答暂时不可用。'}</Text>
              <Pressable
                style={({ pressed }) => [
                  styles.retry,
                  { backgroundColor: pressed ? colors.primaryPressed : colors.primary },
                ]}
                onPress={() => { void loadSession(true); }}
                accessibilityRole="button"
                accessibilityLabel="重试打开会议问答"
              >
                <Text style={[styles.retryText, { color: colors.onPrimary }]}>重试</Text>
              </Pressable>
            </View>
          )}

          {session ? (
            <View style={[
              styles.composer,
              {
                paddingBottom: Math.max(insets.bottom, 10),
                backgroundColor: colors.backgroundBody,
                borderTopColor: colors.divider,
              },
            ]}>
              <View style={styles.feedbackSlot}>
                <Text
                  style={[styles.feedback, { color: error ? colors.danger : colors.textCaption }]}
                  numberOfLines={2}
                  accessibilityRole={error ? 'alert' : undefined}
                >
                  {error || status || ' '}
                </Text>
              </View>
              <View style={styles.inputRow}>
                <TextInput
                  ref={inputRef}
                  value={draft}
                  onChangeText={value => {
                    setDraft(value);
                    setError('');
                    setStatus('');
                  }}
                  editable={!sending && !closing}
                  multiline
                  maxLength={2_000}
                  placeholder="提问"
                  placeholderTextColor={colors.textPlaceholder}
                  style={[
                    styles.input,
                    { color: colors.textTitle, backgroundColor: colors.backgroundFloatOverlay },
                  ]}
                  returnKeyType="default"
                  accessibilityLabel="会议问题"
                  testID="meeting-question-input"
                />
                <Pressable
                  style={({ pressed }) => [
                    styles.send,
                    {
                      backgroundColor: canSend
                        ? pressed ? colors.primaryPressed : colors.primary
                        : colors.backgroundBase,
                    },
                  ]}
                  onPress={() => { void send(); }}
                  disabled={!canSend}
                  accessibilityRole="button"
                  accessibilityLabel="发送会议问题"
                  accessibilityState={{ disabled: !canSend }}
                  testID="meeting-question-send"
                >
                  {sending
                    ? <ActivityIndicator size="small" color={colors.onPrimary} />
                    : <Ionicons name="arrow-up" size={20} color={canSend ? colors.onPrimary : colors.iconDisabled} />}
                </Pressable>
              </View>
            </View>
          ) : null}
        </KeyboardAvoidingView>
      </Animated.View>
    </Modal>
    {questionAttachmentsEnabled ? <MeetingSummaryAttachmentSheet
      visible={attachmentSheetVisible}
      attachments={attachments}
      imageSelectionEnabled={false}
      purpose="question"
      initialSelectedIds={selectedAttachmentIds}
      onClose={() => setAttachmentSheetVisible(false)}
      onSkip={() => {
        setAttachmentSheetVisible(false);
        void loadSession(includeManualNote, true, null);
      }}
      onAuthorize={attachmentIds => {
        if (!scopeKey) throw new Error('当前会议尚未准备好。');
        return authorizeMeetingQuestionAttachments({
          scopeKey,
          navigationMeetingId: meetingId,
          attachmentIds,
        });
      }}
      onCompleted={authorization => {
        setAttachmentSheetVisible(false);
        void loadSession(includeManualNote, true, authorization);
      }}
    /> : null}
    </Fragment>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  titleBar: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  titleAction: { width: 52, height: 44, alignItems: 'center', justifyContent: 'center' },
  titleContent: { flex: 1, minWidth: 0, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 17, lineHeight: 22, fontWeight: '500' },
  subtitle: { maxWidth: '100%', marginTop: 1, fontSize: 11, lineHeight: 14, fontWeight: '400' },
  newThread: { width: 64, height: 44, alignItems: 'center', justifyContent: 'center' },
  newThreadText: { fontSize: 14, lineHeight: 22, fontWeight: '400' },
  scopeBar: {
    minHeight: 44,
    paddingLeft: 16,
    paddingRight: 10,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  scopeLabel: { flex: 1, fontSize: 13, lineHeight: 20 },
  attachmentAction: { width: 44, height: 44, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  list: { flex: 1 },
  listContent: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 20 },
  emptyListContent: { flexGrow: 1 },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  emptyText: { fontSize: 14, lineHeight: 22 },
  turn: { marginBottom: 20 },
  questionBubble: { maxWidth: '86%', alignSelf: 'flex-end', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 9 },
  questionText: { fontSize: 16, lineHeight: 24 },
  answerCard: { marginTop: 10, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 12 },
  answerText: { fontSize: 16, lineHeight: 25 },
  citations: { marginTop: 8, gap: 8 },
  // [INFERENCE] LaoJi-only evidence disclosure. Keep the Feishu-neutral
  // container family and a 44dp action target while collapsing verbose source
  // excerpts by default.
  citationsToggle: {
    minHeight: 44,
    borderRadius: 6,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
  },
  citationsToggleLabel: { flex: 1, marginLeft: 6, fontSize: 13, lineHeight: 20 },
  citation: { borderRadius: 6, paddingHorizontal: 10, paddingVertical: 8 },
  citationTitleRow: { flexDirection: 'row', alignItems: 'center' },
  citationLabel: { flex: 1, marginLeft: 5, fontSize: 13, lineHeight: 20 },
  citationExcerpt: { marginTop: 3, fontSize: 12, lineHeight: 18 },
  loadingAnswer: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  loadingAnswerText: { marginLeft: 10, fontSize: 14, lineHeight: 22 },
  centerState: { flex: 1, paddingHorizontal: 28, alignItems: 'center', justifyContent: 'center', gap: 14 },
  stateText: { fontSize: 14, lineHeight: 22, textAlign: 'center' },
  retry: { width: 76, height: 36, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  retryText: { fontSize: 16, lineHeight: 24 },
  composer: { paddingHorizontal: 12, paddingTop: 0, borderTopWidth: StyleSheet.hairlineWidth },
  feedbackSlot: { minHeight: 30, justifyContent: 'center' },
  feedback: { fontSize: 12, lineHeight: 18 },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 104,
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 8,
    fontSize: 16,
    lineHeight: 24,
    textAlignVertical: 'top',
  },
  send: { width: 40, height: 40, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
});
