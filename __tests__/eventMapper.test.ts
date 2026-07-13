import {
  apiEventToCalEvent,
  calEventToApiEvent,
  eventSeriesDraft,
  sourceEventId,
} from '../src/services/eventMapper';

describe('eventMapper', () => {
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
});
