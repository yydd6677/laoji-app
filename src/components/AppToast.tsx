import React from 'react';
import {
  FeishuToast,
  type FeishuHostLifecycle,
} from './FeishuOverlay';
import type { FeishuColorScheme } from '../theme/feishuTokens';

export type AppToastProps = {
  // CAL-REPEAT-RRULE-001: route-specific evidence is forwarded to the rendered toast layer.
  feishuEvidence?: string;
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
  feishuEvidence,
  presentationKey: _presentationKey,
  ...props
}: AppToastProps) {
  return <FeishuToast nativeID={feishuEvidence} {...props} />;
}
