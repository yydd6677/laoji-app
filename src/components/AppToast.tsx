import React from 'react';
import {
  FeishuToast,
  type FeishuHostLifecycle,
} from './FeishuOverlay';
import type { FeishuColorScheme } from '../theme/feishuTokens';

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

export function AppToast({ presentationKey: _presentationKey, ...props }: AppToastProps) {
  return <FeishuToast {...props} />;
}
