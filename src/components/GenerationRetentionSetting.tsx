import React, { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useTheme } from '../theme/ThemeProvider';
import { loadGenerationRetentionPreference, saveGenerationRetentionPreference } from '../services/generationPrivacy';
import { SettingsRow } from './SettingsGroup';
import { SettingsHelp } from './SettingsHelp';

const LABEL = '保留生成结果';
const HELP = '开启后，允许服务端保留此后任务生成的转写、整理和问答结果，用于改进质量。结果可能含有人名等隐私信息，不保证匿名。\n\n关闭后，停止这类保留并清除已留存的改进副本。本机结果不受影响；正常处理和任务恢复所需的保存不受此开关控制。';

export function GenerationRetentionSetting() {
  const { tokens } = useTheme();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(true);
  const operation = useRef(0);
  const changing = useRef(false);
  const focused = useRef(false);
  const load = useCallback(async () => {
    if (changing.current) return;
    const generation = ++operation.current;
    setBusy(true);
    try {
      const value = await loadGenerationRetentionPreference();
      if (generation === operation.current) setEnabled(value);
    } catch {
      if (generation === operation.current) setEnabled(null);
    } finally {
      if (generation === operation.current) setBusy(false);
    }
  }, []);
  useFocusEffect(useCallback(() => {
    focused.current = true;
    void load();
    return () => { focused.current = false; operation.current += 1; };
  }, [load]));
  const change = async (next: boolean) => {
    if (changing.current || busy || enabled === null) return;
    changing.current = true;
    const generation = ++operation.current;
    setBusy(true);
    try {
      const saved = await saveGenerationRetentionPreference(next);
      if (generation === operation.current) setEnabled(saved);
    } catch {
      if (generation === operation.current) {
        // A lost PUT response is ambiguous. Re-read rather than presenting
        // either old or optimistic permission as the server's confirmed value.
        setEnabled(null);
      }
    } finally {
      changing.current = false;
      if (generation === operation.current) setBusy(false);
      else if (focused.current) void load();
    }
  };
  return <SettingsRow label={LABEL} testID="privacy-generation-retention-row"
    labelAccessory={<SettingsHelp label={LABEL} text={HELP} testID="privacy-generation-retention-help" />}
    right={<View style={s.control}>
      {enabled === null ? (busy
        ? <ActivityIndicator color={tokens.colors.primary} size="small" testID="privacy-generation-retention-loading" />
        : <Pressable accessibilityRole="button" accessibilityLabel="重新读取保留设置"
          testID="privacy-generation-retention-retry" style={s.retry} onPress={() => { void load(); }}>
          <Text style={{ fontSize: 14, color: tokens.colors.primary }}>重试</Text>
        </Pressable>)
        : <Switch value={enabled} onValueChange={next => { void change(next); }} disabled={busy}
          accessibilityLabel={LABEL} accessibilityState={{ checked: enabled, disabled: busy }}
          trackColor={{ false: tokens.colors.iconDisabled, true: tokens.colors.primary }}
          thumbColor={tokens.colors.backgroundFloat} testID="privacy-generation-retention-toggle" />}
    </View>} />;
}

const s = StyleSheet.create({
  control: { width: 52, height: 44, justifyContent: 'center', alignItems: 'center' },
  retry: { width: 44, height: 44, justifyContent: 'center', alignItems: 'center' },
});
