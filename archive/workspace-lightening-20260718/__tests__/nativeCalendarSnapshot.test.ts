import {
  buildNativeCalendarRangeSnapshot,
  calendarDateFromEpochDay,
  calendarEpochDay,
  calendarTimeFromMinutes,
  localCalendarDate,
  nativeCalendarEventSnapshot,
  nativeCalendarMutationChanges,
} from '../src/native/calendarSnapshot';
import type { CalEvent } from '../src/types';

function event(overrides: Partial<CalEvent> = {}): CalEvent {
  return {
    id: 'event-1',
    sourceEventId: 'series-1',
    occurrenceDate: '2026-07-16',
    title: '项目会议',
    startDate: '2026-07-16',
    endDate: '2026-07-16',
    startTime: '10:00',
    endTime: '11:00',
    color: '#1456F0',
    revision: 4,
    ...overrides,
  };
}

describe('native calendar snapshots', () => {
  it('uses stable recurrence identity and device-neutral epoch days', () => {
    expect(nativeCalendarEventSnapshot(event(), 'Asia/Shanghai')).toEqual(expect.objectContaining({
      sourceEventId: 'series-1',
      occurrenceDate: '2026-07-16',
      startEpochDay: calendarEpochDay('2026-07-16'),
      endEpochDay: calendarEpochDay('2026-07-16'),
      startMinutes: 600,
      endMinutes: 660,
      timeZoneId: 'Asia/Shanghai',
      revision: 4,
    }));
  });

  it('preserves a source InstanceLayout rectangle for the native event layer [CAL-DAY-COMPOSE-001]', () => {
    const instanceLayout = {
      xOffsetPercent: 25,
      yOffsetPercent: 42,
      widthPercent: 50,
      heightPercent: 5,
      zIndex: 3,
      fullDisplayWidthPercent: null,
    };

    expect(nativeCalendarEventSnapshot(event({ instanceLayout }), 'Asia/Shanghai').instanceLayout)
      .toEqual(instanceLayout);
  });

  it('normalizes an exclusive next-day midnight to minute 1440', () => {
    const snapshot = nativeCalendarEventSnapshot(event({
      startTime: '22:00',
      endDate: '2026-07-17',
      endTime: '00:00',
    }), 'Asia/Shanghai');

    expect(snapshot.endEpochDay).toBe(calendarEpochDay('2026-07-16'));
    expect(snapshot.endMinutes).toBe(1440);
  });

  it('keeps a genuine multi-day timed endpoint on its occupied date', () => {
    const snapshot = nativeCalendarEventSnapshot(event({
      endDate: '2026-07-18',
      endTime: '09:30',
    }), 'Asia/Shanghai');

    expect(snapshot.endEpochDay).toBe(calendarEpochDay('2026-07-18'));
    expect(snapshot.endMinutes).toBe(570);
    expect(snapshot.endEpochDayExclusive).toBeNull();
  });

  it('carries an explicit half-open end for all-day spans', () => {
    const snapshot = nativeCalendarEventSnapshot(event({
      startDate: '2026-07-16',
      endDate: '2026-07-18',
      startTime: undefined,
      endTime: undefined,
      isAllDay: true,
    }), 'Asia/Shanghai');

    expect(snapshot.endEpochDay).toBe(calendarEpochDay('2026-07-18'));
    expect(snapshot.endEpochDayExclusive).toBe(calendarEpochDay('2026-07-19'));
  });

  it('formats today from the device-local calendar instead of UTC serialization', () => {
    const localMidnight = new Date(2026, 6, 16, 0, 30);
    expect(localCalendarDate(localMidnight)).toBe('2026-07-16');
  });

  it('builds a versioned half-open range with a 30-minute product default', () => {
    const snapshot = buildNativeCalendarRangeSnapshot({
      generation: 7,
      rangeStart: '2026-07-01',
      rangeEndExclusive: '2026-08-01',
      selectedDate: '2026-07-16',
      today: '2026-07-16',
      events: [event()],
      timeZoneId: 'Asia/Shanghai',
    });

    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.generation).toBe(7);
    expect(snapshot.settings).toEqual({ defaultEventDurationMinutes: 30, firstDayOfWeek: 0 });
    expect(snapshot.rangeEndEpochDayExclusive - snapshot.rangeStartEpochDay).toBe(31);
  });

  it('rejects empty or reversed native ranges', () => {
    expect(() => buildNativeCalendarRangeSnapshot({
      generation: 1,
      rangeStart: '2026-08-01',
      rangeEndExclusive: '2026-08-01',
      selectedDate: '2026-08-01',
      today: '2026-08-01',
      events: [],
    })).toThrow('Native calendar range must be non-empty.');
  });

  it('converts native drag semantics back to repository fields [CAL-DAY-DRAG-001]', () => {
    const startEpochDay = calendarEpochDay('2026-07-16');
    expect(calendarDateFromEpochDay(startEpochDay)).toBe('2026-07-16');
    expect(calendarTimeFromMinutes(1440)).toBe('00:00');
    expect(nativeCalendarMutationChanges({
      operationId: 'operation-1',
      kind: 'resize-end',
      sourceEventId: 'event-1',
      occurrenceDate: '2026-07-16',
      startEpochDay,
      endEpochDay: startEpochDay + 1,
      startMinutes: 23 * 60 + 30,
      endMinutes: 30,
      baseRevision: 2,
    })).toEqual({
      startDate: '2026-07-16',
      endDate: '2026-07-17',
      startTime: '23:30',
      endTime: '00:30',
    });
    expect(nativeCalendarMutationChanges({
      operationId: 'operation-midnight',
      kind: 'resize-end',
      sourceEventId: 'event-1',
      occurrenceDate: '2026-07-16',
      startEpochDay,
      endEpochDay: startEpochDay,
      startMinutes: 23 * 60,
      endMinutes: 1440,
      baseRevision: 2,
    }).endDate).toBe('2026-07-17');
  });
});
