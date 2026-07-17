import {
  projectTimelineEdit,
  timelineEdgeScrollStep,
} from '../src/utils/dayTimelineGestures';

describe('day timeline gesture projection', () => {
  it('snaps movement to 15 minutes while preserving duration and day bounds', () => {
    expect(projectTimelineEdit({
      kind: 'move',
      original: { start: 600, end: 660 },
      deltaPixels: 13,
      pixelsPerMinute: 1,
    })).toEqual({ start: 615, end: 675 });
    expect(projectTimelineEdit({
      kind: 'move',
      original: { start: 30, end: 90 },
      deltaPixels: -200,
      pixelsPerMinute: 1,
    })).toEqual({ start: 0, end: 60 });
  });

  it('resizes either edge without crossing the 15-minute minimum duration', () => {
    expect(projectTimelineEdit({
      kind: 'resize-start',
      original: { start: 600, end: 660 },
      deltaPixels: 200,
      pixelsPerMinute: 1,
    })).toEqual({ start: 645, end: 660 });
    expect(projectTimelineEdit({
      kind: 'resize-end',
      original: { start: 600, end: 660 },
      deltaPixels: -200,
      pixelsPerMinute: 1,
    })).toEqual({ start: 600, end: 615 });
  });

  it('supports the 30-minute quick-create snap and minimum duration', () => {
    expect(projectTimelineEdit({
      kind: 'move',
      original: { start: 570, end: 600 },
      deltaPixels: 20,
      pixelsPerMinute: 1,
      snapIntervalMinutes: 30,
      minDurationMinutes: 30,
    })).toEqual({ start: 600, end: 630 });

    expect(projectTimelineEdit({
      kind: 'resize-start',
      original: { start: 570, end: 600 },
      deltaPixels: 40,
      pixelsPerMinute: 1,
      snapIntervalMinutes: 30,
      minDurationMinutes: 30,
    })).toEqual({ start: 570, end: 600 });
  });

  it('requests proportional auto-scroll only inside viewport edges', () => {
    expect(timelineEdgeScrollStep(32, 640)).toBe(-14);
    expect(timelineEdgeScrollStep(320, 640)).toBe(0);
    expect(timelineEdgeScrollStep(624, 640)).toBe(21);
  });
});
