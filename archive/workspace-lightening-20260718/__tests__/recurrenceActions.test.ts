import {
  canEditRecurrenceRule,
  canStopRecurringSeries,
  recurrenceDeleteDialog,
  recurrenceDeleteChoices,
  recurrenceEditDialog,
  recurrenceEditChoices,
  recurrenceRuleControlMode,
  resolveRecurrenceEditScope,
} from '../src/services/recurrenceActions';
import type { CalEvent } from '../src/types';

// CAL-REPEAT-RRULE-001: route scope choices and control visibility follow source policy.

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
      '删除此日程及后续日程',
      '删除所有日程',
      '取消',
    ]);
  });

  it('does not offer following for an already exceptional occurrence', () => {
    const dialog = recurrenceDeleteDialog({ ...RECURRING, isRecurrenceException: true }, jest.fn());
    expect(dialog.actions?.map(action => action.text)).toEqual([
      '仅删除此日程',
      '删除所有日程',
      '取消',
    ]);
  });

  it('offers the three edit scopes for a normal recurring occurrence', () => {
    const dialog = recurrenceEditDialog(RECURRING, jest.fn());
    expect(dialog.actions?.map(action => action.text)).toEqual([
      '仅编辑此日程',
      '编辑此日程及后续日程',
      '编辑所有日程',
      '取消',
    ]);
  });

  it('does not offer following when editing an existing recurrence exception', () => {
    const dialog = recurrenceEditDialog({ ...RECURRING, isRecurrenceException: true }, jest.fn());
    expect(dialog.actions?.map(action => action.text)).toEqual([
      '仅编辑此日程',
      '编辑所有日程',
      '取消',
    ]);
  });

  it.each([
    { scope: undefined, mode: 'hidden', editable: false },
    { scope: 'occurrence' as const, mode: 'disabled', editable: false },
    { scope: 'following' as const, mode: 'editable', editable: true },
    { scope: 'series' as const, mode: 'editable', editable: true },
  ])('maps recurring scope $scope to recurrence-rule mode=$mode', ({ scope, mode, editable }) => {
    expect(resolveRecurrenceEditScope(RECURRING, scope)).toBe(scope);
    expect(recurrenceRuleControlMode(RECURRING, scope)).toBe(mode);
    expect(canEditRecurrenceRule(RECURRING, scope)).toBe(editable);
  });

  it('rejects an impossible following edit for an exception instead of changing its scope', () => {
    const exception = { ...RECURRING, isRecurrenceException: true };
    expect(resolveRecurrenceEditScope(exception, 'following')).toBeUndefined();
    expect(recurrenceRuleControlMode(exception, 'following')).toBe('hidden');
    expect(canEditRecurrenceRule(exception, 'following')).toBe(false);
  });

  it('retains a disabled all-events choice and removes source-unavailable scopes', () => {
    expect(recurrenceEditChoices(RECURRING, { seriesEditable: false })).toEqual([
      { scope: 'occurrence', label: '仅编辑此日程' },
      { scope: 'following', label: '编辑此日程及后续日程' },
      { scope: 'series', label: '编辑所有日程', disabled: true },
    ]);
    expect(recurrenceEditChoices(
      { ...RECURRING, isRecurrenceException: true },
      { seriesAvailable: false },
    )).toEqual([{ scope: 'occurrence', label: '仅编辑此日程' }]);
    expect(recurrenceDeleteChoices(RECURRING, { eventKeyAvailable: false })).toEqual([]);
  });

  it('keeps a normal occurrence visible but disabled and hides an existing exception', () => {
    expect(recurrenceRuleControlMode(RECURRING, 'occurrence')).toBe('disabled');
    expect(recurrenceRuleControlMode({ ...RECURRING, isRecurrenceException: true }, 'occurrence')).toBe('hidden');
  });

  it('does not expose the no-repeat option while editing the future or whole series', () => {
    expect(canStopRecurringSeries(RECURRING, 'following')).toBe(false);
    expect(canStopRecurringSeries(RECURRING, 'series')).toBe(false);
    expect(canStopRecurringSeries({ ...RECURRING, repeat: 'once' }, 'series')).toBe(true);
  });
});
