/**
 * Event utility tests — conflict detection
 */
import { checkConflict, evaluateEventConflicts } from '../src/utils/eventUtils';
import { CalEvent } from '../src/types';

const BASE: CalEvent = {
  id: '1', title: '已有会议', startDate: '2026-07-08',
  startTime: '10:00', endTime: '11:00', color: '#7B5CB8',
};

describe('checkConflict', () => {
  it('returns no conflict when no events', () => {
    const { hasConflict } = checkConflict([], '2026-07-08', '10:00', '11:00');
    expect(hasConflict).toBe(false);
  });

  it('detects exact overlap', () => {
    const { hasConflict, conflicts } = checkConflict([BASE], '2026-07-08', '10:00', '11:00');
    expect(hasConflict).toBe(true);
    expect(conflicts).toHaveLength(1);
  });

  it('detects partial overlap — new starts inside existing', () => {
    const { hasConflict } = checkConflict([BASE], '2026-07-08', '10:30', '11:30');
    expect(hasConflict).toBe(true);
  });

  it('detects partial overlap — new ends inside existing', () => {
    const { hasConflict } = checkConflict([BASE], '2026-07-08', '09:30', '10:30');
    expect(hasConflict).toBe(true);
  });

  it('no conflict when adjacent (back-to-back)', () => {
    const { hasConflict } = checkConflict([BASE], '2026-07-08', '11:00', '12:00');
    expect(hasConflict).toBe(false);
  });

  it('no conflict on different date', () => {
    const { hasConflict } = checkConflict([BASE], '2026-07-09', '10:00', '11:00');
    expect(hasConflict).toBe(false);
  });

  it('reports an all-day event as a non-blocking mixed overlap', () => {
    const allDay = { ...BASE, isAllDay: true };
    const { hasConflict } = checkConflict([allDay], '2026-07-08', '10:00', '11:00');
    expect(hasConflict).toBe(true);
  });

  it('excludes event by id when editing', () => {
    const { hasConflict } = checkConflict([BASE], '2026-07-08', '10:00', '11:00', '1');
    expect(hasConflict).toBe(false);
  });

  it('detects multiple conflicts', () => {
    const ev2: CalEvent = { ...BASE, id: '2', title: '第二个会议', startTime: '10:15', endTime: '10:45' };
    const { conflicts } = checkConflict([BASE, ev2], '2026-07-08', '10:00', '11:00');
    expect(conflicts).toHaveLength(2);
  });

  it('detects overlap with an existing cross-date event', () => {
    const spanning: CalEvent = {
      ...BASE,
      startDate: '2026-07-08',
      endDate: '2026-07-10',
      startTime: '18:00',
      endTime: '09:00',
      spanning: true,
    };
    const { hasConflict } = checkConflict([spanning], '2026-07-09', '10:00', '11:00');
    expect(hasConflict).toBe(true);
  });

  it('compares a proposed cross-date range as one interval', () => {
    const { hasConflict } = checkConflict(
      [BASE],
      '2026-07-07',
      '20:00',
      '09:00',
      undefined,
      '2026-07-09',
    );
    expect(hasConflict).toBe(true);
  });
});

describe('event conflict semantics', () => {
  const draft = {
    title: '新日程',
    startDate: '2026-07-08',
    startTime: '10:00',
    endTime: '11:00',
    isAllDay: false,
    repeat: 'once' as const,
    reminderMinutes: null,
  };

  it('marks all-day versus timed overlap as soft in either direction', () => {
    const allDay = { ...BASE, id: 'all-day', isAllDay: true, startTime: undefined, endTime: undefined };
    expect(evaluateEventConflicts([allDay], draft).conflicts[0]).toMatchObject({
      kind: 'all-day-timed',
      severity: 'soft',
    });
    expect(evaluateEventConflicts([BASE], {
      ...draft,
      isAllDay: true,
      startTime: undefined,
      endTime: undefined,
    }).conflicts[0]).toMatchObject({ kind: 'all-day-timed', severity: 'soft' });
  });

  it('treats a date-only event like all-day for presentation and soft conflicts', () => {
    const dateOnly = {
      ...BASE,
      id: 'date-only',
      isAllDay: false,
      startTime: undefined,
      endTime: undefined,
    };

    expect(evaluateEventConflicts([dateOnly], draft).conflicts[0]).toMatchObject({
      kind: 'all-day-timed',
      severity: 'soft',
    });
  });

  it('uses inclusive stored all-day dates and half-open projected boundaries', () => {
    const existing = {
      ...BASE,
      id: 'all-day-range',
      isAllDay: true,
      startDate: '2026-07-08',
      endDate: '2026-07-09',
      startTime: undefined,
      endTime: undefined,
    };
    const overlap = evaluateEventConflicts([existing], {
      ...draft,
      startDate: '2026-07-09',
      isAllDay: true,
      startTime: undefined,
      endTime: undefined,
    });
    const adjacent = evaluateEventConflicts([existing], {
      ...draft,
      startDate: '2026-07-10',
      isAllDay: true,
      startTime: undefined,
      endTime: undefined,
    });
    expect(overlap.conflicts[0]).toMatchObject({ kind: 'all-day-overlap', severity: 'overlap' });
    expect(adjacent.hasConflict).toBe(false);
  });

  it('excludes either one occurrence or the complete source series explicitly', () => {
    const first = { ...BASE, id: 'series@2026-07-08', sourceEventId: 'series', occurrenceDate: '2026-07-08' };
    const second = { ...BASE, id: 'series@2026-07-15', sourceEventId: 'series', occurrenceDate: '2026-07-15' };
    const ref = { sourceEventId: 'series', occurrenceDate: '2026-07-08' };
    expect(evaluateEventConflicts([first, second], draft, ref, 'series').hasConflict).toBe(false);
    expect(evaluateEventConflicts([first], draft, ref, 'occurrence').hasConflict).toBe(false);
  });

  it('excludes only the selected and later occurrences for a following edit', () => {
    const earlier = { ...BASE, id: 'series@2026-07-01', sourceEventId: 'series', occurrenceDate: '2026-07-01' };
    const selected = { ...BASE, id: 'series@2026-07-08', sourceEventId: 'series', occurrenceDate: '2026-07-08' };
    const ref = { sourceEventId: 'series', occurrenceDate: '2026-07-08' };

    const result = evaluateEventConflicts([earlier, selected], draft, ref, 'following');

    expect(result.conflicts.map(conflict => conflict.event.id)).toEqual(['series@2026-07-01']);
  });
});
