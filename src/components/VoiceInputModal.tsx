import React, { useState, useRef } from 'react';
import {
  Modal, View, Text, TextInput, TouchableOpacity,
  StyleSheet, ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { Audio } from 'expo-av';
import { Colors as C } from '../theme/colors';
import { clarifyText, parseAudio, parseText, ParseResult } from '../services/api';
import {
  RealtimeAsrAudioStats,
  RealtimeAsrSession,
  RealtimeAsrTranscript,
  selectRealtimeScheduleText,
  startRealtimeAsr,
} from '../services/realtimeAsr';
import { useEvents } from '../store/EventsStore';
import { useAppDialog } from './AppDialog';
import { colorForEvent, normalizeEventCategory } from '../utils/eventColors';

interface Props {
  visible: boolean;
  onClose: () => void;
  onSaved: () => void;
}

type Step = 'input' | 'recording' | 'parsing' | 'confirm' | 'saving';
type RecordingMode = 'realtime' | 'file';
type AudioLevelSummary = { frameCount: number; maxPeak: number; maxRms: number };
type TranscriptSegment = {
  text: string;
  receivedAt: number;
  startTime?: number;
  endTime?: number;
};

const LOW_AUDIO_PEAK = 1000;
const LOW_AUDIO_RMS = 280;

export function VoiceInputModal({ visible, onClose, onSaved }: Props) {
  const { addEvent, refreshEvents } = useEvents();
  const { showDialog } = useAppDialog();
  const [step, setStep]         = useState<Step>('input');
  const [text, setText]         = useState('');
  const [draft, setDraft]       = useState<ParseResult | null>(null);
  const [clarifyAnswer, setClarifyAnswer] = useState('');
  const [error, setError]       = useState('');
  const recordingRef            = useRef<Audio.Recording | null>(null);
  const realtimeRef             = useRef<RealtimeAsrSession | null>(null);
  const recordingModeRef        = useRef<RecordingMode | null>(null);
  const recordingRunRef         = useRef(0);
  const transcriptRef           = useRef('');
  const transcriptChunksRef     = useRef<string[]>([]);
  const transcriptSegmentsRef   = useRef<TranscriptSegment[]>([]);
  const audioLevelRef           = useRef<AudioLevelSummary>({ frameCount: 0, maxPeak: 0, maxRms: 0 });
  const [recordingMode, setRecordingMode] = useState<RecordingMode | null>(null);

  const reset = () => {
    recordingRunRef.current += 1;
    setStep('input');
    setText('');
    setDraft(null);
    setClarifyAnswer('');
    setError('');
    setRecordingMode(null);
    transcriptRef.current = '';
    transcriptChunksRef.current = [];
    transcriptSegmentsRef.current = [];
    audioLevelRef.current = { frameCount: 0, maxPeak: 0, maxRms: 0 };
    recordingModeRef.current = null;
  };
  const close = () => {
    recordingRunRef.current += 1;
    void stopActiveRecordingSilently();
    reset();
    onClose();
  };
  const returnToInput = () => {
    const preservedText = text.trim() || draft?.raw_text?.trim() || '';
    setStep('input');
    setText(preservedText);
    setDraft(null);
    setClarifyAnswer('');
    setError('');
  };
  const voiceErrorText = (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err ?? '');
    if (message.includes('无法从语音中提取日程')) return '未识别到明确日程，请靠近麦克风再说一次';
    if (message.includes('实时语音流')) return '当前运行环境不支持实时语音，请使用开发版或正式包';
    if (message.includes('realtime ASR') || message.includes('websocket')) return '实时语音接口连接失败，请确认手机网络能访问服务器';
    if (message.includes('Network request failed')) return '语音接口连接失败，请确认手机网络能访问服务器';
    if (message.includes('read audio failed')) return '录音文件读取失败，请重新录音';
    if (message.includes('permission')) return '没有麦克风权限，请在系统设置中允许录音';
    if (message.includes('timed out')) return '语音识别超时，请稍后重试';
    return message ? `语音识别失败：${message}` : '语音识别失败，请重试';
  };

  const setTranscriptSegments = (segments: TranscriptSegment[]) => {
    transcriptSegmentsRef.current = segments;
    const nextText = segments.map(segment => segment.text).join('\n');
    transcriptRef.current = nextText;
    setText(nextText);
  };

  const appendRealtimeTranscript = (transcript: RealtimeAsrTranscript) => {
    const clean = transcript.text.trim();
    if (!clean) return;
    const chunks = [...transcriptChunksRef.current, clean];
    const selected = selectRealtimeScheduleText(chunks);
    if (!selected) return;

    transcriptChunksRef.current = chunks;
    const now = Date.now();
    setTranscriptSegments([{
      text: selected,
      receivedAt: now,
      startTime: transcript.startTime,
      endTime: transcript.endTime,
    }]);
  };

  const noteRealtimeAudioStats = (stats: RealtimeAsrAudioStats) => {
    audioLevelRef.current = {
      frameCount: stats.frameCount,
      maxPeak: Math.max(audioLevelRef.current.maxPeak, stats.raw.peak),
      maxRms: Math.max(audioLevelRef.current.maxRms, stats.raw.rms),
    };
  };

  const noTranscriptText = () => {
    const level = audioLevelRef.current;
    const isLowAudio = level.frameCount > 0
      && level.maxPeak < LOW_AUDIO_PEAK
      && level.maxRms < LOW_AUDIO_RMS;
    if (isLowAudio) {
      return '未识别到语音内容，当前麦克风音量过低，请靠近手机并提高音量';
    }
    return '未识别到语音内容，请靠近麦克风再说一次';
  };

  const stopActiveRecordingSilently = async () => {
    const realtime = realtimeRef.current;
    const recording = recordingRef.current;
    realtimeRef.current = null;
    recordingRef.current = null;
    recordingModeRef.current = null;
    setRecordingMode(null);

    if (realtime) {
      try {
        await realtime.stop();
      } catch {
        // Closing the modal should never block on recorder cleanup.
      }
    }
    if (recording) {
      try {
        await recording.stopAndUnloadAsync();
      } catch {
        // The recording may already be unloaded.
      }
    }
  };

  // ── Text submit ────────────────────────────────────────────────────────────
  const handleSubmitText = async () => {
    if (!text.trim()) return;
    setStep('parsing'); setError('');
    try {
      const result = await parseText(text.trim());
      setDraft(result); setStep('confirm');
    } catch (e: any) {
      setError('解析失败，请检查网络'); setStep('input');
    }
  };

  // ── Voice recording ────────────────────────────────────────────────────────
  const startRecording = async () => {
    try {
      const runId = recordingRunRef.current + 1;
      recordingRunRef.current = runId;
      const permission = await Audio.requestPermissionsAsync();
      if (!permission.granted) {
        showDialog({ title: '无法录音', message: '请在系统设置中允许麦克风权限', tone: 'warning' });
        return;
      }
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      setError('');
      setText('');
      transcriptRef.current = '';
      transcriptChunksRef.current = [];
      transcriptSegmentsRef.current = [];
      audioLevelRef.current = { frameCount: 0, maxPeak: 0, maxRms: 0 };

      try {
        const realtime = await startRealtimeAsr({
          onTranscript: transcript => {
            if (recordingRunRef.current === runId) appendRealtimeTranscript(transcript);
          },
          onAudioStats: stats => {
            if (recordingRunRef.current === runId) noteRealtimeAudioStats(stats);
          },
          onError: err => {
            if (recordingRunRef.current !== runId) return;
            console.warn('realtime voice recognition warning', err);
            if (recordingModeRef.current === 'realtime') setError(voiceErrorText(err));
          },
        });
        realtimeRef.current = realtime;
        recordingModeRef.current = 'realtime';
        setRecordingMode('realtime');
        setStep('recording');
        return;
      } catch (realtimeErr) {
        console.warn('realtime voice unavailable, falling back to file recording', realtimeErr);
      }

      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY
      );
      recordingRef.current = recording;
      recordingModeRef.current = 'file';
      setRecordingMode('file');
      setStep('recording');
    } catch (err) {
      console.warn('recording start failed', err);
      showDialog({ title: '无法录音', message: '请检查麦克风权限', tone: 'warning' });
    }
  };

  const stopRecording = async () => {
    if (recordingModeRef.current === 'realtime') {
      const realtime = realtimeRef.current;
      if (!realtime) return;
      setStep('parsing');
      try {
        await realtime.stop();
        const transcribed = transcriptRef.current.trim();
        realtimeRef.current = null;
        recordingModeRef.current = null;
        setRecordingMode(null);
        if (!transcribed) {
          setError(noTranscriptText());
          setStep('input');
          return;
        }
        setText(transcribed);
        const result = await parseText(transcribed);
        setDraft(result);
        setStep('confirm');
      } catch (err) {
        console.warn('realtime voice recognition failed', err);
        setError(voiceErrorText(err));
        setStep('input');
        realtimeRef.current = null;
        recordingModeRef.current = null;
        setRecordingMode(null);
      }
      return;
    }

    if (!recordingRef.current) return;
    setStep('parsing');
    try {
      await recordingRef.current.stopAndUnloadAsync();
      const uri = recordingRef.current.getURI();
      recordingRef.current = null;
      recordingModeRef.current = null;
      setRecordingMode(null);
      if (!uri) throw new Error('recording uri is empty');
      const result = await parseAudio(uri);
      const transcribed = result.raw_text ?? '';
      if (!transcribed.trim()) { setError('未识别到语音内容'); setStep('input'); return; }
      setText(transcribed);
      setDraft(result); setStep('confirm');
    } catch (err) {
      console.warn('voice recognition failed', err);
      setError(voiceErrorText(err)); setStep('input');
      recordingRef.current = null;
      recordingModeRef.current = null;
      setRecordingMode(null);
    }
  };

  // ── Clarify parser follow-up ───────────────────────────────────────────────
  const handleClarify = async () => {
    if (!draft || !clarifyAnswer.trim()) return;
    setStep('parsing'); setError('');
    try {
      const answer = clarifyAnswer.trim();
      const result = await clarifyText(text, answer, draft);
      setDraft(result);
      setText(prev => prev ? `${prev}\n${answer}` : answer);
      setClarifyAnswer('');
      setStep('confirm');
    } catch {
      setError('补充解析失败，请重试');
      setStep('confirm');
    }
  };

  // ── Save ───────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!draft) return;
    if (draft.needs_clarification && draft.clarification_question) {
      setError('请先补充信息，再保存日程');
      return;
    }
    setStep('saving');
    try {
      const category = normalizeEventCategory(draft.category);
      await addEvent({
        title:       draft.title,
        startDate:   draft.start_date,
        endDate:     draft.end_date ?? undefined,
        startTime:   draft.start_time ?? undefined,
        endTime:     draft.end_time ?? undefined,
        isAllDay:    draft.is_all_day,
        repeat:      draft.event_type !== 'once' ? draft.event_type as any : undefined,
        description: draft.description ?? undefined,
        rawText:     draft.raw_text ?? text,
        location:    draft.location ?? undefined,
        category,
        detail:      draft.detail ?? undefined,
        status:      draft.status ?? undefined,
        spanning:    draft.spanning ?? Boolean(draft.end_date && draft.end_date !== draft.start_date),
        reminderMinutes: draft.reminder_minutes ?? null,
        color:       colorForEvent({ category }),
      });
      // Refresh calendar for the month of the saved event
      const [y, m] = draft.start_date.split('-').map(Number);
      await refreshEvents(y, m);
      onSaved(); close();
    } catch {
      setError('保存失败，请重试'); setStep('confirm');
    }
  };

  const fmtDate = (d: string) => d.replace(/-/g, '/');
  const fmtDateRange = (draft: ParseResult) => {
    if (draft.end_date && draft.end_date !== draft.start_date) {
      return `${fmtDate(draft.start_date)} – ${fmtDate(draft.end_date)}`;
    }
    return fmtDate(draft.start_date);
  };
  const fmtTime = (t: string | null) => t ?? '全天';
  const sourceLabel = (source: ParseResult['parse_source']) => {
    if (source === 'rules') return '规则解析';
    if (source === 'clarified') return '补充解析';
    return 'AI解析';
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <KeyboardAvoidingView
        style={s.overlay} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={s.sheet}>
          {/* Handle */}
          <View style={s.handle} />

          {/* ── Input step ── */}
          {(step === 'input' || step === 'recording') && (
            <>
              <Text style={s.title}>说出你的日常</Text>
              <Text style={s.hint}>例如：明天下午三点开会，下周一提醒我发周报</Text>

              <TextInput
                style={s.textBox}
                placeholder="输入或说出日程内容…"
                placeholderTextColor={C.faint}
                value={text}
                onChangeText={setText}
                multiline
                maxLength={200}
                editable={step === 'input'}
              />

              <View style={s.errorSlot}>
                {error ? <Text style={s.errText}>{error}</Text> : null}
              </View>

              <View style={s.actionDock}>
                <View style={s.actionSide}>
                  {step === 'recording' && (
                    <Text style={s.recordingLabel} numberOfLines={2}>
                      {recordingMode === 'realtime' ? '实时识别中，点击停止' : '录音中，点击停止'}
                    </Text>
                  )}
                </View>

                <TouchableOpacity
                  style={s.micTouch}
                  onPress={step === 'recording' ? stopRecording : startRecording}
                  activeOpacity={0.8}
                >
                  <LinearGradient
                    colors={step === 'recording' ? ['#FF4D4F','#CC2222'] : [C.gradFrom, C.gradTo]}
                    style={s.micBtn}
                  >
                    <Ionicons
                      name={step === 'recording' ? 'stop' : 'mic'}
                      size={26} color="#fff"
                    />
                  </LinearGradient>
                </TouchableOpacity>

                <View style={[s.actionSide, s.actionSideRight]}>
                  {text.trim().length > 0 && step === 'input' && (
                    <TouchableOpacity style={s.submitBtn} onPress={handleSubmitText}>
                      <Text style={s.submitTxt}>解析</Text>
                      <Ionicons name="arrow-forward" size={14} color="#fff" />
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            </>
          )}

          {/* ── Parsing / saving ── */}
          {(step === 'parsing' || step === 'saving') && (
            <View style={s.loadingWrap}>
              <ActivityIndicator size="large" color={C.purple} />
              <Text style={s.loadingTxt}>
                {step === 'parsing' ? '正在解析…' : '正在保存…'}
              </Text>
            </View>
          )}

          {/* ── Confirm step ── */}
          {step === 'confirm' && draft && (
            <>
              <Text style={s.title}>确认日程</Text>

              {draft.needs_clarification && draft.clarification_question && (
                <>
                  <View style={s.clarifyBox}>
                    <Ionicons name="help-circle-outline" size={16} color={C.orange} />
                    <Text style={s.clarifyTxt}>{draft.clarification_question}</Text>
                  </View>
                  <View style={s.clarifyAnswerRow}>
                    <TextInput
                      style={s.clarifyInput}
                      value={clarifyAnswer}
                      onChangeText={setClarifyAnswer}
                      placeholder="补充答案"
                      placeholderTextColor={C.faint}
                      returnKeyType="done"
                      onSubmitEditing={handleClarify}
                    />
                    <TouchableOpacity
                      onPress={handleClarify}
                      disabled={!clarifyAnswer.trim()}
                      style={[s.clarifyBtn, !clarifyAnswer.trim() && { opacity: 0.4 }]}
                    >
                      <Text style={s.clarifyBtnText}>补充解析</Text>
                    </TouchableOpacity>
                  </View>
                </>
              )}

              <View style={s.draftCard}>
                {text.trim() && (
                  <View style={s.recognizedBox}>
                    <Ionicons name="chatbubble-ellipses-outline" size={14} color={C.sub} />
                    <Text style={s.recognizedText}>{text.trim()}</Text>
                  </View>
                )}
                <Text style={s.draftTitle}>{draft.title}</Text>
                <View style={s.draftRow}>
                  <Ionicons name="calendar-outline" size={14} color={C.sub} />
                  <Text style={s.draftVal}>{fmtDateRange(draft)}</Text>
                </View>
                <View style={s.draftRow}>
                  <Ionicons name="time-outline" size={14} color={C.sub} />
                  <Text style={s.draftVal}>{fmtTime(draft.start_time)}
                    {draft.end_time ? ` – ${draft.end_time}` : ''}
                  </Text>
                </View>
                {draft.description && (
                  <View style={s.draftRow}>
                    <Ionicons name="document-text-outline" size={14} color={C.sub} />
                    <Text style={s.draftVal}>{draft.description}</Text>
                  </View>
                )}
                {draft.detail && draft.detail !== draft.description && (
                  <View style={s.draftRow}>
                    <Ionicons name="reader-outline" size={14} color={C.sub} />
                    <Text style={s.draftVal}>{draft.detail}</Text>
                  </View>
                )}
                {draft.location && (
                  <View style={s.draftRow}>
                    <Ionicons name="location-outline" size={14} color={C.sub} />
                    <Text style={s.draftVal}>{draft.location}</Text>
                  </View>
                )}
                {draft.category && (
                  <View style={s.draftRow}>
                    <Ionicons name="pricetag-outline" size={14} color={C.sub} />
                    <Text style={s.draftVal}>{draft.category}</Text>
                  </View>
                )}
                {draft.status && (
                  <View style={s.draftRow}>
                    <Ionicons name="ellipse-outline" size={14} color={C.sub} />
                    <Text style={s.draftVal}>{draft.status}</Text>
                  </View>
                )}
                <Text style={s.draftMeta}>
                  {sourceLabel(draft.parse_source)}
                </Text>
              </View>

              {error ? <Text style={s.errText}>{error}</Text> : null}

              <View style={s.confirmRow}>
                <TouchableOpacity style={s.cancelBtn} onPress={returnToInput}>
                  <Text style={s.cancelTxt}>重新输入</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={handleSave} activeOpacity={0.85}>
                  <LinearGradient colors={[C.gradFrom, C.gradTo]} style={s.saveBtn}>
                    <Text style={s.saveTxt}>保存日程</Text>
                  </LinearGradient>
                </TouchableOpacity>
              </View>
            </>
          )}

          <TouchableOpacity style={s.closeBtn} onPress={close} hitSlop={{ top:10,bottom:10,left:10,right:10 }}>
            <Ionicons name="close" size={20} color={C.sub} />
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay:      { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet:        { backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, paddingBottom: 36, minHeight: 320 },
  handle:       { width: 40, height: 4, borderRadius: 2, backgroundColor: C.border, alignSelf: 'center', marginBottom: 16 },
  title:        { fontSize: 17, fontWeight: '700', color: C.text, marginBottom: 4 },
  hint:         { fontSize: 12, color: C.sub, marginBottom: 14 },
  textBox:      { backgroundColor: C.inputBg, borderRadius: 14, padding: 12, fontSize: 14, color: C.text, minHeight: 80, textAlignVertical: 'top', marginBottom: 8 },
  errorSlot:    { minHeight: 38, justifyContent: 'center', marginBottom: 8 },
  errText:      { fontSize: 12, lineHeight: 17, color: C.red },
  actionDock:   { height: 64, flexDirection: 'row', alignItems: 'center' },
  actionSide:   { flex: 1, minWidth: 0, justifyContent: 'center' },
  actionSideRight:{ alignItems: 'flex-end' },
  micTouch:     { width: 72, alignItems: 'center', justifyContent: 'center' },
  micBtn:       { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
  recordingLabel:{ fontSize: 12, lineHeight: 16, color: C.red },
  submitBtn:    { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: C.purple, borderRadius: 20, paddingHorizontal: 18, paddingVertical: 10 },
  submitTxt:    { fontSize: 14, fontWeight: '600', color: '#fff' },
  loadingWrap:  { alignItems: 'center', paddingVertical: 40, gap: 14 },
  loadingTxt:   { fontSize: 14, color: C.sub },
  clarifyBox:   { flexDirection: 'row', alignItems: 'flex-start', gap: 6, backgroundColor: '#FFF8E1', borderRadius: 10, padding: 10, marginBottom: 12 },
  clarifyTxt:   { flex: 1, fontSize: 13, color: C.text },
  clarifyAnswerRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  clarifyInput: { flex: 1, backgroundColor: C.inputBg, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: C.text },
  clarifyBtn:   { backgroundColor: C.orange, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10 },
  clarifyBtnText:{ fontSize: 13, fontWeight: '700', color: '#fff' },
  draftCard:    { backgroundColor: C.tasksBg, borderRadius: 16, padding: 16, marginBottom: 16, gap: 10 },
  recognizedBox:{ flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingBottom: 4 },
  recognizedText:{ flex: 1, fontSize: 12, lineHeight: 17, color: C.sub },
  draftTitle:   { fontSize: 17, fontWeight: '700', color: C.text },
  draftRow:     { flexDirection: 'row', alignItems: 'center', gap: 8 },
  draftVal:     { fontSize: 13, color: C.text },
  draftMeta:    { fontSize: 11, color: C.faint, marginTop: 4 },
  confirmRow:   { flexDirection: 'row', gap: 12 },
  cancelBtn:    { flex: 1, borderRadius: 20, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center', paddingVertical: 12 },
  cancelTxt:    { fontSize: 14, color: C.sub },
  saveBtn:      { flex: 1, borderRadius: 20, paddingVertical: 12, paddingHorizontal: 24, alignItems: 'center', justifyContent: 'center' },
  saveTxt:      { fontSize: 14, fontWeight: '700', color: '#fff' },
  closeBtn:     { position: 'absolute', top: 16, right: 16 },
});
