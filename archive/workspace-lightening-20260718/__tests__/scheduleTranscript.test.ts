import {
  ScheduleTranscriptSegment,
  appendScheduleTranscriptSegment,
  scheduleTranscriptDisplayText,
  scheduleTranscriptText,
} from '../src/services/scheduleTranscript';

function segment(text: string, receivedAt: number, startTime?: number, endTime?: number): ScheduleTranscriptSegment {
  return { text, receivedAt, startTime, endTime };
}

describe('scheduleTranscript', () => {
  it('replaces a shorter completion from the same audio timeline', () => {
    const first = [segment('下午三点开会', 1000, 0, 1.1)];
    const next = appendScheduleTranscriptSegment(first, segment('明天下午三点开会', 1600, 0, 1.5));
    expect(scheduleTranscriptText(next)).toBe('明天下午三点开会');
  });

  it('appends a genuinely new completed utterance', () => {
    const first = [segment('明天下午三点开会', 1000, 0, 1.5)];
    const next = appendScheduleTranscriptSegment(first, segment('不对，改成下午四点', 3000, 2.2, 3.5));
    expect(scheduleTranscriptText(next)).toBe('明天下午三点开会\n不对，改成下午四点');
  });

  it('does not replace a separate utterance only because it arrives soon after', () => {
    const first = [segment('下午三点开会', 1000)];
    const next = appendScheduleTranscriptSegment(first, segment('明天下午三点开会', 1500));

    expect(scheduleTranscriptDisplayText(next)).toBe('下午三点开会\n明天下午三点开会');
  });

  it('deduplicates the same schedule phrase when it is spoken again after a pause', () => {
    const first = [segment('明天下午三点开会', 1000, 0, 1.5)];
    const next = appendScheduleTranscriptSegment(first, segment('明天下午三点开会', 3000, 2.5, 4));
    expect(next).toBe(first);
  });

  it('deduplicates an immediate repeated websocket payload', () => {
    const first = [segment('明天下午三点开会', 1000, 0, 1.5)];
    const next = appendScheduleTranscriptSegment(first, segment('明天下午三点开会', 1100, 0, 1.5));
    expect(next).toBe(first);
  });

  it('drops a standalone filler completion after a real schedule', () => {
    const first = [segment('明天下午三点开会', 1000, 0, 1.5)];
    const next = appendScheduleTranscriptSegment(first, segment('嗯。', 2000, 2, 2.2));

    expect(next).toBe(first);
  });

  it('keeps filler prefixes and explicit corrections with schedule content', () => {
    const prefixed = appendScheduleTranscriptSegment([], segment('嗯，明天下午三点开会', 1000));
    const corrected = appendScheduleTranscriptSegment(prefixed, segment('不对，改成下午四点', 3000));

    expect(scheduleTranscriptText(corrected)).toBe('嗯，明天下午三点开会\n不对，改成下午四点');
  });

  it('drops explicit and repetitive ASR noise while preserving the useful schedule', () => {
    const segments = [
      segment('你的你你的你的t的。', 1000),
      segment('今天缴费还款。', 2000),
      segment('没有没有。', 3000),
    ];

    expect(scheduleTranscriptText(segments)).toBe('今天缴费还款。');
  });

  it('drops noisy and truncated duplicates from repeated acoustic playback', () => {
    const segments = [
      segment('十五号上午三点开会。', 1000),
      segment('没的没有。', 2000),
      segment('到上午三点开会。', 3000),
      segment('十五号上午三点开会。', 4000),
    ];

    expect(scheduleTranscriptText(segments)).toBe('十五号上午三点开会。');
    expect(scheduleTranscriptDisplayText(segments)).toBe(
      '十五号上午三点开会。\n没的没有。\n到上午三点开会。\n十五号上午三点开会。',
    );
  });

  it('keeps a distinct detail and an explicit correction after the main schedule', () => {
    const segments = [
      segment('十五号上午三点开会。', 1000),
      segment('地点在东门。', 2000),
      segment('不对，改成下午四点。', 3000),
    ];

    expect(scheduleTranscriptText(segments)).toBe(
      '十五号上午三点开会。\n地点在东门。\n不对，改成下午四点。',
    );
  });

  it('repairs a clipped temporal prefix without discarding short meaningful details', () => {
    const segments = [
      segment('天下午三点开会。', 1000),
      segment('取快递。', 2000),
      segment('会议室 B203。', 3000),
    ];

    expect(scheduleTranscriptText(segments)).toBe('明天下午三点开会。\n取快递。\n会议室 B203。');
  });

  it('removes a redundant first-person prefix before a temporal schedule', () => {
    expect(scheduleTranscriptText([
      segment('我明天下午三点开会。', 1000),
    ])).toBe('明天下午三点开会。');
  });

  it('repairs a narrow high-confidence hospital checkup homophone', () => {
    expect(scheduleTranscriptText([
      segment('明天早上八点半去医院提检。', 1000),
      segment('后天去医愿体检。', 2000),
    ])).toBe('明天早上八点半去医院体检。\n后天去医院体检。');
  });
});
