const {
  crossSessionContamination,
  describeError,
  editDistance,
  missingCriticalTerms,
  normalize,
  percentile,
  sampleBatches,
  similarity,
} = require('../scripts/benchmark_realtime_asr') as {
  crossSessionContamination: (expected: string, actual: string, others: string[]) => string[];
  describeError: (error: unknown) => string;
  editDistance: (left: string, right: string) => number;
  missingCriticalTerms: (actual: string, terms?: string[]) => string[];
  normalize: (value: unknown) => string;
  percentile: (values: number[], fraction: number) => number | null;
  sampleBatches: <T>(samples: T[], level: number, sweepAll: boolean) => T[][];
  similarity: (left: string, right: string) => number;
};

describe('realtime ASR benchmark helpers', () => {
  test('normalizes punctuation, spacing, and case', () => {
    expect(normalize(' Tomorrow, 10:00! ')).toBe('tomorrow1000');
    expect(normalize('明天下午三点，开会。')).toBe('明天下午三点开会');
  });

  test('computes edit distance without mutating the input', () => {
    const left = '明天下午三点开会';
    const right = '明天下午四点开会';
    expect(editDistance(left, right)).toBe(1);
    expect(left).toBe('明天下午三点开会');
    expect(right).toBe('明天下午四点开会');
  });

  test('scores punctuation-only differences as exact', () => {
    expect(similarity('明天下午三点开会', '明天下午三点，开会。')).toBe(1);
  });

  test('penalizes missing schedule content', () => {
    expect(similarity('明天下午三点开会', '下午三点开会')).toBeLessThan(0.85);
  });

  test('requires critical semantic terms after punctuation normalization', () => {
    expect(missingCriticalTerms(
      '最终决定采用方案乙，不再继续评估方案甲。',
      ['方案乙', '不再继续评估方案甲'],
    )).toEqual([]);
    expect(missingCriticalTerms(
      '会议模块研期到下周。',
      ['会议模块', '延期到下周'],
    )).toEqual(['延期到下周']);
    expect(missingCriticalTerms('任意文本')).toEqual([]);
  });

  test('uses nearest-rank percentiles for small samples', () => {
    expect(percentile([], 0.95)).toBeNull();
    expect(percentile([4, 1, 3, 2], 0.5)).toBe(2);
    expect(percentile([4, 1, 3, 2], 0.95)).toBe(4);
  });

  test('preserves the transport cause in probe errors', () => {
    const error = new Error('fetch failed', {
      cause: { code: 'ECONNRESET', message: 'socket closed' },
    });
    expect(describeError(error)).toBe('fetch failed: ECONNRESET: socket closed');
  });

  test('keeps the legacy first-batch mode and can sweep every selected sample', () => {
    expect(sampleBatches(['a', 'b', 'c', 'd', 'e'], 2, false)).toEqual([['a', 'b']]);
    expect(sampleBatches(['a', 'b', 'c', 'd', 'e'], 2, true)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e'],
    ]);
  });

  test('does not report an expected overlapping phrase as cross-session contamination', () => {
    expect(crossSessionContamination(
      '明天下午三点开会提前十五分钟提醒我',
      '明天下午三点开会，提前十五分钟提醒我。',
      ['明天下午三点开会', '后天上午九点上课'],
    )).toEqual([]);
    expect(crossSessionContamination(
      '明天下午三点开会',
      '明天下午三点开会，后天上午九点上课。',
      ['后天上午九点上课'],
    )).toEqual(['后天上午九点上课']);
  });
});
