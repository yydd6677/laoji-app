import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { BackHeader } from '../components/Common';
import { ScreenContainer } from '../components/ScreenContainer';
import { readableErrorMessage } from '../services/errors';
import { fetchSpeakers, SpeakerProfile } from '../services/speakers';
import { useAuth } from '../store/AuthStore';
import { Colors as C } from '../theme/colors';
import { RootStackParamList } from '../types';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'SpeakerManager'> };

function qualityLabel(value: number): string {
  if (value >= 0.8) return '优秀';
  if (value >= 0.6) return '良好';
  if (value >= 0.4) return '一般';
  return '建议补录';
}

export function SpeakerManagerScreen({ navigation }: Props) {
  const { accessToken, isGuest } = useAuth();
  const [speakers, setSpeakers] = useState<SpeakerProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const loadGenerationRef = useRef(0);

  useLayoutEffect(() => {
    loadGenerationRef.current += 1;
    setSpeakers([]);
    setLoading(false);
    setError('');
  }, [accessToken, isGuest]);

  const load = useCallback(async () => {
    const requestGeneration = ++loadGenerationRef.current;
    if (!accessToken || isGuest) return;
    setLoading(true);
    setError('');
    try {
      const result = await fetchSpeakers(accessToken);
      if (loadGenerationRef.current === requestGeneration) setSpeakers(result);
    } catch (reason) {
      if (loadGenerationRef.current === requestGeneration) {
        setError(readableErrorMessage(reason, '讲话人暂时无法加载，请稍后重试。'));
      }
    } finally {
      if (loadGenerationRef.current === requestGeneration) setLoading(false);
    }
  }, [accessToken, isGuest]);

  useFocusEffect(useCallback(() => {
    void load();
    return () => {
      loadGenerationRef.current += 1;
    };
  }, [load]));

  const addButton = !isGuest && accessToken ? (
    <TouchableOpacity
      style={s.headerButton}
      onPress={() => navigation.navigate('SpeakerEnrollment')}
      accessibilityRole="button"
      accessibilityLabel="新建讲话人"
    >
      <Ionicons name="add" size={22} color={C.purple} />
    </TouchableOpacity>
  ) : null;

  return (
    <ScreenContainer edges={['top']}>
      <BackHeader title="讲话人管理" onBack={() => navigation.goBack()} right={addButton} />
      {isGuest || !accessToken ? (
        <View style={s.guestWrap}>
          <View style={s.heroIcon}><Ionicons name="people-outline" size={34} color={C.purple} /></View>
          <Text style={s.guestTitle}>登录后管理讲话人</Text>
          <Text style={s.guestText}>声纹是账号私有资料，访客模式不会上传或保存个人音色。</Text>
          <TouchableOpacity
            style={s.primaryButton}
            onPress={() => navigation.navigate('Profile')}
            accessibilityRole="button"
            accessibilityLabel="前往账号页面"
          >
            <Text style={s.primaryButtonText}>前往账号</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView style={s.scroll} contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
          <View style={s.introBand}>
            <Ionicons name="shield-checkmark-outline" size={20} color={C.purple} />
            <Text style={s.introText}>会议只会使用当前账号保存的声纹识别讲话人。</Text>
          </View>

          {loading && speakers.length === 0 ? (
            <View style={s.stateBox}>
              <ActivityIndicator color={C.purple} />
              <Text style={s.stateText}>正在加载讲话人</Text>
            </View>
          ) : null}

          {error ? (
            <TouchableOpacity
              style={s.errorBox}
              onPress={() => void load()}
              accessibilityRole="button"
              accessibilityLabel="重试加载讲话人"
            >
              <Ionicons name="cloud-offline-outline" size={18} color={C.red} />
              <Text style={s.errorText}>{error}</Text>
              <Ionicons name="refresh" size={18} color={C.purple} />
            </TouchableOpacity>
          ) : null}

          {!loading && !error && speakers.length === 0 ? (
            <View style={s.stateBox}>
              <View style={s.emptyIcon}><Ionicons name="person-add-outline" size={27} color={C.purple} /></View>
              <Text style={s.stateTitle}>还没有讲话人</Text>
              <Text style={s.stateText}>录制一段个人音色后，实时会议会尝试显示对应名称。</Text>
              <TouchableOpacity
                style={s.primaryButton}
                onPress={() => navigation.navigate('SpeakerEnrollment')}
                accessibilityRole="button"
                accessibilityLabel="新建第一个讲话人"
              >
                <Ionicons name="mic-outline" size={17} color="#fff" />
                <Text style={s.primaryButtonText}>录制音色</Text>
              </TouchableOpacity>
            </View>
          ) : null}

          {speakers.map(speaker => (
            <TouchableOpacity
              key={speaker.speaker_id}
              style={s.speakerCard}
              activeOpacity={0.84}
              onPress={() => navigation.navigate('SpeakerEnrollment', { speakerId: speaker.speaker_id })}
              accessibilityRole="button"
              accessibilityLabel={`管理讲话人${speaker.name}`}
            >
              <View style={s.personIcon}><Ionicons name="person-outline" size={20} color={C.purple} /></View>
              <View style={s.speakerBody}>
                <Text style={s.speakerName} numberOfLines={1}>{speaker.name}</Text>
                <Text style={s.speakerMeta}>{speaker.sample_count} 段音色 · 质量{qualityLabel(speaker.quality)}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={C.faint} />
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
    </ScreenContainer>
  );
}

const s = StyleSheet.create({
  headerButton: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  scroll: { flex: 1 },
  content: { padding: 14, paddingBottom: 36 },
  introBand: { minHeight: 52, borderRadius: 14, backgroundColor: C.purpleLight, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  introText: { flex: 1, fontSize: 12, lineHeight: 18, color: '#5A5079', fontWeight: '600' },
  guestWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 38, paddingBottom: 80 },
  heroIcon: { width: 70, height: 70, borderRadius: 35, backgroundColor: C.purpleLight, alignItems: 'center', justifyContent: 'center', marginBottom: 18 },
  guestTitle: { fontSize: 18, color: C.text, fontWeight: '800', marginBottom: 8 },
  guestText: { fontSize: 13, lineHeight: 20, color: C.sub, textAlign: 'center', marginBottom: 22 },
  stateBox: { minHeight: 210, borderRadius: 16, backgroundColor: C.card, padding: 24, alignItems: 'center', justifyContent: 'center', gap: 10 },
  emptyIcon: { width: 54, height: 54, borderRadius: 27, backgroundColor: C.purpleLight, alignItems: 'center', justifyContent: 'center', marginBottom: 2 },
  stateTitle: { fontSize: 16, color: C.text, fontWeight: '800' },
  stateText: { fontSize: 12, lineHeight: 18, color: C.sub, textAlign: 'center' },
  primaryButton: { minHeight: 42, borderRadius: 21, backgroundColor: C.purple, paddingHorizontal: 20, marginTop: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  primaryButtonText: { fontSize: 13, color: '#fff', fontWeight: '800' },
  errorBox: { minHeight: 54, borderRadius: 14, backgroundColor: '#FFF1F2', paddingHorizontal: 14, marginBottom: 12, flexDirection: 'row', alignItems: 'center', gap: 9 },
  errorText: { flex: 1, fontSize: 12, lineHeight: 18, color: C.red },
  speakerCard: { height: 74, borderRadius: 16, backgroundColor: C.card, paddingHorizontal: 14, marginBottom: 10, flexDirection: 'row', alignItems: 'center', gap: 12, shadowColor: '#5028A0', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 8, elevation: 2 },
  personIcon: { width: 42, height: 42, borderRadius: 21, backgroundColor: C.purpleLight, alignItems: 'center', justifyContent: 'center' },
  speakerBody: { flex: 1, minWidth: 0 },
  speakerName: { fontSize: 15, color: C.text, fontWeight: '800', marginBottom: 5 },
  speakerMeta: { fontSize: 11, color: C.sub, fontWeight: '600' },
});
