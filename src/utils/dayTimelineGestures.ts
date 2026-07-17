export type TimelineEditKind = 'move' | 'resize-start' | 'resize-end';

export type TimelineMinuteRange = { start: number; end: number };

export const TIMELINE_SNAP_MINUTES = 15;
export const TIMELINE_MIN_DURATION_MINUTES = 15;
const DAY_MINUTES = 24 * 60;

export function projectTimelineEdit({
  kind,
  original,
  deltaPixels,
  pixelsPerMinute,
  snapIntervalMinutes = TIMELINE_SNAP_MINUTES,
  minDurationMinutes = TIMELINE_MIN_DURATION_MINUTES,
}: {
  kind: TimelineEditKind;
  original: TimelineMinuteRange;
  deltaPixels: number;
  pixelsPerMinute: number;
  snapIntervalMinutes?: number;
  minDurationMinutes?: number;
}): TimelineMinuteRange {
  const deltaMinutes = snapMinutes(
    deltaPixels / Math.max(Number.EPSILON, pixelsPerMinute),
    snapIntervalMinutes,
  );
  if (kind === 'move') {
    const duration = original.end - original.start;
    const start = clamp(original.start + deltaMinutes, 0, DAY_MINUTES - duration);
    return { start, end: start + duration };
  }
  if (kind === 'resize-start') {
    return {
      start: clamp(
        original.start + deltaMinutes,
        0,
        original.end - minDurationMinutes,
      ),
      end: original.end,
    };
  }
  return {
    start: original.start,
    end: clamp(
      original.end + deltaMinutes,
      original.start + minDurationMinutes,
      DAY_MINUTES,
    ),
  };
}

export function timelineEdgeScrollStep(
  pointerY: number,
  viewportHeight: number,
  edgeSize = 64,
  maxStep = 28,
): number {
  if (viewportHeight <= edgeSize * 2) return 0;
  if (pointerY < edgeSize) {
    return -Math.ceil(maxStep * (1 - Math.max(0, pointerY) / edgeSize));
  }
  if (pointerY > viewportHeight - edgeSize) {
    return Math.ceil(maxStep * (1 - Math.max(0, viewportHeight - pointerY) / edgeSize));
  }
  return 0;
}

function snapMinutes(value: number, intervalMinutes: number): number {
  const safeInterval = Math.max(1, intervalMinutes);
  return Math.round(value / safeInterval) * safeInterval;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
