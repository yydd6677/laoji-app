import type { AppDialogOptions } from '../components/AppDialog';
import type { CalEvent, EventRecurrenceScope } from '../types';

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

  const actions: NonNullable<AppDialogOptions['actions']> = [
    { text: '仅删除此日程', role: 'secondary', onPress: () => onDelete('occurrence') },
  ];
  if (!event.isRecurrenceException) {
    actions.push({ text: '删除此后日程', role: 'secondary', onPress: () => onDelete('following') });
  }
  actions.push(
    { text: '删除全部日程', role: 'destructive', onPress: () => onDelete('series') },
    { text: '取消', role: 'cancel' },
  );
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
  const actions: NonNullable<AppDialogOptions['actions']> = [
    { text: '仅修改此日程', role: 'secondary', onPress: () => onEdit('occurrence') },
  ];
  if (!event.isRecurrenceException) {
    actions.push({ text: '修改此后日程', role: 'secondary', onPress: () => onEdit('following') });
  }
  actions.push(
    { text: '修改全部日程', role: 'primary', onPress: () => onEdit('series') },
    { text: '取消', role: 'cancel', onPress: onCancel },
  );
  return {
    title: '修改重复日程',
    message: '请选择要应用修改的范围',
    tone: 'info',
    onDismiss: onCancel,
    actions,
  };
}
