const {
  describeError,
  editDistance,
  normalize,
  percentile,
  similarity,
} = require('../scripts/benchmark_realtime_asr') as {
  describeError: (error: unknown) => string;
  editDistance: (left: string, right: string) => number;
  normalize: (value: unknown) => string;
  percentile: (values: number[], fraction: number) => number | null;
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
});
