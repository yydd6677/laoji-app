/**
 * Event utility tests — conflict detection
 */
import { checkConflict } from '../src/utils/eventUtils';
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

  it('ignores all-day events', () => {
    const allDay = { ...BASE, isAllDay: true };
    const { hasConflict } = checkConflict([allDay], '2026-07-08', '10:00', '11:00');
    expect(hasConflict).toBe(false);
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
