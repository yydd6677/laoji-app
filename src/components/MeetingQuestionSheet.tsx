import Ionicons from '@expo/vector-icons/Ionicons';
import React, { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Keyboard,
  Modal,
  Pressable,
  StyleSheet,
  Text as NativeText,
  type TextProps,
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
import type { MeetingAttachmentRecord } from "../data/repositories/meetingNoteRepository";
import { MeetingSummaryAttachmentSheet } from './MeetingSummaryAttachmentSheet';
import { readableErrorMessage } from '../services/errors';
import { authorizeMeetingQuestionAttachments } from '../services/meetingQuestionAttachments';
import { loadMeetingAttachments } from '../services/meetingAttachments';
import {
  askMeetingQuestion,
  MeetingQuestionEvidenceChangedError,
  isMeetingQuestionCitationCurrent,
  prepareMeetingQuestionSession,
  listMeetingQuestionHistory,
  openMeetingQuestionHistory,
  type Q2ThreadHistoryEntry,
  type MeetingQuestionSession,
} from '../services/meetingQuestions';
import {
  Q2EvidenceChangedError,
  refreshQ2MeetingQuestionSession,
  subscribeQ2MeetingChanges,
} from '../services/meetingQuestionsQ2';
import { useTheme } from '../theme/ThemeProvider';
import { KeyboardFrame } from './KeyboardFrame';

const MOTION_MS = 300;

// Android's Activity font also affects the rendered TextView. RN must measure
// with that same family, rather than measuring the system font and clipping
// the wider theme glyphs in shrink-to-content question bubbles.
function Text({ style, ...props }: TextProps) {
  const { appearance } = useTheme();
  return <NativeText {...props} style={[{ fontFamily: appearance.fontFamily }, style]} />;
}

function historyTime(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear() === new Date().getFullYear() ? '' : `${date.getFullYear()}年`;
  return `${year}${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

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
  const { tokens: { colors } } = useTheme();
  const [citationsExpanded, setCitationsExpanded] = useState(false);
  return (
    <View style={styles.turn} testID={`meeting-question-turn-${turn.ordinal}`}>
      <View style={[styles.questionBubble, { backgroundColor: colors.primarySoft }]}>
        <Text selectable style={[styles.questionText, { color: colors.textTitle }]}>{turn.question}</Text>
      </View>
      <View style={styles.answerBody}>
        <Text selectable style={[styles.answerText, { color: colors.textTitle }]}>{turn.answer}</Text>
        {turn.citations.length > 0 ? (
          <View style={styles.citations}>
            <Pressable
              testID={`meeting-question-citations-toggle-${turn.ordinal}`}
              style={({ pressed }) => [
                styles.citationsToggle,
                pressed && { backgroundColor: colors.pressedFill },
              ]}
              onPress={() => setCitationsExpanded(expanded => !expanded)}
              accessibilityRole="button"
              accessibilityLabel={`${citationsExpanded ? '收起' : '展开'}${turn.citations.length}条引用`}
              accessibilityState={{ expanded: citationsExpanded }}
            >
              <Ionicons name="link-outline" size={15} color={colors.textLink} />
              <Text style={[styles.citationsToggleLabel, { color: colors.textLink }]}>
                {`依据 ${turn.citations.length}`}
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
                  { borderLeftColor: colors.divider },
                  pressed && { backgroundColor: colors.pressedFill },
                ]}
                onPress={() => onCitation(citation)}
                accessibilityRole="button"
                accessibilityLabel={`查看来源：${citation.sourceLabel}`}
              >
                <View style={styles.citationTitleRow}>
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
  const { tokens: { colors } } = useTheme();
  return (
    <View
      style={styles.turn}
      testID="meeting-question-pending-turn"
      accessibilityLiveRegion="polite"
    >
      <View style={[styles.questionBubble, { backgroundColor: colors.primarySoft }]}>
        <Text selectable style={[styles.questionText, { color: colors.textTitle }]}>{question}</Text>
      </View>
      <View style={[styles.answerBody, styles.loadingAnswer]}>
        <ActivityIndicator size="small" color={colors.primary} />
        <Text style={[styles.loadingAnswerText, { color: colors.textCaption }]}>正在回答</Text>
      </View>
    </View>
  );
}

/**
 * Meeting question page using LaoJi's shared title, state, input, token and motion owners.
 */
export function MeetingQuestionSheet({
  visible,
  meetingTitle,
  meetingId,
  scopeKey,
  onClose,
  onOpenCitation,
}: {
  visible: boolean;
  meetingTitle: string;
  meetingId: string;
  scopeKey: ScopeKey | null;
  onClose: () => void;
  onOpenCitation: (target: MeetingQuestionCitationTarget) => void;
}) {
  const { tokens: { colors }, appearance } = useTheme();
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
  const draftOwnerRef = useRef({ scopeKey, meetingId });
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
  const [historyVisible, setHistoryVisible] = useState(false);
  const [history, setHistory] = useState<readonly Q2ThreadHistoryEntry[]>([]);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  closeRef.current = onClose;
  citationRef.current = onOpenCitation;

  const finishClose = useCallback((notify: boolean, afterExit?: () => void) => {
    if (!mountedRef.current || closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    Keyboard.dismiss();
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
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
      setError('设备状态尚未准备好，请稍后重试。');
      return;
    }
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    // A visible sheet can survive while the parent detail route changes.
    // Clear the old session before the asynchronous read so its answers and
    // citations cannot be mistaken for the new meeting's evidence.
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
    setSession(null);
    setPendingQuestion(null);
    setSending(false);
    setLoading(true);
    setError('');
    setStatus('');
    setHistoryVisible(false);
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
      setPendingQuestion(next.pendingQuestion ?? null);
      setSending(Boolean(next.pendingQuestion));
      setError('');
      if (next.failedQuestion) {
        setDraft(current => current || next.failedQuestion!);
        setError('上一条未能完成，可重试或开始新对话。');
      }
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
      // Reading sources is not a prerequisite for typing. Retain the draft on
      // close/reopen, but never carry it to a different meeting or device scope.
      if (draftOwnerRef.current.scopeKey !== scopeKey || draftOwnerRef.current.meetingId !== meetingId) {
        draftOwnerRef.current = { scopeKey, meetingId };
        setDraft('');
      }
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
  }, [finishClose, loadSession, meetingId, progress, scopeKey, visible]);

  useEffect(() => () => {
    loadGenerationRef.current += 1;
    requestControllerRef.current?.abort();
    progress.stopAnimation();
  }, [progress]);

  useEffect(() => {
    if (!visible) return;
    let refreshGeneration = 0;
    return subscribeQ2MeetingChanges(changedMeetingId => {
      const current = sessionRef.current;
      if (changedMeetingId !== meetingId || !current || current.readOnly || requestControllerRef.current) return;
      const request = ++refreshGeneration;
      const generation = loadGenerationRef.current;
      void refreshQ2MeetingQuestionSession(current).then(next => {
        if (!mountedRef.current || closingRef.current || request !== refreshGeneration
          || generation !== loadGenerationRef.current || sessionRef.current?.thread.id !== current.thread.id) return;
        setSession(next);
        setPendingQuestion(next.pendingQuestion ?? null);
        setSending(Boolean(next.pendingQuestion));
        if (next.failedQuestion) {
          setDraft(value => value || next.failedQuestion!);
          setError('上一条未能完成，可重试或开始新对话。');
        }
      }).catch(() => { /* Keep the last local projection during a transient read failure. */ });
    });
  }, [meetingId, visible]);

  useEffect(() => {
    if (!session?.thread.turns.length && !pendingQuestion) return;
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
  }, [pendingQuestion, session?.thread.turns.length]);

  if (!mounted) return null;
  const turns = session?.thread.turns ?? [];
  const canSend = Boolean(session && !session.readOnly && draft.trim() && !loading && !sending && !closing && !historyVisible);
  const includeManualNote = session?.thread.includeManualNote === true;
  const selectedAttachmentIds = session?.evidence.attachments.map(item => item.attachmentId) ?? [];

  const openHistory = async () => {
    if (!session || sending || loading) return;
    const generation = loadGenerationRef.current;
    try {
      const entries = await listMeetingQuestionHistory(session.evidence.meetingId);
      if (!mountedRef.current || generation !== loadGenerationRef.current) return;
      setHistory(entries);
      setHistoryVisible(true);
    } catch {
      setError('问答记录暂时无法读取。');
    }
  };

  const selectHistory = async (threadId: string) => {
    if (!session) return;
    const generation = ++loadGenerationRef.current;
    setLoading(true);
    try {
      const next = await openMeetingQuestionHistory(session.evidence, threadId);
      if (!mountedRef.current || generation !== loadGenerationRef.current) return;
      setSession(next);
      setPendingQuestion(next.pendingQuestion ?? null);
      setSending(Boolean(next.pendingQuestion));
      if (next.failedQuestion) {
        setDraft(current => current || next.failedQuestion!);
        setError('上一条未能完成，可重试或开始新对话。');
      }
      setHistoryVisible(false);
      setStatus(next.readOnly ? '来源已更新，此处保留原回答' : '');
    } catch {
      if (mountedRef.current) setError('这段问答暂时无法打开。');
    } finally {
      if (mountedRef.current && generation === loadGenerationRef.current) setLoading(false);
    }
  };

  const openAttachmentSelection = async () => {
    if (!scopeKey || attachmentLoading || sending || closing) return;
    const generation = loadGenerationRef.current;
    setAttachmentLoading(true);
    setError('');
    setStatus('');
    try {
      const available = (await loadMeetingAttachments(scopeKey, meetingId))
        .filter(attachment => attachment.kind === 'text');
      if (!mountedRef.current || generation !== loadGenerationRef.current) return;
      setAttachments(available);
      setAttachmentSheetVisible(true);
    } catch (reason) {
      if (mountedRef.current && generation === loadGenerationRef.current) {
        setError(readableErrorMessage(reason, '附件暂时无法读取，请稍后重试。'));
      }
    } finally {
      if (mountedRef.current && generation === loadGenerationRef.current) setAttachmentLoading(false);
    }
  };

  const send = async () => {
    if (!canSend || !session || !scopeKey || requestControllerRef.current) return;
    const submittedDraft = draft;
    const question = submittedDraft.trim();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    setPendingQuestion(question);
    setDraft('');
    // Keep focus, keyboard and native editable state stable. Disabling/blurring
    // the input on every send used to flash/rebuild the IME/composer surface.
    setSending(true);
    setError('');
    setStatus('');
    try {
      const next = await askMeetingQuestion({
        scopeKey,
        navigationMeetingId: meetingId,
        session,
        question,
      });
      if (!mountedRef.current || controller.signal.aborted) return;
      setSession(next);
      setPendingQuestion(null);
    } catch (reason) {
      if (!mountedRef.current || controller.signal.aborted) return;
      setPendingQuestion(null);
      setDraft(current => current || submittedDraft);
      if (reason instanceof MeetingQuestionEvidenceChangedError || reason instanceof Q2EvidenceChangedError) {
        await loadSession(includeManualNote, true);
        if (mountedRef.current) setStatus('会议内容已更新，已切换到新的问答记录。');
      } else {
        setError(readableErrorMessage(reason, '暂时未能回答，请稍后重试。'));
      }
    } finally {
      if (requestControllerRef.current === controller) {
        requestControllerRef.current = null;
        if (mountedRef.current) setSending(false);
      }
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
        <KeyboardFrame
          style={styles.page}
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
            <Pressable
              style={styles.titleAction}
              onPress={() => { if (historyVisible) setHistoryVisible(false); else void openHistory(); }}
              disabled={sending || loading || !session}
              accessibilityRole="button"
              accessibilityLabel={historyVisible ? '返回当前问答' : '问答记录'}
              testID="meeting-question-history"
            ><Ionicons name={historyVisible ? 'chatbubble-outline' : 'time-outline'} size={22} color={colors.iconPrimary} /></Pressable>
            {turns.length > 0 || session?.readOnly || session?.failedQuestion ? (
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
                testID="meeting-question-new-thread"
              >
                <Text style={[styles.newThreadText, { color: sending || loading ? colors.textDisabled : colors.textLink }]}>新对话</Text>
              </Pressable>
            ) : <View style={styles.newThread} testID="meeting-question-new-thread-placeholder" />}
          </View>

          {historyVisible ? (
            <FlatList
              data={history}
              keyExtractor={entry => entry.threadId}
              style={styles.list}
              contentContainerStyle={styles.listContent}
              ListEmptyComponent={<Text style={[styles.stateText, { color: colors.textCaption }]}>暂无问答记录</Text>}
              renderItem={({ item }) => (
                <Pressable
                  onPress={() => { void selectHistory(item.threadId); }}
                  style={({ pressed }) => [styles.historyRow, { borderBottomColor: colors.divider, backgroundColor: pressed ? colors.pressedFill : undefined }]}
                  accessibilityRole="button"
                >
                  <Text style={[styles.questionText, { color: colors.textTitle }]} numberOfLines={2}>{item.title}</Text>
                  <Text style={[styles.citationExcerpt, { color: colors.textCaption }]}>
                    {`${historyTime(item.updatedAtMs)}  ${item.turnCount} 条`}
                  </Text>
                </Pressable>
              )}
            />
          ) : loading ? (
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

          <View
            testID="meeting-question-composer"
            // Keep the editable instance through source reads, history and new
            // threads. History hides the composer; it must not recreate it.
            style={[
              styles.composer,
              historyVisible && styles.hiddenComposer,
              {
                paddingBottom: Math.max(insets.bottom, 10),
                backgroundColor: colors.backgroundBody,
                borderTopColor: colors.divider,
              },
            ]}
          >
              {session && (error || status) ? <View style={styles.feedbackSlot}>
                <Text
                  style={[styles.feedback, { color: error ? colors.danger : colors.textCaption }]}
                  numberOfLines={2}
                  accessibilityRole={error ? 'alert' : undefined}
                >
                  {error || status || ' '}
                </Text>
              </View> : null}
              <View style={styles.inputRow}>
                <Pressable
                  style={({ pressed }) => [styles.attachmentAction, pressed && { backgroundColor: colors.pressedFill }]}
                  onPress={() => { void openAttachmentSelection(); }}
                  disabled={!session || attachmentLoading || sending || closing}
                  accessibilityRole="button"
                  accessibilityLabel="问答来源"
                  accessibilityState={{ busy: attachmentLoading, disabled: !session || attachmentLoading || sending || closing }}
                  testID="meeting-question-attachments"
                >
                  <Ionicons name="attach-outline" size={22} color={session ? colors.iconSecondary : colors.iconDisabled} />
                </Pressable>
                <TextInput
                  ref={inputRef}
                  value={draft}
                  onChangeText={value => {
                    setDraft(value);
                    setError('');
                    setStatus('');
                  }}
                  editable={!closing && !historyVisible && !session?.readOnly}
                  multiline
                  maxLength={2_000}
                  placeholder={session?.readOnly ? '新对话' : '提问'}
                  placeholderTextColor={colors.textPlaceholder}
                  style={[
                    styles.input,
                    { color: colors.textTitle, backgroundColor: colors.backgroundFloatOverlay, fontFamily: appearance.fontFamily },
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
                  <Ionicons name="arrow-up" size={20} color={canSend ? colors.onPrimary : colors.iconDisabled} />
                </Pressable>
              </View>
          </View>
        </KeyboardFrame>
      </Animated.View>
    </Modal>
    <MeetingSummaryAttachmentSheet
      visible={attachmentSheetVisible}
      attachments={attachments}
      imageSelectionEnabled={false}
      purpose="question"
      includedSources={[
        ...(session?.evidence.transcript.length ? ['文字记录'] : []),
        ...(session?.evidence.includeManualNote && session.evidence.manualNote?.trim() ? ['我的笔记'] : []),
      ]}
      initialSelectedIds={selectedAttachmentIds}
      onClose={() => setAttachmentSheetVisible(false)}
      onSkip={() => {
        setAttachmentSheetVisible(false);
        if (selectedAttachmentIds.length > 0) void loadSession(includeManualNote, true, null);
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
        const previous = session?.evidence.attachmentAuthorization?.items ?? [];
        const ordered = (items: MeetingSummaryAttachmentAuthorization['items']) =>
          [...items].sort((a, b) => a.attachmentId.localeCompare(b.attachmentId));
        if (JSON.stringify(ordered(previous)) !== JSON.stringify(ordered(authorization.items))) {
          void loadSession(includeManualNote, true, authorization);
        }
      }}
    />
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
  attachmentAction: { width: 44, height: 44, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  list: { flex: 1 },
  historyRow: { minHeight: 64, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  listContent: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 24 },
  emptyListContent: { flexGrow: 1 },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  emptyText: { fontSize: 14, lineHeight: 22 },
  turn: { marginBottom: 28 },
  questionBubble: { maxWidth: '86%', alignSelf: 'flex-end', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 9 },
  questionText: { fontSize: 16, lineHeight: 24 },
  answerBody: { marginTop: 16 },
  answerText: { fontSize: 16, lineHeight: 27 },
  citations: { marginTop: 4, gap: 8 },
  citationsToggle: {
    minHeight: 44,
    alignSelf: 'flex-start',
    borderRadius: 6,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
  },
  citationsToggleLabel: { marginHorizontal: 6, fontSize: 13, lineHeight: 20 },
  citation: { borderLeftWidth: 2, paddingLeft: 12, paddingRight: 4, paddingVertical: 8, minHeight: 44 },
  citationTitleRow: { flexDirection: 'row', alignItems: 'center' },
  citationLabel: { flex: 1, fontSize: 13, lineHeight: 20 },
  citationExcerpt: { marginTop: 3, fontSize: 12, lineHeight: 18 },
  loadingAnswer: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  loadingAnswerText: { marginLeft: 10, fontSize: 14, lineHeight: 22 },
  centerState: { flex: 1, paddingHorizontal: 28, alignItems: 'center', justifyContent: 'center', gap: 14 },
  stateText: { fontSize: 14, lineHeight: 22, textAlign: 'center' },
  retry: { width: 76, height: 36, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  retryText: { fontSize: 16, lineHeight: 24 },
  composer: { paddingHorizontal: 12, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth },
  hiddenComposer: { display: 'none' },
  feedbackSlot: { minHeight: 30, justifyContent: 'center' },
  feedback: { fontSize: 12, lineHeight: 18 },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 104,
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 8,
    fontSize: 16,
    lineHeight: 24,
    textAlignVertical: 'top',
  },
  send: { width: 44, height: 44, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
});
