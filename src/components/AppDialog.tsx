import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors as C } from '../theme/colors';

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
  const dialogRef = useRef<AppDialogOptions | null>(null);

  const hideDialog = useCallback(() => {
    const current = dialogRef.current;
    dialogRef.current = null;
    setDialog(null);
    current?.onDismiss?.();
  }, []);
  const showDialog = useCallback((options: AppDialogOptions) => {
    dialogRef.current = options;
    setDialog(options);
  }, []);

  const value = useMemo(() => ({ showDialog, hideDialog }), [hideDialog, showDialog]);
  const tone = dialog?.tone ?? 'info';
  const accent = TONE_ACCENT[tone];
  const actions = dialog?.actions?.length ? dialog.actions : defaultActions();
  const inlineActions = actions.length <= 2;

  const runAction = async (action: AppDialogAction) => {
    dialogRef.current = null;
    setDialog(null);
    await action.onPress?.();
  };

  return (
    <AppDialogContext.Provider value={value}>
      {children}
      <Modal
        visible={Boolean(dialog)}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={hideDialog}
      >
        <View style={s.backdrop}>
          <View
            style={s.card}
            testID="app-dialog-card"
            accessibilityRole="alert"
            accessibilityLabel={dialog ? `${dialog.title}${dialog.message ? `，${dialog.message}` : ''}` : undefined}
          >
            {dialog?.icon ? (
              <View style={s.iconRegion} testID="app-dialog-icon">
                <Ionicons name={dialog.icon} size={40} color={accent} />
              </View>
            ) : null}

            <View style={s.titleRegion} testID="app-dialog-title-region">
              <Text style={s.title}>{dialog?.title}</Text>
            </View>
            {dialog?.message || dialog?.hint ? (
              <ScrollView
                style={s.contentRegion}
                contentContainerStyle={s.contentContent}
                testID="app-dialog-content-region"
              >
                {dialog?.message ? <Text style={s.message}>{dialog.message}</Text> : null}
                {dialog?.hint ? <Text style={[s.hintText, dialog.message && s.hintAfterMessage]}>{dialog.hint}</Text> : null}
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
                    onPress={() => { void runAction(action); }}
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
          </View>
        </View>
      </Modal>
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
    borderTopWidth: 1,
    borderTopColor: C.border,
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
  inlineDivider: { borderLeftWidth: 1, borderLeftColor: C.border },
  verticalDivider: { borderTopWidth: 1, borderTopColor: C.border },
  actionText: {
    fontSize: 17,
    lineHeight: 24,
    fontWeight: '500',
    textAlign: 'center',
  },
});
