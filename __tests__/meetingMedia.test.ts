import {
  fallbackMeetingBars,
  formatDuration,
  transcriptDurationSec,
  transcriptToBars,
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

  it('builds normalized bars from transcript segments', () => {
    const bars = transcriptToBars([
      { start_time: 0, end_time: 5, text: 'hello', confidence: 0.9 },
      { start_time: 5, end_time: 10, text: 'world', confidence: 0.3 },
    ], 8);

    expect(bars).toHaveLength(8);
    expect(bars.every(v => v >= 0 && v <= 1)).toBe(true);
    expect(Math.max(...bars)).toBeGreaterThan(0.5);
  });

  it('returns stable fallback bars for the same meeting id', () => {
    expect(fallbackMeetingBars('meeting-1', 6)).toEqual(fallbackMeetingBars('meeting-1', 6));
    expect(fallbackMeetingBars('meeting-1', 6)).not.toEqual(fallbackMeetingBars('meeting-2', 6));
  });
});
