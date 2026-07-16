import { layoutTimelineEvents } from '../src/utils/dayTimelineLayout';
import type { CalEvent } from '../src/types';

function timed(
  id: string,
  startTime: string,
  endTime: string,
): CalEvent {
  return {
    id,
    title: id,
    startDate: '2026-07-15',
    startTime,
    endTime,
    color: '#1456F0',
  };
}

describe('single-day overlap layout', () => {
  const chain = [
    timed('long', '09:00', '12:00'),
    timed('early', '09:00', '10:00'),
    timed('middle', '09:30', '10:30'),
    timed('tail', '10:30', '11:00'),
  ];

  it('uses independent rectangles and lets a free tail expand into later columns', () => {
    const layout = layoutTimelineEvents(chain, '2026-07-15');

    expect(layout.find(item => item.event.id === 'long')).toMatchObject({
      column: 0,
      columns: 3,
      columnSpan: 1,
    });
    expect(layout.find(item => item.event.id === 'middle')).toMatchObject({
      column: 2,
      columns: 3,
      columnSpan: 1,
    });
    expect(layout.find(item => item.event.id === 'tail')).toMatchObject({
      column: 1,
      columns: 3,
      columnSpan: 2,
    });
  });

  it('produces stable geometry and z order regardless of input order', () => {
    const summarize = (events: CalEvent[]) => layoutTimelineEvents(events, '2026-07-15')
      .map(item => [
        item.event.id,
        item.column,
        item.columns,
        item.columnSpan,
        item.zIndex,
      ]);

    expect(summarize([...chain].reverse())).toEqual(summarize(chain));
    expect(new Set(layoutTimelineEvents(chain, '2026-07-15').map(item => item.zIndex)).size)
      .toBe(chain.length);
  });

  it('uses half-open boundaries so adjacent items do not occupy each other\'s width', () => {
    const layout = layoutTimelineEvents([
      timed('first', '13:00', '13:30'),
      timed('second', '13:30', '14:00'),
    ], '2026-07-15');

    expect(layout.map(item => ({ id: item.event.id, columns: item.columns, columnSpan: item.columnSpan })))
      .toEqual([
        { id: 'first', columns: 1, columnSpan: 1 },
        { id: 'second', columns: 1, columnSpan: 1 },
      ]);
  });
});
