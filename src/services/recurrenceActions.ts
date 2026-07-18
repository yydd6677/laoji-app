import type { AppDialogOptions } from '../components/AppDialog';
import type { CalEvent, EventRecurrenceScope } from '../types';

// CAL-REPEAT-RRULE-001: scope policy follows Feishu's normal/exception instance matrix.
export type RecurrenceRuleControlMode = 'hidden' | 'disabled' | 'editable';

export type RecurrenceScopeChoice = {
  scope: EventRecurrenceScope;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
};

export type RecurrenceScopeCapabilities = {
  eventKeyAvailable?: boolean;
  followingAvailable?: boolean;
  seriesAvailable?: boolean;
  seriesEditable?: boolean;
};

export function resolveRecurrenceEditScope(
  event: CalEvent,
  requested: EventRecurrenceScope | undefined,
): EventRecurrenceScope | undefined {
  if (!event.repeat || event.repeat === 'once') return 'series';
  if (event.isRecurrenceException && requested === 'following') return undefined;
  return requested;
}

export function recurrenceEditChoices(
  event: CalEvent,
  capabilities: RecurrenceScopeCapabilities = {},
): RecurrenceScopeChoice[] {
  if (!event.repeat || event.repeat === 'once') {
    return [{ scope: 'series', label: '编辑日程' }];
  }
  const choices: RecurrenceScopeChoice[] = [
    { scope: 'occurrence', label: '仅编辑此日程' },
  ];
  if (!event.isRecurrenceException && capabilities.followingAvailable !== false) {
    choices.push({ scope: 'following', label: '编辑此日程及后续日程' });
  }
  if (capabilities.seriesAvailable !== false) {
    choices.push({
      scope: 'series',
      label: '编辑所有日程',
      disabled: capabilities.seriesEditable === false,
    });
  }
  return choices;
}

export function recurrenceDeleteChoices(
  event: CalEvent,
  capabilities: RecurrenceScopeCapabilities = {},
): RecurrenceScopeChoice[] {
  if (!event.repeat || event.repeat === 'once') {
    return [{ scope: 'series', label: '删除日程', destructive: true }];
  }
  if (capabilities.eventKeyAvailable === false) return [];
  const choices: RecurrenceScopeChoice[] = [
    { scope: 'occurrence', label: '仅删除此日程', destructive: true },
  ];
  if (!event.isRecurrenceException && capabilities.followingAvailable !== false) {
    choices.push({ scope: 'following', label: '删除此日程及后续日程', destructive: true });
  }
  if (capabilities.seriesAvailable !== false) {
    choices.push({ scope: 'series', label: '删除所有日程', destructive: true });
  }
  return choices;
}

export function canEditRecurrenceRule(
  event: CalEvent,
  requested: EventRecurrenceScope | undefined,
): boolean {
  return recurrenceRuleControlMode(event, requested) === 'editable';
}

export function recurrenceRuleControlMode(
  event: CalEvent,
  requested: EventRecurrenceScope | undefined,
): RecurrenceRuleControlMode {
  if (!event.repeat || event.repeat === 'once') return 'editable';
  const scope = resolveRecurrenceEditScope(event, requested);
  if (!scope) return 'hidden';
  if (scope === 'occurrence') return event.isRecurrenceException ? 'hidden' : 'disabled';
  if (scope === 'following' || scope === 'series') return 'editable';
  return 'hidden';
}

export function canStopRecurringSeries(
  event: CalEvent,
  requested: EventRecurrenceScope | undefined,
): boolean {
  return !event.repeat || event.repeat === 'once' || !resolveRecurrenceEditScope(event, requested);
}

export function recurrenceDeleteDialog(
  event: CalEvent,
  onDelete: (scope: EventRecurrenceScope) => void | Promise<void>,
): AppDialogOptions {
  if (!event.repeat || event.repeat === 'once') {
    return {
      title: '删除日程',
      message: `确定删除“${event.title}”吗？`,
      tone: 'danger',
      actions: [
        { text: '删除', role: 'destructive', onPress: () => onDelete('series') },
        { text: '取消', role: 'cancel' },
      ],
    };
  }

  const actions: NonNullable<AppDialogOptions['actions']> = recurrenceDeleteChoices(event).map(choice => ({
    text: choice.label,
    role: choice.scope === 'series' ? 'destructive' : 'secondary',
    onPress: () => onDelete(choice.scope),
  }));
  actions.push({ text: '取消', role: 'cancel' });
  return {
    title: '删除重复日程',
    message: '请选择要删除的范围',
    tone: 'danger',
    actions,
  };
}

export function recurrenceEditDialog(
  event: CalEvent,
  onEdit: (scope: EventRecurrenceScope) => void | Promise<void>,
  onCancel?: () => void,
): AppDialogOptions {
  const actions: NonNullable<AppDialogOptions['actions']> = recurrenceEditChoices(event).map(choice => ({
    text: choice.label,
    role: choice.scope === 'series' ? 'primary' : 'secondary',
    onPress: () => onEdit(choice.scope),
  }));
  actions.push({ text: '取消', role: 'cancel', onPress: onCancel });
  return {
    title: '修改重复日程',
    message: '请选择要应用修改的范围',
    tone: 'info',
    onDismiss: onCancel,
    actions,
  };
}
