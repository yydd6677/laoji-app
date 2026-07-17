import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addNativeWindowOverlayActionListener,
  addNativeWindowOverlayDismissListener,
  createNativeOverlayOwnerId,
  dismissNativeWindowOverlay,
  presentNativeWindowOverlay,
  type NativeActionSheetSnapshot,
  type NativeSheetItemEvent,
  type NativeWindowOverlayEvent,
} from 'laoji-native-platform';

// UI-OVERLAY-001 / UI-MOTION-001: Android sheets use the source-mapped native owner and insets.
export const ACTION_PANEL_GEOMETRY = {
  edgeMargin: 12,
  maxWidth: 450,
  radius: 8,
  titleHeight: 52,
  titleHorizontalPadding: 12,
  titleVerticalPadding: 16,
  titleSize: 14,
  itemHeight: 52,
  itemHorizontalPadding: 12,
  itemVerticalPadding: 14,
  itemSize: 17,
  dividerHeight: 0.5,
  cancelGap: 12,
  cancelHeight: 48,
  animationDuration: 300,
} as const;

export type AppActionSheetItem = {
  key: string;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
  onPress: () => void;
};

export function AppActionSheet({
  visible,
  title,
  items,
  onClose,
}: {
  visible: boolean;
  title: string;
  items: AppActionSheetItem[];
  onClose: () => void;
}) {
  const [mounted, setMounted] = useState(visible);
  const pendingActionRef = useRef<(() => void) | null>(null);
  const onCloseRef = useRef(onClose);
  const itemsRef = useRef(items);
  const ownerId = useMemo(() => createNativeOverlayOwnerId('action-sheet'), []);
  onCloseRef.current = onClose;
  itemsRef.current = items;

  useEffect(() => {
    if (visible) setMounted(true);
  }, [visible]);

  const snapshot = useMemo<NativeActionSheetSnapshot>(() => ({
    visible,
    title,
    items: items.filter(item => !item.disabled).map(item => ({
      key: item.key,
      label: item.label,
      destructive: item.destructive === true,
    })),
  }), [items, title, visible]);

  const handleItem = useCallback((event: NativeSheetItemEvent) => {
    const item = itemsRef.current.find(candidate => candidate.key === event.key);
    pendingActionRef.current = item?.onPress ?? null;
    onCloseRef.current();
  }, []);

  const handleDismiss = useCallback(() => {
    setMounted(false);
    onCloseRef.current();
    const action = pendingActionRef.current;
    pendingActionRef.current = null;
    action?.();
  }, []);

  useEffect(() => {
    const matchesOwner = (event: NativeWindowOverlayEvent) => (
      event.kind === 'action-sheet' && event.ownerId === ownerId
    );
    const actionSubscription = addNativeWindowOverlayActionListener(event => {
      if (!matchesOwner(event) || typeof event.key !== 'string' || typeof event.index !== 'number') return;
      handleItem({ key: event.key, index: event.index });
    });
    const dismissSubscription = addNativeWindowOverlayDismissListener(event => {
      if (matchesOwner(event)) handleDismiss();
    });
    return () => {
      actionSubscription.remove();
      dismissSubscription.remove();
    };
  }, [handleDismiss, handleItem, ownerId]);

  useEffect(() => {
    if (mounted) {
      void presentNativeWindowOverlay(ownerId, 'action-sheet', snapshot).catch(error => {
        console.error('[UI-OVERLAY-WINDOW-001] failed to present action sheet', error);
        setMounted(false);
        onCloseRef.current();
      });
    }
  }, [mounted, ownerId, snapshot]);

  useEffect(() => () => {
    void dismissNativeWindowOverlay(ownerId, 'action-sheet', 'component-unmounted');
  }, [ownerId]);

  if (!mounted) return null;
  return null;
}
