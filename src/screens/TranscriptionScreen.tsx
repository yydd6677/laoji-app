import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, ScrollView, TouchableOpacity, StyleSheet, Share, ActivityIndicator } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { Colors as C } from '../theme/colors';
import { ScreenContainer } from '../components/ScreenContainer';

import { RootStackParamList, TranscriptLine } from '../types';
import { useMeetings } from '../store/MeetingsStore';
import { fetchMeetingTranscript, fetchMeetingSummary } from '../services/api';
import { generateSummaryForMeeting, meetingSummaryToText } from '../services/meetingSummary';
import { BackHeader, Waveform } from '../components/Common';
import { BottomTabBar } from '../components/BottomTabBar';
import { openMeetingsTab, openScheduleTab } from '../navigation/tabTargets';
import { fallbackMeetingBars, formatDuration, transcriptDurationSec, transcriptToBars } from '../utils/meetingMedia';
import { useAppDialog } from '../components/AppDialog';
import { useAuth } from '../store/AuthStore';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Transcription'>;
  route: RouteProp<RootStackParamList, 'Transcription'>;
};

function SCard({ num, title, badge, children }: {
  num: number; title: string; badge?: string; children: React.ReactNode;
}) {
  return (
    <View style={s.scard}>
      <View style={s.scardHeader}>
        <View style={s.numCircle}>
          <Text style={s.numText}>{num}</Text>
        </View>
        <Text style={s.scardTitle}>{title}</Text>
        {badge && (
          <View style={s.badge}>
            <Text style={s.badgeText}>{badge}</Text>
          </View>
        )}
      </View>
      {children}
    </View>
  );
}

function safeFileName(name: string): string {
  return name.trim().replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_').slice(0, 40) || 'laoji_transcript';
}

export function TranscriptionScreen({ navigation, route }: Props) {
  const {
    meetings,
    updateMeetingTitle,
    getCachedTranscript,
    saveCachedTranscript,
    getCachedSummary,
    saveCachedSummary,
  } = useMeetings();
  const { accessToken, isGuest } = useAuth();
  const { showDialog } = useAppDialog();
  const m = meetings.find(x => x.id === route.params.meetingId);
  const [titleEdit, setTitleEdit] = useState(m?.title ?? '');
  const [transcriptItems, setTranscriptItems] = useState<TranscriptLine[]>([]);
  const [summary, setSummary] = useState('');
  const [loadingTranscript, setLoadingTranscript] = useState(false);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [titleSaving, setTitleSaving] = useState(false);

  useEffect(() => {
    if (m) setTitleEdit(m.title);
  }, [m?.id, m?.title]);

  useEffect(() => {
    if (!m) return;
    let alive = true;
    const cachedTranscript = getCachedTranscript(m.id);
    const cachedSummary = meetingSummaryToText(getCachedSummary(m.id));
    setTranscriptItems(cachedTranscript);
    setSummary(cachedSummary);

    setLoadingTranscript(true);
    if (isGuest || !accessToken) {
      setLoadingTranscript(false);
    } else {
      fetchMeetingTranscript(m.id, accessToken)
        .then(items => {
          if (!alive) return;
          if (items.length > 0) {
            setTranscriptItems(items);
            void saveCachedTranscript(m.id, items);
          }
        })
        .catch(() => {})
        .finally(() => { if (alive) setLoadingTranscript(false); });
    }

    if (m.hasSummary && !isGuest && accessToken) {
      setLoadingSummary(true);
      fetchMeetingSummary(m.id, accessToken)
        .then(text => {
          if (!alive) return;
          setSummary(text || cachedSummary);
          if (text) void saveCachedSummary(m.id, { meeting_id: m.id, full_text: text, generated_at: new Date().toISOString() });
        })
        .catch(() => {})
        .finally(() => { if (alive) setLoadingSummary(false); });
    }
    return () => { alive = false; };
  }, [
    accessToken,
    getCachedSummary,
    getCachedTranscript,
    isGuest,
    m?.hasSummary,
    m?.id,
    saveCachedSummary,
    saveCachedTranscript,
  ]);

  if (!m) {
    return (
      <ScreenContainer edges={['top']}>
        <BackHeader title="会议转写" onBack={() => navigation.goBack()} />
        <View style={s.emptyWrap}>
          <Text style={s.emptyTitle}>会议记录不存在</Text>
          <Text style={s.emptyText}>请返回会议列表后重新打开。</Text>
        </View>
        <BottomTabBar
          active="meetings"
          onSchedule={() => openScheduleTab(navigation)}
          onMeetings={() => openMeetingsTab(navigation)}
          onMic={() => navigation.navigate('MeetingLive')}
        />
      </ScreenContainer>
    );
  }

  const transcriptionText = transcriptItems.length > 0
    ? transcriptItems.map(t => `[${t.speaker_label ?? t.speaker_id ?? '发言人'}] ${t.text}`).join('\n')
    : '暂无转写内容';
  const recordingBars = transcriptToBars(transcriptItems, 24);
  const visibleBars = recordingBars.length > 0 ? recordingBars : fallbackMeetingBars(m.id, 24);
  const recordingDuration = formatDuration(transcriptDurationSec(transcriptItems));

  const commitTitle = async () => {
    const t = titleEdit.trim();
    if (!t || t === m.title || titleSaving) return;
    setTitleSaving(true);
    try {
      await updateMeetingTitle(m.id, t);
    } catch {
      showDialog({ title: '保存失败', message: '会议标题更新失败，请稍后重试', tone: 'error' });
    } finally {
      setTitleSaving(false);
    }
  };

  const handleGenerateSummary = async () => {
    if (transcriptItems.length === 0) {
      showDialog({ title: '暂无转写', message: '需要先有会议转写内容，才能生成总结。', tone: 'info' });
      return;
    }
    setLoadingSummary(true);
    try {
      const generated = await generateSummaryForMeeting({
        meetingId: m.id,
        title: m.title,
        transcriptLines: transcriptItems,
        isGuest,
        accessToken,
      });
      const text = meetingSummaryToText(generated);
      setSummary(text || '暂无总结内容');
      await saveCachedSummary(m.id, generated);
    } catch {
      showDialog({ title: '生成失败', message: '会议总结生成失败，请稍后重试。', tone: 'error' });
    } finally {
      setLoadingSummary(false);
    }
  };

  const handleExportTxt = async () => {
    const txtContent = [
      m.title,
      m.date + ' ' + m.time,
      '转写内容：',
      transcriptionText,
      summary ? `会议总结：\n${summary}` : '',
    ].filter(Boolean).join('\n\n');
    try {
      const fileUri = `${FileSystem.cacheDirectory}${safeFileName(m.title)}_转写.txt`;
      await FileSystem.writeAsStringAsync(fileUri, txtContent, { encoding: FileSystem.EncodingType.UTF8 });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(fileUri, {
          mimeType: 'text/plain',
          dialogTitle: '导出会议转写',
          UTI: 'public.plain-text',
        });
      } else {
        await Share.share({ message: txtContent, title: m.title + '_转写.txt' });
      }
    } catch {
      showDialog({ title: '导出失败', message: '转写文件生成失败，请稍后重试。', tone: 'error' });
    }
  };

  const handleShareSummary = async () => {
    const content = summary.trim();
    if (!content) {
      showDialog({ title: '暂无总结', message: m.hasSummary ? '暂无总结内容' : '该会议暂未生成总结', tone: 'info' });
      return;
    }
    try {
      await Share.share({
        message: [m.title, m.date + ' ' + (m.time ?? ''), '会议总结：', content].join('\n\n'),
        title: m.title + '_总结.md',
      });
    } catch (_) {}
  };

  const handleShare = async () => {
    try {
      await Share.share({
        message:
          m.title +
          '\n' +
          m.date +
          ' ' +
          m.time +
          '\n\n转写内容：\n' +
          transcriptionText,
      });
    } catch (_) {}
  };

  return (
    <ScreenContainer edges={['top']}>
      <BackHeader
        title="会议转写"
        onBack={() => navigation.goBack()}
        right={<TouchableOpacity onPress={handleShare} hitSlop={{ top:8,bottom:8,left:8,right:8 }}>
          <Ionicons name="share-outline" size={20} color={C.sub} />
        </TouchableOpacity>}
      />
      <ScrollView style={s.scroll} contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>

        <SCard num={1} title="日期">
          <Text style={s.bodyText}>{[m.date, m.time].filter(Boolean).join('　')}</Text>
        </SCard>

        <SCard num={2} title="录音">
          <View style={s.miniPlayer}>
            <TouchableOpacity
              style={s.miniPlayBtn}
              onPress={() => navigation.navigate('Recording', { meetingId: m.id })}
              activeOpacity={0.8}
            >
              <Ionicons name="mic-outline" size={14} color="#fff" />
            </TouchableOpacity>
            <View style={{ flex: 1 }}>
              <Waveform bars={visibleBars} color={C.purple} height={28} />
            </View>
            <View style={s.miniTime}>
              <Text style={s.miniTimeText}>00:00</Text>
              <Text style={s.miniTimeText}>{recordingDuration}</Text>
            </View>
          </View>
        </SCard>

        <SCard num={3} title="录音标题">
          <View style={s.titleField}>
            <TextInput
              style={[s.titleFieldText, { flex: 1, padding: 0 }]}
              value={titleEdit}
              onChangeText={setTitleEdit}
              onBlur={commitTitle}
              onSubmitEditing={commitTitle}
              editable={!titleSaving}
              returnKeyType="done"
            />
            <Ionicons name="pencil-outline" size={14} color={C.sub} />
          </View>
        </SCard>

        <SCard num={4} title="转写文本">
          {loadingTranscript ? (
            <ActivityIndicator size="small" color={C.purple} style={s.inlineLoading} />
          ) : (
            <Text style={s.transcript}>{transcriptionText}</Text>
          )}
        </SCard>

        <SCard num={5} title="AI 会议总结" badge="AI 生成">
          {loadingSummary ? (
            <ActivityIndicator size="small" color={C.purple} style={s.inlineLoading} />
          ) : summary ? (
            <Text style={s.summaryText}>{summary}</Text>
          ) : (
            <Text style={s.emptyText}>{m.hasSummary ? '暂无总结内容' : '该会议暂未生成总结'}</Text>
          )}
          {!loadingSummary && !summary ? (
            <TouchableOpacity style={s.generateBtn} onPress={handleGenerateSummary} activeOpacity={0.84}>
              <Ionicons name="sparkles-outline" size={14} color="#fff" />
              <Text style={s.generateText}>生成总结</Text>
            </TouchableOpacity>
          ) : null}
        </SCard>

        <View style={s.exportRow}>
          <TouchableOpacity
            style={[s.exportBtn, { backgroundColor: C.blue + '14', borderColor: C.blue + '44' }]}
            onPress={handleExportTxt}
          >
            <Text style={[s.exportText, { color: C.blue }]}>导出 TXT</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.exportBtn, { backgroundColor: C.purple + '14', borderColor: C.purple + '44' }]}
            onPress={handleShareSummary}
          >
            <Text style={[s.exportText, { color: C.purple }]}>分享总结</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.exportBtn, { backgroundColor: C.teal + '14', borderColor: C.teal + '44' }]}
            onPress={handleShare}
          >
            <Text style={[s.exportText, { color: C.teal }]}>分享转写</Text>
          </TouchableOpacity>
        </View>
        <View style={{ height: 16 }} />
      </ScrollView>
      <BottomTabBar
        active="meetings"
        onSchedule={() => openScheduleTab(navigation)}
        onMeetings={() => openMeetingsTab(navigation)}
        onMic={() => navigation.navigate('MeetingLive')}
      />
    </ScreenContainer>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.appBg },
  scroll: { flex: 1 },
  content: { padding: 14 },
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  emptyTitle: { fontSize: 17, fontWeight: '700', color: C.text, marginBottom: 8 },
  emptyText: { fontSize: 13, color: C.sub, lineHeight: 20 },
  scard: {
    backgroundColor: C.card, borderRadius: 16, padding: 14, paddingHorizontal: 16, marginBottom: 12,
    shadowColor: '#5028A0', shadowOffset: { width:0,height:1 }, shadowOpacity:0.05, shadowRadius:8, elevation:2,
  },
  scardHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  numCircle: { width: 22, height: 22, borderRadius: 11, backgroundColor: C.purpleDark, alignItems: 'center', justifyContent: 'center' },
  numText: { fontSize: 11, fontWeight: '700', color: '#fff' },
  scardTitle: { fontSize: 14, fontWeight: '700', color: C.text },
  badge: { backgroundColor: '#FFE8F0', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 1 },
  badgeText: { fontSize: 10, color: C.pink, fontWeight: '600' },
  bodyText: { fontSize: 14, color: C.text },
  miniPlayer: { backgroundColor: C.purpleLight, borderRadius: 12, padding: 12, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 12 },
  miniPlayBtn: { width: 32, height: 32, borderRadius: 16, backgroundColor: C.purple, alignItems: 'center', justifyContent: 'center' },
  miniTime: { alignItems: 'flex-end' },
  miniTimeText: { fontSize: 11, color: C.sub },
  titleField: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#F6F2FF', borderRadius: 10, padding: 10, paddingHorizontal: 14 },
  titleFieldText: { fontSize: 14, fontWeight: '500', color: C.text },
  transcript: { fontSize: 13, color: '#4A4666', lineHeight: 26 },
  summaryText: { fontSize: 13, color: '#4A4666', lineHeight: 26 },
  inlineLoading: { marginVertical: 10 },
  generateBtn: { marginTop: 12, alignSelf: 'flex-start', height: 34, borderRadius: 17, paddingHorizontal: 14, backgroundColor: C.purple, flexDirection: 'row', alignItems: 'center', gap: 6 },
  generateText: { fontSize: 12, color: '#fff', fontWeight: '800' },
  exportRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  exportBtn: { flex: 1, height: 38, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  exportText: { fontSize: 11, fontWeight: '600' },
});
