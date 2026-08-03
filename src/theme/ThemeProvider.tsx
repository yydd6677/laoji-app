import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Colors, getColorsForTheme } from './colors';
import { getFeishuTokens } from './feishuTokens';
import { DEFAULT_THEME_ID, type ThemeId } from './themeIds';
import { getSynchronousThemeId, restartNativeActivity } from './nativeTheme';
import { loadThemePreference, saveThemePreference } from '../services/themePreferences';

type ThemeContextValue = {
  themeId: ThemeId;
  colors: typeof Colors;
  tokens: ReturnType<typeof getFeishuTokens>;
  ready: boolean;
  setTheme: (themeId: ThemeId) => Promise<void>;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [themeId, setThemeId] = useState<ThemeId>(getSynchronousThemeId());
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    void loadThemePreference()
      .then(saved => {
        if (!alive) return;
        setThemeId(saved);
        setReady(true);
      })
      .catch(() => {
        if (!alive) return;
        setThemeId(DEFAULT_THEME_ID);
        setReady(true);
      });
    return () => { alive = false; };
  }, []);

  const setTheme = useCallback(async (nextThemeId: ThemeId) => {
    if (nextThemeId === themeId) return;
    await saveThemePreference(nextThemeId);
    setThemeId(nextThemeId);
    // Most legacy screens create StyleSheet colors at module evaluation time.
    // Android activity recreation reloads those modules with the new native
    // preference; the JS fallback still updates the context immediately.
    restartNativeActivity();
  }, [themeId]);

  const value = useMemo<ThemeContextValue>(() => ({
    themeId,
    colors: getColorsForTheme(themeId),
    tokens: getFeishuTokens('light', themeId),
    ready,
    setTheme,
  }), [ready, setTheme, themeId]);

  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: getColorsForTheme(themeId).appBg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={getColorsForTheme(themeId).primary} />
      </View>
    );
  }

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside ThemeProvider');
  return context;
}
