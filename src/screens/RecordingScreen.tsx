import React, { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { Colors as C } from '../theme/colors';
import { ScreenContainer } from '../components/ScreenContainer';
import { RootStackParamList } from '../types';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Recording'>;
  route: RouteProp<RootStackParamList, 'Recording'>;
};

// Retain the old route for saved navigation state and external deep links.
export function RecordingScreen({ navigation, route }: Props) {
  useEffect(() => {
    navigation.replace('Transcription', { meetingId: route.params.meetingId });
  }, [navigation, route.params.meetingId]);

  return (
    <ScreenContainer edges={['top', 'bottom']} bg={C.body}>
      <View style={s.loading}>
        <ActivityIndicator size="small" color={C.primary} />
      </View>
    </ScreenContainer>
  );
}

const s = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
