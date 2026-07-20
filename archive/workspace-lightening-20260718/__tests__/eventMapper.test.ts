import {
  apiEventToCalEvent,
  calEventChangesToApiEditPatch,
  calEventToApiEvent,
  eventSeriesDraft,
  sourceEventId,
} from '../src/services/eventMapper';

describe('eventMapper', () => {
  it('maps the server catalog segment anchor separately from its shifted display template', () => {
    const mapped = apiEventToCalEvent({
      id: 9,
      source_event_id: 9,
      occurrence_id: 'catalog:9:segment:3',
      occurrence_date: '2026-07-19',
      segment_id: 3,
      recurrence_effective_from_date: '2026-07-19',
      excluded_after_date: null,
      excluded_occurrence_dates: ['2026-07-26'],
      title: '后段周会',
      event_type: 'weekly',
      start_date: '2026-07-20',
      end_date: '2026-07-22',
      recurrence_interval: 1,
    });

    expect(mapped).toMatchObject({
      id: 'catalog:9:segment:3',
      sourceEventId: '9',
      recurrenceSegmentId: 3,
      recurrenceEffectiveFromDate: '2026-07-19',
      occurrenceDate: '2026-07-19',
      startDate: '2026-07-20',
      endDate: '2026-07-22',
      excludedOccurrenceDates: ['2026-07-26'],
    });
  });

  it('maps a server occurrence anchor separately from its moved display date', () => {
    const mapped = apiEventToCalEvent({
      id: 12,
      source_event_id: 9,
      occurrence_id: '9@2026-08-09',
      occurrence_date: '2026-08-09',
      is_expanded: true,
      title: '移动后的周会',
      event_type: 'weekly',
      start_date: '2026-08-10',
      start_time: '10:00',
      end_time: '11:00',
    });
    expect(mapped).toMatchObject({
      sourceEventId: '9',
      occurrenceDate: '2026-08-09',
      startDate: '2026-08-10',
    });
  });

  it('keeps recurring occurrences unique while retaining the source event id', () => {
    const event = apiEventToCalEvent({
      id: 9,
      source_event_id: 9,
      occurrence_id: '9@2026-08-09',
      is_expanded: true,
      series_start_date: '2026-07-09',
      series_end_date: null,
      title: '每月复盘',
      event_type: 'monthly',
      start_date: '2026-08-09',
      start_time: '10:00',
      end_time: '11:00',
      category: '工作',
    });

    expect(event).toMatchObject({
      id: '9@2026-08-09',
      sourceEventId: '9',
      isExpandedOccurrence: true,
      seriesStartDate: '2026-07-09',
      startDate: '2026-08-09',
      repeat: 'monthly',
    });
    expect(sourceEventId(event)).toBe('9');
  });

  it('maps cross-date and reminder fields back to the API contract', () => {
    expect(calEventToApiEvent({
      title: '出差',
      startDate: '2026-08-01',
      endDate: '2026-08-03',
      startTime: '09:00',
      endTime: '18:00',
      color: '#FF9500',
      category: '出行',
      reminderMinutes: 15,
    })).toMatchObject({
      title: '出差',
      start_date: '2026-08-01',
      end_date: '2026-08-03',
      spanning: true,
      category: '出行',
      reminder_minutes: 15,
    });
  });

  it('restores the original series dates when recreating an expanded occurrence', () => {
    const occurrence = apiEventToCalEvent({
      id: 4,
      source_event_id: 4,
      occurrence_id: '4@2026-08-16',
      is_expanded: true,
      series_start_date: '2026-07-12',
      series_end_date: '2026-07-13',
      title: '周末课程',
      event_type: 'weekly',
      start_date: '2026-08-16',
      end_date: '2026-08-17',
      start_time: '10:00',
      end_time: '11:00',
    });

    expect(eventSeriesDraft(occurrence)).toMatchObject({
      startDate: '2026-07-12',
      endDate: '2026-07-13',
      spanning: true,
      repeat: 'weekly',
    });
  });

  it('builds a sparse edit patch without clearing hidden fields', () => {
    const base = apiEventToCalEvent({
      id: 18,
      title: '原始标题',
      event_type: 'once',
      start_date: '2026-07-20',
      start_time: '10:00',
      end_time: '11:00',
      description: null,
      detail: '服务端保留详情',
      status: 'confirmed',
      raw_text: '原始语音',
      location: 'A301',
    });

    expect(base.description).toBe('服务端保留详情');
    expect(calEventChangesToApiEditPatch(base, {
      title: '修改标题',
      detail: undefined,
      status: undefined,
      rawText: undefined,
      color: '#1456F0',
    })).toEqual({ title: '修改标题' });
  });

  it('distinguishes explicit visible-field clearing from an omitted field', () => {
    const base = apiEventToCalEvent({
      id: 19,
      title: '现场检查',
      event_type: 'once',
      start_date: '2026-07-20',
      start_time: '10:00',
      end_time: '11:00',
      location: '一号楼',
      description: '携带材料',
    });

    expect(calEventChangesToApiEditPatch(base, {
      location: undefined,
      description: '',
    })).toEqual({
      location: null,
      description: null,
    });
  });

  it('maps recurrence controls into the nested sparse recurrence patch', () => {
    const base = apiEventToCalEvent({
      id: 20,
      title: '项目例会',
      event_type: 'weekly',
      start_date: '2026-07-20',
      recurrence_interval: 1,
      recurrence_weekdays: [1],
      recurrence_until_date: null,
    });
    expect(calEventChangesToApiEditPatch(base, {
      recurrenceInterval: 2,
      recurrenceWeekdays: [1, 3],
      recurrenceUntilDate: '2026-12-31',
    })).toEqual({
      recurrence: {
        interval: 2,
        weekdays: [1, 3],
        until_date: '2026-12-31',
      },
    });
  });
});
