import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState } from 'react-native';
import { NavigationContainer, type InitialState, type NavigationState } from '@react-navigation/native';
import { useAuth } from '../store/AuthStore';
import {
  defaultNavigationState,
  navigationScopeForAuth,
  type NavigationAuthScope,
} from '../services/navigationState';
import { NavigationStateWriter } from '../services/navigationStatePersistence';
import {
  flushPendingNotificationNavigation,
  navigationRef,
} from './notificationNavigation';
import { diagnosticAudit } from '../services/diagnostics';

type NavigationDecision = {
  scope: NavigationAuthScope;
  initialState: InitialState;
};

type NavigationStateContextValue = {
  ready: boolean;
  scope: NavigationAuthScope | null;
  initialState?: InitialState;
  persistState: (state: NavigationState | undefined) => void;
  flush: () => Promise<void>;
};

const NavigationStateContext = createContext<NavigationStateContextValue | null>(null);

export function NavigationStateProvider({
  children,
  writer: suppliedWriter,
}: {
  children: React.ReactNode;
  writer?: NavigationStateWriter;
}) {
  const { initializing, mode, session } = useAuth();
  const desiredScope = initializing
    ? null
    : navigationScopeForAuth(mode, session?.user.id);
  const writerRef = useRef<NavigationStateWriter | null>(null);
  if (!writerRef.current) writerRef.current = suppliedWriter ?? new NavigationStateWriter();
  const writer = writerRef.current;
  const previousScopeRef = useRef<NavigationAuthScope | null>(null);
  const restoreRequestRef = useRef(0);
  const [decision, setDecision] = useState<NavigationDecision | null>(null);

  useEffect(() => {
    if (!desiredScope) {
      setDecision(null);
      return;
    }
    const request = restoreRequestRef.current + 1;
    restoreRequestRef.current = request;
    const previousScope = previousScopeRef.current;
    previousScopeRef.current = desiredScope;
    let active = true;
    const startedAtMs = Date.now();

    const restore = async (): Promise<InitialState> => {
      if (previousScope === null) {
        writer.activateInitialScope(desiredScope);
        return (await writer.restore(desiredScope)).state;
      }
      if (previousScope !== desiredScope) {
        await writer.switchScope(desiredScope);
        return defaultNavigationState(desiredScope);
      }
      return (await writer.restore(desiredScope)).state;
    };

    void restore()
      .then(initialState => {
        if (!active || restoreRequestRef.current !== request) return;
        diagnosticAudit('app_start_navigation_ready', {
          elapsed_ms: Math.max(0, Date.now() - startedAtMs),
          restored: true,
        });
        setDecision({ scope: desiredScope, initialState });
      })
      .catch(() => {
        if (!active || restoreRequestRef.current !== request) return;
        diagnosticAudit('app_start_navigation_ready', {
          elapsed_ms: Math.max(0, Date.now() - startedAtMs),
          restored: false,
        });
        setDecision({ scope: desiredScope, initialState: defaultNavigationState(desiredScope) });
      });
    return () => { active = false; };
  }, [desiredScope, writer]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') void writer.flush().catch(() => undefined);
    });
    return () => {
      subscription.remove();
      void writer.flush().catch(() => undefined);
    };
  }, [writer]);

  const persistState = useCallback((state: NavigationState | undefined) => {
    if (desiredScope && state) writer.schedule(desiredScope, state);
  }, [desiredScope, writer]);
  const flush = useCallback(() => writer.flush(), [writer]);
  const ready = Boolean(desiredScope && decision?.scope === desiredScope);
  const value = useMemo<NavigationStateContextValue>(() => ({
    ready,
    scope: desiredScope,
    initialState: ready ? decision?.initialState : undefined,
    persistState,
    flush,
  }), [decision?.initialState, desiredScope, flush, persistState, ready]);

  return (
    <NavigationStateContext.Provider value={value}>
      {children}
    </NavigationStateContext.Provider>
  );
}

export function useNavigationStateRestoration(): NavigationStateContextValue {
  const value = useContext(NavigationStateContext);
  if (!value) throw new Error('useNavigationStateRestoration must be used within NavigationStateProvider');
  return value;
}

export function RestorableNavigationContainer({ children }: { children: React.ReactNode }) {
  const { ready, scope, initialState, persistState } = useNavigationStateRestoration();
  if (!ready || !scope || !initialState) return null;

  return (
    <NavigationContainer
      key={`navigation:${scope}`}
      ref={navigationRef}
      initialState={initialState}
      onReady={() => { void flushPendingNotificationNavigation(); }}
      onStateChange={state => {
        persistState(state);
        void flushPendingNotificationNavigation();
      }}
    >
      {children}
    </NavigationContainer>
  );
}
