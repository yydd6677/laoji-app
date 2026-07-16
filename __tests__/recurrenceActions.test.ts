import { recurrenceDeleteDialog, recurrenceEditDialog } from '../src/services/recurrenceActions';
import type { CalEvent } from '../src/types';

const RECURRING: CalEvent = {
  id: 'series@2026-07-20',
  sourceEventId: 'series',
  occurrenceDate: '2026-07-20',
  title: '周会',
  startDate: '2026-07-20',
  repeat: 'weekly',
  color: '#1456F0',
};

describe('recurrence action scope matrix', () => {
  it('offers occurrence, following, and series for a normal recurring instance', () => {
    const dialog = recurrenceDeleteDialog(RECURRING, jest.fn());
    expect(dialog.actions?.map(action => action.text)).toEqual([
      '仅删除此日程',
      '删除此后日程',
      '删除全部日程',
      '取消',
    ]);
  });

  it('does not offer following for an already exceptional occurrence', () => {
    const dialog = recurrenceDeleteDialog({ ...RECURRING, isRecurrenceException: true }, jest.fn());
    expect(dialog.actions?.map(action => action.text)).toEqual([
      '仅删除此日程',
      '删除全部日程',
      '取消',
    ]);
  });

  it('offers the three edit scopes for a normal recurring occurrence', () => {
    const dialog = recurrenceEditDialog(RECURRING, jest.fn());
    expect(dialog.actions?.map(action => action.text)).toEqual([
      '仅修改此日程',
      '修改此后日程',
      '修改全部日程',
      '取消',
    ]);
  });

  it('does not offer following when editing an existing recurrence exception', () => {
    const dialog = recurrenceEditDialog({ ...RECURRING, isRecurrenceException: true }, jest.fn());
    expect(dialog.actions?.map(action => action.text)).toEqual([
      '仅修改此日程',
      '修改全部日程',
      '取消',
    ]);
  });
});
