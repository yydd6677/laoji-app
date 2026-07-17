// UI-OVERLAY-001: Serialize only stable dialog/sheet state; no React render state crosses the bridge.

import type { AppActionSheetItem } from '../components/AppActionSheet';
import type { AppDialogOptions } from '../components/AppDialog';
import type {
  NativeActionSheetSnapshot,
  NativeDialogSnapshot,
} from 'laoji-native-platform';

export function toNativeDialogSnapshot(
  options: AppDialogOptions | null,
  visible: boolean,
): NativeDialogSnapshot {
  return {
    visible,
    title: options?.title ?? '',
    message: options?.message,
    hint: options?.hint,
    tone: options?.tone,
    icon: options?.icon,
    actions: (options?.actions?.length ? options.actions : [{ text: '知道了', role: 'primary' as const }]).map(action => ({
      text: action.text,
      role: action.role,
    })),
  };
}

export function toNativeActionSheetSnapshot(
  visible: boolean,
  title: string,
  items: AppActionSheetItem[],
): NativeActionSheetSnapshot {
  return {
    visible,
    title,
    items: items.map(item => ({
      key: item.key,
      label: item.label,
      destructive: item.destructive,
    })),
  };
}

export function nativeDialogActionIndex(
  nativeIndex: number,
  options: AppDialogOptions | null,
): number {
  const actions = options?.actions?.length ? options.actions : [{ text: '知道了', role: 'primary' as const }];
  return Math.max(0, Math.min(actions.length - 1, nativeIndex));
}
