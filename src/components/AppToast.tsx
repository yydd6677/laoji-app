import React from 'react';
import {
  AppOverlayToast,
  type AppHostLifecycle,
} from './AppOverlay';
import type { UiColorScheme } from '../theme/uiTokens';

export type AppToastProps = {
  visible: boolean;
  message: string;
  onDismiss: () => void;
  hostVisible?: boolean;
  lifecycleState?: AppHostLifecycle;
  autoHideDurationMs?: number | null;
  bottom?: number;
  scheme?: UiColorScheme;
  testID?: string;
  presentationKey?: number | string;
};

export function AppToast({
  presentationKey: _presentationKey,
  ...props
}: AppToastProps) {
  return <AppOverlayToast {...props} />;
}
