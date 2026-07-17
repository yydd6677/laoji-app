import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  addNativeWindowOverlayDismissListener,
  createNativeOverlayOwnerId,
  dismissNativeWindowOverlay,
  presentNativeWindowOverlay,
  type NativeToastSnapshot,
  type NativeWindowOverlayEvent,
} from 'laoji-native-platform';
import type { FeishuHostLifecycle } from './FeishuOverlay';
import type { FeishuColorScheme } from '../theme/feishuTokens';

// UI-OVERLAY-WINDOW-001: Android transient feedback shares the Activity owner.
export type AppToastProps = {
  visible: boolean;
  message: string;
  onDismiss: () => void;
  hostVisible?: boolean;
  lifecycleState?: FeishuHostLifecycle;
  autoHideDurationMs?: number | null;
  bottom?: number;
  scheme?: FeishuColorScheme;
  testID?: string;
  presentationKey?: number | string;
};

export function AppToast({
  visible,
  message,
  onDismiss,
  hostVisible = true,
  lifecycleState = 'active',
  autoHideDurationMs = 4000,
  bottom = 80,
  presentationKey = 0,
}: AppToastProps) {
  const ownerId = useMemo(() => createNativeOverlayOwnerId('app-toast'), []);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const presented = visible && hostVisible && lifecycleState === 'active' && message.trim().length > 0;

  const snapshot = useMemo<NativeToastSnapshot>(() => ({
    visible: presented,
    message,
    durationMs: autoHideDurationMs,
    bottom,
    presentationKey,
  }), [autoHideDurationMs, bottom, message, presentationKey, presented]);

  const matchesOwner = useCallback((event: NativeWindowOverlayEvent) => (
    event.kind === 'toast' && event.ownerId === ownerId
  ), [ownerId]);

  useEffect(() => {
    const dismissSubscription = addNativeWindowOverlayDismissListener(event => {
      if (matchesOwner(event)) onDismissRef.current();
    });
    return () => {
      dismissSubscription.remove();
    };
  }, [matchesOwner]);

  useEffect(() => {
    if (presented) {
      void presentNativeWindowOverlay(ownerId, 'toast', snapshot).catch(error => {
        console.error('[UI-OVERLAY-WINDOW-001] failed to present toast', error);
        onDismissRef.current();
      });
    } else {
      void dismissNativeWindowOverlay(ownerId, 'toast', 'hidden');
    }
  }, [ownerId, presented, snapshot]);

  useEffect(() => () => {
    void dismissNativeWindowOverlay(ownerId, 'toast', 'component-unmounted');
  }, [ownerId]);

  return null;
}
