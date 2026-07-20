jest.mock('laoji-native-platform', () => ({
  MINUTES_SNAPSHOT_SCHEMA_VERSION: 1,
}));

import {
  buildNativeMinutesDetailSnapshot,
  buildNativeMinutesRecordingSnapshot,
  finalizedNativeMinutesTranscript,
  formatNativeMinutesTimestamp,
  mergeNativeMinutesTranscript,
  mergePersistedMinutesTranscript,
  NativeMinutesPageGenerationClock,
  nativeMinutesDetailRetryPlan,
  nativeMinutesSpeakers,
  normalizeNativeMinutesDetailPageStates,
  type NativeMinutesTranscriptEventLike,
} from '../src/native/nativeMinutesSnapshots';
import type { TranscriptLine } from '../src/types';

function line(overrides: Partial<TranscriptLine> = {}): TranscriptLine {
  return {
    id: 'line-1',
    text: '讨论发布安排',
    speaker_id: 'speaker-1',
    speaker_label: '张三',
    start_time: 1,
    end_time: 4,
    ...overrides,
  };
}

function event(overrides: Partial<NativeMinutesTranscriptEventLike> = {}): NativeMinutesTranscriptEventLike {
  return {
    sessionId: 'meeting-1',
    segmentId: 'segment-1',
    kind: 'partial',
    isFinal: false,
    text: '讨论发布',
    speakerId: 'speaker-1',
    speakerName: '张三',
    startMs: 1000,
    endMs: null,
    source: 'qwen3-asr',
    purpose: 'meeting',
    receivedAtMs: 1_000,
    ...overrides,
  };
}

describe('native Minutes snapshot contracts', () => {
  it('replaces a partial segment with its final transcript without duplicating it', () => {
    const partial = mergeNativeMinutesTranscript([], event(), 'meeting-1');
    const final = mergeNativeMinutesTranscript(partial, event({
      kind: 'final',
      isFinal: true,
      text: '讨论发布安排',
      endMs: 4_000,
      receivedAtMs: 4_000,
    }), 'meeting-1');

    expect(final).toHaveLength(1);
    expect(final[0]).toEqual(expect.objectContaining({ text: '讨论发布安排', isFinal: true }));
    expect(finalizedNativeMinutesTranscript(final)).toEqual([
      expect.objectContaining({ text: '讨论发布安排' }),
    ]);
  });

  it('does not mix a transcript event from another native session', () => {
    expect(mergeNativeMinutesTranscript([], event({ sessionId: 'other' }), 'meeting-1')).toEqual([]);
  });

  it('merges server-persisted rows ahead of local final rows by id or content fingerprint', () => {
    const local = [line({ id: 'native:meeting-1:segment-1' })];
    const remote = [line({ id: 'db-line-1' })];
    expect(mergePersistedMinutesTranscript(local, remote)).toEqual([
      expect.objectContaining({ id: 'db-line-1', text: '讨论发布安排' }),
    ]);
    expect(mergePersistedMinutesTranscript(
      [line({ id: 'local-only', start_time: 8, end_time: 9, text: '新的本机片段' })],
      remote,
    )).toHaveLength(2);
  });

  it('builds a stable low-frequency recording snapshot without waveform samples', () => {
    const snapshot = buildNativeMinutesRecordingSnapshot({
      meetingId: 'meeting-1',
      title: '发布会议',
      phase: 'recording',
      elapsedMs: 4_200,
      canPause: true,
      canStop: true,
      transcript: [line()],
    });

    expect(snapshot).toEqual(expect.objectContaining({ schemaVersion: 1, surface: 'recording' }));
    expect(snapshot.recording).not.toHaveProperty('waveform');
    expect(snapshot.recording?.transcript[0]).toEqual(expect.objectContaining({
      timestampLabel: '00:01',
      startMs: 1000,
    }));
  });

  it('builds supported detail tabs, read-only summary blocks, speakers, and a real player source', () => {
    const snapshot = buildNativeMinutesDetailSnapshot({
      meetingId: 'meeting-1',
      available: true,
      title: '发布会议',
      dateTimeLabel: '2026-07-16 10:00',
      activeTab: 'summary',
      transcript: [line(), line({ id: 'line-2', speaker_id: 'speaker-2', speaker_label: '李四', text: '确认时间', start_time: 5, end_time: 7 })],
      summaryText: '# 结论\n\n- [ ] 跟进发布\n\n1. 周五复盘',
      canShare: true,
      canManageSpeakers: true,
      canGenerateSummary: true,
      playerSource: {
        sourceId: 'cloud:meeting-1',
        uri: 'https://meeting.example.com/audio.wav',
        title: '发布会议',
        retainForBackground: true,
        storageScope: 'user:meeting-owner',
      },
    });

    expect(snapshot.detail?.summary.map(block => block.kind)).toEqual(['heading', 'bullet', 'ordered']);
    expect(snapshot.detail?.summary[1]).toEqual(expect.objectContaining({
      text: '待办：跟进发布',
      checked: undefined,
    }));
    expect(snapshot.detail?.speakers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'speaker-1', segmentCount: 1, canManage: true }),
      expect.objectContaining({ id: 'speaker-2', segmentCount: 1, canManage: true }),
    ]));
    expect(snapshot.detail?.playerSource?.uri).toBe('https://meeting.example.com/audio.wav');
    expect(snapshot.detail?.available).toBe(true);
    expect(snapshot.detail).not.toHaveProperty('chapters');
  });

  it('marks a missing meeting as unavailable so native actions stay disabled', () => {
    const snapshot = buildNativeMinutesDetailSnapshot({
      meetingId: 'missing-meeting',
      available: false,
      title: '会议记录不存在',
      activeTab: 'transcript',
      transcript: [],
      transcriptError: '请返回会议列表后重新打开。',
      canShare: true,
    });

    expect(snapshot.detail).toEqual(expect.objectContaining({
      available: false,
      contentPhase: 'error',
    }));
  });

  it('keeps transcript, summary, and speaker page states independent', () => {
    const snapshot = buildNativeMinutesDetailSnapshot({
      meetingId: 'meeting-1',
      title: '发布会议',
      activeTab: 'summary',
      transcript: [],
      transcriptError: '文字记录同步失败',
      summaryLoading: true,
      summaryProgress: '正在排队生成',
      pageGenerations: { transcript: 31, summary: 32, speakers: 33 },
    });

    expect(snapshot.detail?.pageStates).toEqual({
      transcript: { phase: 'error', message: '文字记录同步失败', generation: 31, cached: false },
      summary: { phase: 'loading', message: '正在排队生成', generation: 32, cached: false },
      speakers: { phase: 'empty', message: '暂无发言人信息', generation: 33, cached: false },
    });
    expect(snapshot.detail).toEqual(expect.objectContaining({
      contentPhase: 'loading',
      contentMessage: '正在排队生成',
    }));
    Object.values(snapshot.detail!.pageStates!).forEach(pageState => {
      expect(Object.values(pageState)).not.toContain(undefined);
    });
  });

  it('migrates a legacy global state only onto its active page', () => {
    expect(normalizeNativeMinutesDetailPageStates({
      activeTab: 'summary',
      contentPhase: 'error',
      contentMessage: '纪要同步失败',
      transcript: [{ id: 'line-1', text: '已有文字记录' }],
      summary: [],
      speakers: [],
    })).toEqual({
      transcript: { phase: 'ready', message: '', generation: 0, cached: false },
      summary: { phase: 'error', message: '纪要同步失败', generation: 0, cached: false },
      speakers: { phase: 'empty', message: '暂无发言人信息', generation: 0, cached: false },
    });
  });

  it('does not clear page state when the active tab changes', () => {
    const pageStates = {
      transcript: { phase: 'error', message: '文字记录失败', generation: 41, cached: true },
      summary: { phase: 'loading', message: '正在生成纪要', generation: 42, cached: true },
      speakers: { phase: 'empty', message: '暂无发言人', generation: 43, cached: false },
    } as const;

    const before = normalizeNativeMinutesDetailPageStates({ activeTab: 'transcript', pageStates });
    const after = normalizeNativeMinutesDetailPageStates({ activeTab: 'speakers', pageStates });

    expect(after).toEqual(before);
  });

  it('degrades unknown tabs, phases, messages, and generations deterministically', () => {
    expect(normalizeNativeMinutesDetailPageStates({
      activeTab: 'chapters',
      pageStates: {
        transcript: { phase: 'stale', message: null, generation: -9 },
        summary: { phase: 'error', message: '纪要失败', generation: Number.NaN },
      },
    })).toEqual({
      transcript: { phase: 'ready', message: '', generation: 0, cached: false },
      summary: { phase: 'error', message: '纪要失败', generation: 0, cached: false },
      speakers: { phase: 'empty', message: '暂无发言人信息', generation: 0, cached: false },
    });
  });

  it('keeps timestamp and empty speaker normalization deterministic', () => {
    const snapshot = buildNativeMinutesDetailSnapshot({
      meetingId: 'meeting-1',
      title: '发布会议',
      activeTab: 'speakers',
      transcript: [],
    });

    expect(snapshot.detail?.contentPhase).toBe('empty');
    expect(snapshot.detail?.contentMessage).toBe('暂无发言人信息');
    expect(formatNativeMinutesTimestamp(3661)).toBe('01:01:01');
    expect(nativeMinutesSpeakers([], false)).toEqual([]);
  });

  it('MIN-DETAIL-PAGER-001 advances real request generations independently and monotonically', () => {
    const clock = new NativeMinutesPageGenerationClock({ transcript: 7, summary: -3 });

    expect(clock.advance('transcript', 'speakers')).toEqual({ transcript: 8, summary: 0, speakers: 1 });
    expect(clock.advance('summary')).toEqual({ transcript: 8, summary: 1, speakers: 1 });
    expect(clock.advance('summary', 'summary')).toEqual({ transcript: 8, summary: 2, speakers: 1 });
  });

  it('MIN-DETAIL-PAGER-001 carries cached error and audio status combinations without undefined values', () => {
    const snapshot = buildNativeMinutesDetailSnapshot({
      meetingId: 'meeting-cached',
      title: '缓存会议',
      activeTab: 'summary',
      tabGeneration: 9,
      transcript: [line()],
      summaryText: '已有纪要',
      summaryError: '总结同步失败',
      pageGenerations: { transcript: 3, summary: 4, speakers: 3 },
      pageCached: { transcript: true, summary: true, speakers: true },
      audioStatusMessage: '仅有转写，无录音文件',
      audioErrorMessage: '录音同步失败',
    });

    expect(snapshot.detail).toEqual(expect.objectContaining({
      tabGeneration: 9,
      audioStatusMessage: '仅有转写，无录音文件',
      audioErrorMessage: '录音同步失败',
    }));
    expect(snapshot.detail?.pageStates?.summary).toEqual({
      phase: 'error',
      message: '总结同步失败',
      generation: 4,
      cached: true,
    });
  });

  it('MIN-DETAIL-PAGER-001 regenerates an existing cached summary when its warning is retried', () => {
    expect(nativeMinutesDetailRetryPlan('summary', true)).toEqual({
      kind: 'generateSummary',
      forceRegenerate: true,
    });
    expect(nativeMinutesDetailRetryPlan('transcript', true)).toEqual({ kind: 'reload' });
  });
});
