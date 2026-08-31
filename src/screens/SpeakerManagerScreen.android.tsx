import React, { useCallback, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  LaojiSpeakerView,
  type NativeSpeakerAction,
} from 'laoji-native-platform';
import { ScreenContainer } from '../components/ScreenContainer';
import { readableErrorMessage } from '../services/errors';
import { fetchDeviceSpeakerProfiles, type SpeakerProfile } from '../services/speakers';
import type { RootStackParamList } from '../types';
import { buildNativeSpeakerManagerSnapshot } from '../native/nativeSpeakerSnapshots';
import { Colors as C } from '../theme/colors';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'SpeakerManager'> };

// MIN-SPEAKER-001: Android renders the speaker repository through one native list owner.
export function SpeakerManagerScreen({ navigation }: Props) {
  const [speakers, setSpeakers] = useState<SpeakerProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const generationRef = useRef(0);

  const load = useCallback(async () => {
    const generation = ++generationRef.current;
    setLoading(true);
    setError('');
    try {
      const result = await fetchDeviceSpeakerProfiles();
      if (generationRef.current === generation) setSpeakers(result);
    } catch (reason) {
      if (generationRef.current === generation) {
        setError(readableErrorMessage(reason, '讲话人暂时无法加载，请稍后重试。'));
      }
    } finally {
      if (generationRef.current === generation) setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    void load();
    return () => { generationRef.current += 1; };
  }, [load]));

  const snapshot = useMemo(() => buildNativeSpeakerManagerSnapshot({
    // The native surface's guest flag means “account login required”.  The
    // device-primary service is usable without an account, so keep it false
    // and represent an unavailable service as an ordinary retryable error.
    guest: false,
    phase: loading ? 'loading' : error ? 'error' : 'ready',
    message: error,
    speakers,
  }), [error, loading, speakers]);

  const handleAction = useCallback((action: NativeSpeakerAction) => {
    switch (action.type) {
      case 'back':
        navigation.goBack();
        break;
      case 'login':
        void load();
        break;
      case 'retry':
        void load();
        break;
      case 'create':
        navigation.navigate('SpeakerEnrollment');
        break;
      case 'open':
        navigation.navigate('SpeakerEnrollment', { speakerId: action.speakerId });
        break;
      default:
        break;
    }
  }, [load, navigation]);

  return (
    <ScreenContainer edges={['top', 'bottom']} bg={C.appBg}>
      <View
        style={styles.root}
        testID="speaker-manager-native-root"
        collapsable={false}
        collapsableChildren={false}
      >
        <LaojiSpeakerView
          style={styles.surface}
          surface="manager"
          snapshot={snapshot}
          onSpeakerAction={event => handleAction(event.nativeEvent)}
          testID="speaker-manager-native-surface"
        />
      </View>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  surface: { flex: 1 },
});
