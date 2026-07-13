import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { CalGrid } from '../src/components/CalGrid';
import type { CalEvent } from '../src/types';

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

const events: CalEvent[] = [
  {
    id: 'point-1',
    title: '项目评审',
    startDate: '2026-07-11',
    color: '#5B8CFF',
  },
  {
    id: 'span-1',
    title: '出差',
    startDate: '2026-07-10',
    endDate: '2026-07-12',
    spanning: true,
    color: '#FF9500',
  },
];

describe('CalGrid accessibility', () => {
  it('labels navigation and dates with state and all event types', async () => {
    await render(
      <CalGrid
        year={2026}
        month={7}
        selDay={11}
        onDay={jest.fn()}
        onPrev={jest.fn()}
        onNext={jest.fn()}
        onTitle={jest.fn()}
        onSearch={jest.fn()}
        events={events}
      />,
    );

    expect(screen.getByLabelText('上一个月')).toBeTruthy();
    expect(screen.getByLabelText('下一个月')).toBeTruthy();
    expect(screen.getByLabelText('打开完整日历，2026年7月')).toBeTruthy();
    expect(screen.getByLabelText('搜索日程')).toBeTruthy();

    const selectedDay = screen.getByLabelText(/2026年7月11日.*已选择.*2条日程/);
    expect(selectedDay.props.accessibilityState.selected).toBe(true);
  });

  it('does not expose adjacent-month filler cells as active buttons', async () => {
    await render(
      <CalGrid
        year={2026}
        month={7}
        selDay={1}
        onDay={jest.fn()}
        onPrev={jest.fn()}
        onNext={jest.fn()}
        events={[]}
      />,
    );

    const adjacentDay = screen.getAllByText('29')[0].parent?.parent;
    expect(adjacentDay?.props.disabled).toBe(true);
    expect(adjacentDay?.props.accessibilityLabel).toBeUndefined();
  });
});
