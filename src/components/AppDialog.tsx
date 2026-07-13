import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
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

const TONE_META: Record<AppDialogTone, { icon: IconName; accent: string; halo: string; iconColors: [string, string] }> = {
  info: {
    icon: 'information-circle-outline',
    accent: C.pinkBorder,
    halo: '#F5F0FF',
    iconColors: [C.logoFrom, C.logoTo],
  },
  success: {
    icon: 'checkmark-circle-outline',
    accent: C.green,
    halo: '#EFFBE9',
    iconColors: [C.green, '#89D85C'],
  },
  warning: {
    icon: 'alert-circle-outline',
    accent: C.orange,
    halo: '#FFF6E8',
    iconColors: [C.orange, '#FFC05C'],
  },
  error: {
    icon: 'alert-circle-outline',
    accent: C.pinkBorder,
    halo: '#FFF0F8',
    iconColors: [C.logoTo, C.pink],
  },
  danger: {
    icon: 'trash-outline',
    accent: C.red,
    halo: '#FFF0F0',
    iconColors: [C.red, '#D9363E'],
  },
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
  const meta = TONE_META[tone];
  const actions = dialog?.actions?.length ? dialog.actions : defaultActions();

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
            accessibilityRole="alert"
            accessibilityLabel={dialog ? `${dialog.title}${dialog.message ? `，${dialog.message}` : ''}` : undefined}
          >
            <View style={[s.accent, { backgroundColor: meta.accent }]} />
            <View style={[s.iconHalo, { backgroundColor: meta.halo }]}>
              <LinearGradient
                colors={meta.iconColors}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={s.iconCircle}
              >
                <Ionicons name={dialog?.icon ?? meta.icon} size={28} color="#fff" />
              </LinearGradient>
            </View>

            <Text style={s.title}>{dialog?.title}</Text>
            {dialog?.message ? (
              <ScrollView style={s.messageScroll} contentContainerStyle={s.messageContent}>
                <Text style={s.message}>{dialog.message}</Text>
              </ScrollView>
            ) : null}

            {dialog?.hint ? (
              <View style={s.hintBox}>
                <Ionicons name="information-circle-outline" size={16} color={C.purple} />
                <Text style={s.hintText}>{dialog.hint}</Text>
              </View>
            ) : null}

            <View style={s.actions}>
              {actions.map((action, index) => {
                const role = action.role ?? (index === 0 ? 'primary' : 'secondary');
                const isPrimary = role === 'primary';
                const isDanger = role === 'destructive';
                const isCancel = role === 'cancel';

                if (isPrimary || isDanger) {
                  return (
                    <TouchableOpacity
                      key={`${action.text}-${index}`}
                      onPress={() => { void runAction(action); }}
                      activeOpacity={0.88}
                      style={s.actionWrap}
                      accessibilityRole="button"
                    >
                      <LinearGradient
                        colors={isDanger ? [C.red, '#D9363E'] : [C.gradFrom, C.gradTo]}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 0 }}
                        style={s.primaryAction}
                      >
                        <Text style={s.primaryActionText}>{action.text}</Text>
                      </LinearGradient>
                    </TouchableOpacity>
                  );
                }

                return (
                  <TouchableOpacity
                    key={`${action.text}-${index}`}
                    onPress={() => { void runAction(action); }}
                    activeOpacity={0.75}
                    style={[s.secondaryAction, isCancel && s.cancelAction]}
                    accessibilityRole="button"
                  >
                    <Text style={[s.secondaryActionText, isCancel && s.cancelActionText]}>
                      {action.text}
                    </Text>
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
    backgroundColor: 'rgba(28, 27, 51, 0.34)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  card: {
    width: '100%',
    maxWidth: 340,
    backgroundColor: C.card,
    borderRadius: 28,
    paddingHorizontal: 22,
    paddingTop: 26,
    paddingBottom: 18,
    alignItems: 'center',
    overflow: 'hidden',
    shadowColor: '#5028A0',
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.18,
    shadowRadius: 26,
    elevation: 12,
  },
  accent: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 6,
  },
  iconHalo: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  iconCircle: {
    width: 54,
    height: 54,
    borderRadius: 27,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#B464DC',
    shadowOffset: { width: 0, height: 7 },
    shadowOpacity: 0.26,
    shadowRadius: 14,
    elevation: 6,
  },
  title: {
    fontSize: 20,
    fontWeight: '800',
    color: C.text,
    textAlign: 'center',
    marginBottom: 8,
  },
  messageScroll: {
    width: '100%',
    maxHeight: 168,
    marginBottom: 14,
  },
  messageContent: {
    flexGrow: 1,
  },
  message: {
    fontSize: 14,
    lineHeight: 22,
    color: '#4A4666',
    textAlign: 'center',
  },
  hintBox: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    backgroundColor: C.purpleLight,
    borderRadius: 14,
    padding: 12,
    marginBottom: 16,
  },
  hintText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 18,
    color: '#6F68A0',
  },
  actions: {
    width: '100%',
    gap: 8,
  },
  actionWrap: {
    width: '100%',
  },
  primaryAction: {
    minHeight: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
    shadowColor: '#6A38B2',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.32,
    shadowRadius: 12,
    elevation: 5,
  },
  primaryActionText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#fff',
  },
  secondaryAction: {
    minHeight: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
    backgroundColor: '#F7F3FF',
  },
  secondaryActionText: {
    fontSize: 14,
    fontWeight: '700',
    color: C.purple,
  },
  cancelAction: {
    backgroundColor: 'transparent',
  },
  cancelActionText: {
    color: C.sub,
  },
});
