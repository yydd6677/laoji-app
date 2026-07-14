const {
  metric,
  sampleFile,
  validateBaseUrl,
} = require('../scripts/benchmark_registered_speaker_asr') as {
  metric: (rows: Array<{ timing: Record<string, number | null> }>, field: string) => Record<string, number | null>;
  sampleFile: (manifestPath: string, sample: { id: string; files: Record<string, string> }, format: string) => string;
  validateBaseUrl: (value: string) => string;
};

describe('registered speaker ASR benchmark helpers', () => {
  test('normalizes safe base URLs and rejects embedded credentials', () => {
    expect(validateBaseUrl('https://api.example.com/')).toBe('https://api.example.com');
    expect(() => validateBaseUrl('https://user:pass@example.com')).toThrow();
    expect(() => validateBaseUrl('file:///tmp/api')).toThrow();
  });

  test('summarizes finite timing values with nearest-rank percentiles', () => {
    const rows = [1, 2, 3, 100, Number.NaN].map(value => ({ timing: { tail: value } }));
    expect(metric(rows, 'tail')).toEqual({ min: 1, median: 2, p95: 100, max: 100 });
  });

  test('rejects a sample without the requested format', () => {
    expect(() => sampleFile('/tmp/manifest.json', { id: 'x', files: {} }, 'wav')).toThrow(
      'sample x has no wav file',
    );
  });
});
