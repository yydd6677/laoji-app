import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import {
  addNativeWindowOverlayActionListener,
  addNativeWindowOverlayDismissListener,
  createNativeOverlayOwnerId,
  dismissNativeWindowOverlay,
  presentNativeWindowOverlay,
  type NativeDialogActionEvent,
  type NativeDialogSnapshot,
  type NativeWindowOverlayEvent,
} from 'laoji-native-platform';
import type { Ionicons } from '@expo/vector-icons';

// UI-OVERLAY-001 / UI-MOTION-001: Android dialog geometry and motion are owned by one native host.
type IconName = keyof typeof Ionicons.glyphMap;
export type AppDialogTone = 'info' | 'success' | 'warning' | 'error' | 'danger';
export type AppDialogActionRole = 'primary' | 'secondary' | 'cancel' | 'destructive';

export type AppDialogAction = {
  text: string;
  role?: AppDialogActionRole;
  onPress?: () => void | Promise<void>;
};

export type AppDialogOptions = {
  title: string;
  message?: string;
  hint?: string;
  tone?: AppDialogTone;
  icon?: IconName;
  actions?: AppDialogAction[];
  onDismiss?: () => void;
};

type AppDialogContextValue = {
  showDialog: (options: AppDialogOptions) => void;
  hideDialog: () => void;
};

const AppDialogContext = createContext<AppDialogContextValue | null>(null);

export const APP_DIALOG_GEOMETRY = {
  maxWidth: 296,
  radius: 6,
  contentWidth: 260,
  titleHeight: 24,
  titleSize: 17,
  bodySize: 14,
  actionHeight: 50,
  dividerWidth: 0.5,
  animationDuration: 220,
  entryOffset: 8,
  entryScale: 0.98,
} as const;

function resolvedActions(dialog: AppDialogOptions): AppDialogAction[] {
  return dialog.actions?.length ? dialog.actions : [{ text: '知道了', role: 'primary' }];
}

export function AppDialogProvider({ children }: { children: React.ReactNode }) {
  const [dialog, setDialog] = useState<AppDialogOptions | null>(null);
  const [visible, setVisible] = useState(false);
  const dialogRef = useRef<AppDialogOptions | null>(null);
  const completionRef = useRef<(() => void) | null>(null);
  const notifyDismissRef = useRef(false);
  const ownerId = useMemo(() => createNativeOverlayOwnerId('app-dialog'), []);

  const showDialog = useCallback((options: AppDialogOptions) => {
    completionRef.current = null;
    notifyDismissRef.current = false;
    dialogRef.current = options;
    setDialog(options);
    setVisible(true);
  }, []);

  const hideDialog = useCallback(() => {
    if (!dialogRef.current) return;
    notifyDismissRef.current = true;
    setVisible(false);
  }, []);

  const finishDismissal = useCallback(() => {
    const current = dialogRef.current;
    const completion = completionRef.current;
    const notifyDismiss = notifyDismissRef.current;
    dialogRef.current = null;
    completionRef.current = null;
    notifyDismissRef.current = false;
    setVisible(false);
    setDialog(null);
    if (notifyDismiss) current?.onDismiss?.();
    completion?.();
  }, []);

  const clearForPrivacy = useCallback(() => {
    dialogRef.current = null;
    completionRef.current = null;
    notifyDismissRef.current = false;
    setVisible(false);
    setDialog(null);
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') clearForPrivacy();
    });
    return () => subscription.remove();
  }, [clearForPrivacy]);

  const handleAction = useCallback((event: NativeDialogActionEvent) => {
    const current = dialogRef.current;
    if (!current) return;
    const action = resolvedActions(current)[event.index];
    completionRef.current = action?.onPress ? () => { void action.onPress?.(); } : null;
    notifyDismissRef.current = false;
    setVisible(false);
  }, []);

  const snapshot = useMemo<NativeDialogSnapshot>(() => ({
    visible,
    title: dialog?.title ?? '',
    message: dialog?.message,
    hint: dialog?.hint,
    tone: dialog?.tone ?? 'info',
    icon: dialog?.icon,
    actions: dialog ? resolvedActions(dialog).map((action, index) => ({
      text: action.text,
      role: action.role ?? (index === 0 ? 'primary' : 'secondary'),
    })) : [],
  }), [dialog, visible]);

  const value = useMemo(() => ({ showDialog, hideDialog }), [hideDialog, showDialog]);

  useEffect(() => {
    const matchesOwner = (event: NativeWindowOverlayEvent) => (
      event.kind === 'dialog' && event.ownerId === ownerId
    );
    const actionSubscription = addNativeWindowOverlayActionListener(event => {
      if (!matchesOwner(event) || typeof event.index !== 'number') return;
      handleAction(event as NativeWindowOverlayEvent & NativeDialogActionEvent);
    });
    const dismissSubscription = addNativeWindowOverlayDismissListener(event => {
      if (matchesOwner(event)) finishDismissal();
    });
    return () => {
      actionSubscription.remove();
      dismissSubscription.remove();
    };
  }, [finishDismissal, handleAction, ownerId]);

  useEffect(() => {
    if (dialog) {
      void presentNativeWindowOverlay(ownerId, 'dialog', snapshot);
    } else {
      void dismissNativeWindowOverlay(ownerId, 'dialog', 'unmounted');
    }
  }, [dialog, ownerId, snapshot]);

  useEffect(() => () => {
    void dismissNativeWindowOverlay(ownerId, 'dialog', 'provider-unmounted');
  }, [ownerId]);

  return (
    <AppDialogContext.Provider value={value}>
      {children}
    </AppDialogContext.Provider>
  );
}

export function useAppDialog() {
  const context = useContext(AppDialogContext);
  if (!context) throw new Error('useAppDialog must be used inside AppDialogProvider');
  return context;
}
