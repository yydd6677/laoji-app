// UI-SHELL-001 / UI-OVERLAY-WINDOW-001: JS sends low-frequency snapshots to
// one Activity-level overlay owner and receives semantic events only.

import { requireOptionalNativeModule } from 'expo-modules-core';
import type { NativeModule } from 'expo-modules-core';
import { compactNativeOverlaySnapshot } from './nativeValues';

export type NativeBottomTab = 'schedule' | 'meetings';

export interface NativeTabPressEvent {
  type: 'tabPress';
  tab: NativeBottomTab;
}

export interface NativeDialogActionSnapshot {
  text: string;
  role?: 'primary' | 'secondary' | 'cancel' | 'destructive';
}

export interface NativeDialogSnapshot {
  visible: boolean;
  title: string;
  message?: string;
  hint?: string;
  tone?: 'info' | 'success' | 'warning' | 'error' | 'danger';
  icon?: string;
  actions: NativeDialogActionSnapshot[];
}

export interface NativeDialogActionEvent {
  index: number;
  role?: string;
  tone?: string;
}

export interface NativeSheetItemSnapshot {
  key: string;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
}

export interface NativeActionSheetSnapshot {
  visible: boolean;
  title?: string;
  items: NativeSheetItemSnapshot[];
}

export interface NativeSheetItemEvent {
  key: string;
  index: number;
}

export interface NativeToastSnapshot {
  visible: boolean;
  message: string;
  durationMs?: number | null;
  bottom?: number;
  presentationKey?: number | string;
}

export type NativeWindowOverlayKind =
  | 'calendar-search'
  | 'schedule-voice'
  | 'action-sheet'
  | 'dialog'
  | 'toast';

export interface NativeWindowOverlayEvent {
  kind: NativeWindowOverlayKind;
  ownerId: string;
  reason?: string;
  type?: string;
  key?: string;
  index?: number;
  role?: string;
  tone?: string;
  query?: string;
  sourceEventId?: string;
  occurrenceDate?: string;
  text?: string;
}

interface NativeUiModuleEvents {
  [eventName: string]: (...args: any[]) => void;
  onOverlayAction: (event: NativeWindowOverlayEvent) => void;
  onOverlayDismiss: (event: NativeWindowOverlayEvent) => void;
}

interface NativeUiModule extends NativeModule<NativeUiModuleEvents> {
  evidenceSchemaVersion: number;
  implementation: string;
  presentOverlay(
    ownerId: string,
    kind: NativeWindowOverlayKind,
    snapshot: object,
  ): Promise<void>;
  dismissOverlay(ownerId: string, kind: NativeWindowOverlayKind, reason: string): Promise<void>;
  addListener<K extends keyof NativeUiModuleEvents>(
    eventName: K,
    listener: NativeUiModuleEvents[K],
  ): { remove(): void };
}

const nativeModule = requireOptionalNativeModule<NativeUiModule>('LaojiUi');
let overlayOwnerSequence = 0;

export function createNativeOverlayOwnerId(prefix: string): string {
  overlayOwnerSequence += 1;
  return `${prefix}-${overlayOwnerSequence}`;
}

export function hasNativeWindowOverlay(): boolean {
  return nativeModule !== null;
}

export async function presentNativeWindowOverlay(
  ownerId: string,
  kind: NativeWindowOverlayKind,
  snapshot: object,
): Promise<void> {
  if (!nativeModule) throw new Error('LaojiUi native window overlay module is unavailable');
  await nativeModule.presentOverlay(ownerId, kind, compactNativeOverlaySnapshot(snapshot));
}

export async function dismissNativeWindowOverlay(
  ownerId: string,
  kind: NativeWindowOverlayKind,
  reason = 'programmatic',
): Promise<void> {
  if (!nativeModule) return;
  await nativeModule.dismissOverlay(ownerId, kind, reason);
}

export function addNativeWindowOverlayActionListener(
  listener: (event: NativeWindowOverlayEvent) => void,
) {
  return nativeModule?.addListener('onOverlayAction', listener) ?? { remove() {} };
}

export function addNativeWindowOverlayDismissListener(
  listener: (event: NativeWindowOverlayEvent) => void,
) {
  return nativeModule?.addListener('onOverlayDismiss', listener) ?? { remove() {} };
}
