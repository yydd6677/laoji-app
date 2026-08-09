import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { Avatar, BackHeader } from '../components/Common';
import { ScreenContainer } from '../components/ScreenContainer';
import { readableErrorMessage } from '../services/errors';
import { fetchDeviceSpeakerProfiles, fetchSpeakers, SpeakerProfile } from '../services/speakers';
import { useAuth } from '../store/AuthStore';
import { Colors as C, withAlpha } from '../theme/colors';
import { RootStackParamList } from '../types';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'SpeakerManager'> };

export function SpeakerManagerScreen({ navigation }: Props) {
  const { accessToken, isGuest } = useAuth();
  const [speakers, setSpeakers] = useState<SpeakerProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const loadGenerationRef = useRef(0);
  const deviceMode = isGuest || !accessToken;

  useLayoutEffect(() => {
    loadGenerationRef.current += 1;
    setSpeakers([]);
    setLoading(false);
    setError('');
  }, [accessToken, isGuest]);

  const load = useCallback(async () => {
    const requestGeneration = ++loadGenerationRef.current;
    setLoading(true);
    setError('');
    try {
      const result = deviceMode
        ? await fetchDeviceSpeakerProfiles()
        : await fetchSpeakers(accessToken!);
      if (loadGenerationRef.current === requestGeneration) setSpeakers(result);
    } catch (reason) {
      if (loadGenerationRef.current === requestGeneration) {
        setError(readableErrorMessage(reason, '讲话人暂时无法加载，请稍后重试。'));
      }
    } finally {
      if (loadGenerationRef.current === requestGeneration) setLoading(false);
    }
  }, [accessToken, deviceMode]);

  useFocusEffect(useCallback(() => {
    void load();
    return () => {
      loadGenerationRef.current += 1;
    };
  }, [load]));

  return (
    <ScreenContainer edges={['top']} bg={C.appBg}>
      <BackHeader title="讲话人管理" onBack={() => navigation.goBack()} />
      <FlatList
          style={s.list}
          contentContainerStyle={[s.listContent, speakers.length === 0 && s.emptyListContent]}
          data={speakers}
          keyExtractor={speaker => speaker.speaker_id}
          showsVerticalScrollIndicator={false}
          refreshing={loading && speakers.length > 0}
          onRefresh={() => { void load(); }}
          ListHeaderComponent={(
            <View>
              <TouchableOpacity
                style={s.addRow}
                onPress={() => navigation.navigate('SpeakerEnrollment')}
                accessibilityRole="button"
                accessibilityLabel="新建讲话人"
              >
                <View style={s.addIcon}>
                  <Ionicons name="person-add-outline" size={20} color={C.primary} />
                </View>
                <Text style={s.addText}>新建讲话人</Text>
              </TouchableOpacity>
              <View style={s.groupGap} />
              {error ? (
                <TouchableOpacity
                  style={s.errorBox}
                  onPress={() => void load()}
                  accessibilityRole="button"
                  accessibilityLabel="重试加载讲话人"
                >
                  <Ionicons name="cloud-offline-outline" size={18} color={C.red} />
                  <Text style={s.errorText}>{error}</Text>
                  <Ionicons name="refresh" size={18} color={C.primary} />
                </TouchableOpacity>
              ) : null}
            </View>
          )}
          ListEmptyComponent={(
            <View style={s.stateBox}>
              {loading ? (
                <>
                  <ActivityIndicator color={C.primary} />
                  <Text style={s.stateText}>正在加载讲话人</Text>
                </>
              ) : error ? null : (
                <Text style={s.stateText}>暂无讲话人</Text>
              )}
            </View>
          )}
          ItemSeparatorComponent={() => <View style={s.rowDivider} />}
          renderItem={({ item: speaker }) => (
            <TouchableOpacity
              style={s.speakerRow}
              activeOpacity={0.68}
              onPress={() => navigation.navigate('SpeakerEnrollment', { speakerId: speaker.speaker_id })}
              accessibilityRole="button"
              accessibilityLabel={`管理讲话人${speaker.name}`}
            >
              <Avatar size={40} />
              <View style={s.speakerBody}>
                <Text style={s.speakerName} numberOfLines={1}>{speaker.name}</Text>
                {speaker.quality < 0.4 ? <Text style={s.speakerMeta}>建议补充采集</Text> : null}
              </View>
              <Ionicons name="chevron-forward" size={18} color={C.faint} />
            </TouchableOpacity>
          )}
        />
    </ScreenContainer>
  );
}

const s = StyleSheet.create({
  list: { flex: 1, backgroundColor: C.appBg },
  listContent: { paddingBottom: 24 },
  emptyListContent: { flexGrow: 1 },
  addRow: { height: 64, paddingHorizontal: 16, backgroundColor: C.body, flexDirection: 'row', alignItems: 'center' },
  addIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: C.primaryLight, alignItems: 'center', justifyContent: 'center' },
  addText: { marginLeft: 12, fontSize: 16, lineHeight: 24, color: C.primary },
  groupGap: { height: 8, backgroundColor: C.appBg },
  guestWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 38, paddingBottom: 80 },
  guestTitle: { marginTop: 12, fontSize: 16, lineHeight: 24, color: C.text, fontWeight: '600' },
  stateBox: { flex: 1, minHeight: 220, alignItems: 'center', justifyContent: 'center', gap: 10 },
  stateText: { fontSize: 14, lineHeight: 20, color: C.sub, textAlign: 'center' },
  primaryButton: { minHeight: 40, borderRadius: 6, backgroundColor: C.primary, paddingHorizontal: 20, marginTop: 20, alignItems: 'center', justifyContent: 'center' },
  primaryButtonText: { fontSize: 14, lineHeight: 20, color: '#fff', fontWeight: '500' },
  errorBox: { minHeight: 44, backgroundColor: withAlpha(C.red, 0.08), paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 9 },
  errorText: { flex: 1, fontSize: 13, lineHeight: 20, color: C.red },
  speakerRow: { height: 66, backgroundColor: C.body, paddingLeft: 16, paddingRight: 16, flexDirection: 'row', alignItems: 'center' },
  rowDivider: { height: StyleSheet.hairlineWidth, marginLeft: 76, backgroundColor: C.border },
  speakerBody: { flex: 1, minWidth: 0, marginLeft: 12 },
  speakerName: { fontSize: 16, lineHeight: 22, color: C.text },
  speakerMeta: { marginTop: 2, fontSize: 12, lineHeight: 18, color: C.orange },
});
