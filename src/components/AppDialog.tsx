import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors as C, Motion } from '../theme/colors';

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
  animationDuration: Motion.standard,
  entryOffset: 8,
  entryScale: 0.98,
} as const;

const TONE_ACCENT: Record<AppDialogTone, string> = {
  info: C.primary,
  success: C.green,
  warning: C.orange,
  error: C.red,
  danger: C.red,
};

function defaultActions(): AppDialogAction[] {
  return [{ text: '知道了', role: 'primary' }];
}

export function AppDialogProvider({ children }: { children: React.ReactNode }) {
  const [dialog, setDialog] = useState<AppDialogOptions | null>(null);
  const [mounted, setMounted] = useState(false);
  const [closing, setClosing] = useState(false);
  const [presentationKey, setPresentationKey] = useState(0);
  const dialogRef = useRef<AppDialogOptions | null>(null);
  const mountedRef = useRef(false);
  const closingRef = useRef(false);
  const transitionRef = useRef(0);
  const progress = useRef(new Animated.Value(0)).current;

  const finishDialog = useCallback((afterExit?: () => void, notifyDismiss = false) => {
    const current = dialogRef.current;
    if (!current || !mountedRef.current || closingRef.current) return;

    closingRef.current = true;
    setClosing(true);
    const transition = transitionRef.current + 1;
    transitionRef.current = transition;
    progress.stopAnimation();
    Animated.timing(progress, {
      toValue: 0,
      duration: APP_DIALOG_GEOMETRY.animationDuration,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (!finished || transitionRef.current !== transition) return;

      dialogRef.current = null;
      mountedRef.current = false;
      closingRef.current = false;
      setMounted(false);
      setClosing(false);
      setDialog(null);
      if (notifyDismiss) current.onDismiss?.();
      afterExit?.();
    });
  }, [progress]);

  const hideDialog = useCallback(() => {
    finishDialog(undefined, true);
  }, [finishDialog]);

  const showDialog = useCallback((options: AppDialogOptions) => {
    transitionRef.current += 1;
    progress.stopAnimation();
    dialogRef.current = options;
    mountedRef.current = true;
    closingRef.current = false;
    setDialog(options);
    setMounted(true);
    setClosing(false);
    setPresentationKey(key => key + 1);
  }, [progress]);

  useEffect(() => {
    if (!dialogRef.current || !mountedRef.current || closingRef.current) return;
    const transition = transitionRef.current + 1;
    transitionRef.current = transition;
    progress.stopAnimation();
    progress.setValue(0);
    Animated.timing(progress, {
      toValue: 1,
      duration: APP_DIALOG_GEOMETRY.animationDuration,
      useNativeDriver: true,
    }).start();
  }, [presentationKey, progress]);

  useEffect(() => () => {
    transitionRef.current += 1;
    progress.stopAnimation();
  }, [progress]);

  const value = useMemo(() => ({ showDialog, hideDialog }), [hideDialog, showDialog]);
  const tone = dialog?.tone ?? 'info';
  const accent = TONE_ACCENT[tone];
  const actions = dialog?.actions?.length ? dialog.actions : defaultActions();
  const inlineActions = actions.length <= 2;

  const runAction = (action: AppDialogAction) => {
    finishDialog(() => { void action.onPress?.(); });
  };

  return (
    <AppDialogContext.Provider value={value}>
      {children}
      {mounted && dialog ? (
        <Modal
          visible
          transparent
          animationType="none"
          statusBarTranslucent
          onRequestClose={hideDialog}
        >
          <Animated.View
            pointerEvents="auto"
            style={[s.backdrop, { opacity: progress }]}
            accessibilityViewIsModal
            testID="app-dialog-backdrop"
          >
            <Animated.View
              pointerEvents={closing ? 'none' : 'auto'}
              style={[
                s.card,
                {
                  transform: [
                    {
                      translateY: progress.interpolate({
                        inputRange: [0, 1],
                        outputRange: [APP_DIALOG_GEOMETRY.entryOffset, 0],
                      }),
                    },
                    {
                      scale: progress.interpolate({
                        inputRange: [0, 1],
                        outputRange: [APP_DIALOG_GEOMETRY.entryScale, 1],
                      }),
                    },
                  ],
                },
              ]}
              testID="app-dialog-card"
              accessibilityRole="alert"
              accessibilityLabel={`${dialog.title}${dialog.message ? `，${dialog.message}` : ''}`}
            >
              {dialog.icon ? (
                <View style={s.iconRegion} testID="app-dialog-icon">
                  <Ionicons name={dialog.icon} size={40} color={accent} />
                </View>
              ) : null}

              <View style={s.titleRegion} testID="app-dialog-title-region">
                <Text style={s.title}>{dialog.title}</Text>
              </View>
              {dialog.message || dialog.hint ? (
                <ScrollView
                  style={s.contentRegion}
                  contentContainerStyle={s.contentContent}
                  testID="app-dialog-content-region"
                >
                  {dialog.message ? <Text style={s.message}>{dialog.message}</Text> : null}
                  {dialog.hint ? <Text style={[s.hintText, dialog.message && s.hintAfterMessage]}>{dialog.hint}</Text> : null}
                </ScrollView>
              ) : null}

              <View
                style={[s.actions, inlineActions && s.actionsInline]}
                testID="app-dialog-actions"
              >
                {actions.map((action, index) => {
                  const role = action.role ?? (index === 0 ? 'primary' : 'secondary');
                  const textColor = role === 'destructive'
                    ? C.red
                    : role === 'primary'
                      ? C.primary
                      : C.text;

                  return (
                    <TouchableOpacity
                      key={`${action.text}-${index}`}
                      onPress={() => runAction(action)}
                      disabled={closing}
                      activeOpacity={0.72}
                      style={[
                        s.action,
                        inlineActions && s.inlineAction,
                        inlineActions && actions.length === 2 && index === 0 && s.inlineDivider,
                        !inlineActions && index > 0 && s.verticalDivider,
                      ]}
                      accessibilityRole="button"
                      testID={`app-dialog-action-${index}`}
                    >
                      <Text style={[s.actionText, { color: textColor }]}>{action.text}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </Animated.View>
          </Animated.View>
        </Modal>
      ) : null}
    </AppDialogContext.Provider>
  );
}

export function useAppDialog() {
  const ctx = useContext(AppDialogContext);
  if (!ctx) throw new Error('useAppDialog must be used inside AppDialogProvider');
  return ctx;
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: C.overlay,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  card: {
    width: '100%',
    maxWidth: APP_DIALOG_GEOMETRY.maxWidth,
    backgroundColor: C.card,
    borderRadius: APP_DIALOG_GEOMETRY.radius,
    alignItems: 'center',
    overflow: 'hidden',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 10,
  },
  iconRegion: {
    width: '100%',
    maxWidth: APP_DIALOG_GEOMETRY.contentWidth,
    minHeight: 40,
    marginTop: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleRegion: {
    width: '100%',
    maxWidth: APP_DIALOG_GEOMETRY.contentWidth,
    minHeight: APP_DIALOG_GEOMETRY.titleHeight,
    marginTop: 20,
    justifyContent: 'center',
  },
  title: {
    fontSize: APP_DIALOG_GEOMETRY.titleSize,
    lineHeight: APP_DIALOG_GEOMETRY.titleHeight,
    fontWeight: '600',
    color: C.text,
    textAlign: 'center',
  },
  contentRegion: {
    width: '100%',
    maxWidth: APP_DIALOG_GEOMETRY.contentWidth,
    maxHeight: 168,
    marginTop: 12,
  },
  contentContent: {
    flexGrow: 1,
  },
  message: {
    fontSize: APP_DIALOG_GEOMETRY.bodySize,
    lineHeight: 20,
    color: C.sub,
    textAlign: 'center',
  },
  hintText: {
    fontSize: 12,
    lineHeight: 18,
    color: C.sub,
    textAlign: 'center',
  },
  hintAfterMessage: { marginTop: 8 },
  actions: {
    width: '100%',
    marginTop: 20,
    borderTopWidth: APP_DIALOG_GEOMETRY.dividerWidth,
    borderTopColor: C.divider,
  },
  actionsInline: {
    flexDirection: 'row-reverse',
  },
  action: {
    width: '100%',
    minHeight: APP_DIALOG_GEOMETRY.actionHeight,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    backgroundColor: C.card,
  },
  inlineAction: {
    flex: 1,
    width: 'auto',
  },
  inlineDivider: {
    borderLeftWidth: APP_DIALOG_GEOMETRY.dividerWidth,
    borderLeftColor: C.divider,
  },
  verticalDivider: {
    borderTopWidth: APP_DIALOG_GEOMETRY.dividerWidth,
    borderTopColor: C.divider,
  },
  actionText: {
    fontSize: 17,
    lineHeight: 24,
    fontWeight: '500',
    textAlign: 'center',
  },
});
