import {
  audioSamplesToBars,
  canResumeMeetingRecording,
  formatDuration,
  latestTranscriptWindow,
  MEETING_PLAYBACK_RATES,
  nextMeetingPlaybackRate,
  pcmDurationSec,
  preferredMeetingStatusLabel,
  shouldReplayAudio,
  shouldCheckpointTranscript,
  transcriptDurationSec,
} from '../src/utils/meetingMedia';

describe('meeting media helpers', () => {
  it('formats transcript duration from segment end times', () => {
    const items = [
      { start_time: 0, end_time: 4.2, text: '开场' },
      { start_time: 5, end_time: 65.7, text: '讨论', confidence: 0.8 },
    ];

    expect(transcriptDurationSec(items)).toBeCloseTo(65.7);
    expect(formatDuration(transcriptDurationSec(items))).toBe('01:06');
  });

  it('calculates PCM duration from the actual captured byte count', () => {
    expect(pcmDurationSec(32000)).toBe(1);
    expect(pcmDurationSec(128000)).toBe(4);
    expect(pcmDurationSec(0)).toBeUndefined();
  });

  it('downsamples real RMS samples into normalized waveform bars', () => {
    const bars = audioSamplesToBars([10, 20, 40, 80, 20, 10, 5, 2], 4);

    expect(bars).toHaveLength(4);
    expect(bars.every(v => v >= 0.04 && v <= 1)).toBe(true);
    expect(Math.max(...bars)).toBe(1);
  });

  it('restarts completed audio while preserving paused positions', () => {
    expect(shouldReplayAudio(88000, 88000)).toBe(true);
    expect(shouldReplayAudio(87800, 88000)).toBe(true);
    expect(shouldReplayAudio(42000, 88000)).toBe(false);
  });

  it('cycles through the source-derived seven playback rates', () => {
    const visited: number[] = [];
    let current = 1;
    for (let index = 0; index < MEETING_PLAYBACK_RATES.length; index += 1) {
      current = nextMeetingPlaybackRate(current);
      visited.push(current);
    }

    expect(MEETING_PLAYBACK_RATES).toEqual([0.5, 0.75, 1, 1.25, 1.5, 2, 3]);
    expect(visited).toEqual([1.25, 1.5, 2, 3, 0.5, 0.75, 1]);
  });

  it('renders only the latest live transcript window without dropping stored lines', () => {
    const all = Array.from({ length: 75 }, (_, index) => ({ id: index + 1 }));
    const result = latestTranscriptWindow(all, 40);

    expect(result.hiddenCount).toBe(35);
    expect(result.items).toHaveLength(40);
    expect(result.items[0]).toEqual({ id: 36 });
    expect(result.items.at(-1)).toEqual({ id: 75 });
    expect(all).toHaveLength(75);
  });

  it('checkpoints the first transcript line, then batches later durable writes', () => {
    expect(shouldCheckpointTranscript(1, 0, 0)).toBe(true);
    expect(shouldCheckpointTranscript(2, 1, 2_000)).toBe(false);
    expect(shouldCheckpointTranscript(5, 1, 5_000)).toBe(true);
    expect(shouldCheckpointTranscript(3, 1, 10_000)).toBe(true);
    expect(shouldCheckpointTranscript(0, 0, 20_000)).toBe(false);
  });

  it('resumes only unfinished meetings that have no saved recording', () => {
    expect(canResumeMeetingRecording({ status: 'created' })).toBe(true);
    expect(canResumeMeetingRecording({ status: 'recording' })).toBe(true);
    expect(canResumeMeetingRecording({ status: 'failed' })).toBe(true);
    expect(canResumeMeetingRecording({ status: 'ended' })).toBe(false);
    expect(canResumeMeetingRecording({ status: 'completed' })).toBe(false);
    expect(canResumeMeetingRecording({ status: 'failed', audioLocalUri: 'file:///meeting.wav' })).toBe(false);
    expect(canResumeMeetingRecording({ status: 'recording', audioAvailable: true })).toBe(false);
  });

  it('surfaces blocked or pending audio sync ahead of the lifecycle tag', () => {
    expect(preferredMeetingStatusLabel([
      { label: '已完成' },
      { label: '上传受阻' },
    ])).toBe('上传受阻');
    expect(preferredMeetingStatusLabel([
      { label: '录音中' },
      { label: '待上传' },
    ])).toBe('待上传');
    expect(preferredMeetingStatusLabel([{ label: '自定义标签' }])).toBe('自定义标签');
  });
});
