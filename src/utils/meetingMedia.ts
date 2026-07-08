type TranscriptLike = {
  start_time?: number;
  end_time?: number;
  confidence?: number;
  text?: string;
};

export function transcriptDurationSec(items: TranscriptLike[]): number | undefined {
  const end = items.reduce((max, item) => {
    const value = typeof item.end_time === 'number' ? item.end_time : 0;
    return Number.isFinite(value) && value > max ? value : max;
  }, 0);
  return end > 0 ? end : undefined;
}

export function formatDuration(seconds?: number): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return '—';
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function transcriptToBars(items: TranscriptLike[], count = 40): number[] {
  const duration = transcriptDurationSec(items);
  if (!duration || count <= 0) return [];
  const bars = Array.from({ length: count }, () => 0.16);

  for (const item of items) {
    const start = Math.max(0, typeof item.start_time === 'number' ? item.start_time : 0);
    const end = Math.max(start, typeof item.end_time === 'number' ? item.end_time : start);
    const startIdx = Math.max(0, Math.min(count - 1, Math.floor((start / duration) * count)));
    const endIdx = Math.max(startIdx, Math.min(count - 1, Math.ceil((end / duration) * count)));
    const confidence = typeof item.confidence === 'number' && Number.isFinite(item.confidence)
      ? item.confidence
      : 0.45;
    const textWeight = Math.min(0.35, (item.text?.length ?? 0) / 180);
    const amp = Math.max(0.22, Math.min(0.95, 0.24 + confidence * 0.44 + textWeight));
    for (let i = startIdx; i <= endIdx; i += 1) {
      bars[i] = Math.max(bars[i], amp);
    }
  }

  return bars;
}

export function fallbackMeetingBars(seed: string, count = 40): number[] {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Array.from({ length: count }, (_, i) => {
    hash ^= i + 1;
    hash = Math.imul(hash, 16777619);
    const value = (hash >>> 0) / 0xffffffff;
    return 0.22 + value * 0.58;
  });
}
