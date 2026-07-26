import { useFocusEffect, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { MinutesDetailTitleBar } from '../components/MinutesDetailTitleBar';
import { ScreenContainer } from '../components/ScreenContainer';
import { fetchSharedMeetingContent } from '../data/api/v2';
import type { SharedMeetingContent } from '../domain/meeting';
import { readableErrorMessage } from '../services/errors';
import { getFeishuTokens } from '../theme/feishuTokens';
import type { RootStackParamList } from '../types';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'SharedMeetingContent'>;
  route: RouteProp<RootStackParamList, 'SharedMeetingContent'>;
};

export function SharedMeetingContentScreen({ navigation, route }: Props) {
  const { colors } = getFeishuTokens();
  const [content, setContent] = useState<SharedMeetingContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  useFocusEffect(useCallback(() => {
    let active = true;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void fetchSharedMeetingContent(route.params.token, controller.signal)
      .then(result => {
        if (active) setContent(result);
      })
      .catch(reason => {
        if (!active || controller.signal.aborted) return;
        setContent(null);
        setError(readableErrorMessage(reason, '共享内容暂时无法读取，请稍后重试。'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [reloadKey, route.params.token]));

  return (
    <ScreenContainer edges={['top', 'bottom']} style={{ backgroundColor: colors.backgroundBody }}>
      <MinutesDetailTitleBar title="共享会议资料" onBack={() => navigation.goBack()} />
      {loading && !content ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={[styles.errorTitle, { color: colors.textTitle }]}>共享内容不可用</Text>
          <Text style={[styles.errorText, { color: colors.textCaption }]}>{error}</Text>
          <Pressable
            style={({ pressed }) => [
              styles.retry,
              { backgroundColor: pressed ? colors.primaryPressed : colors.primary },
            ]}
            onPress={() => setReloadKey(value => value + 1)}
            accessibilityRole="button"
            accessibilityLabel="重新读取共享会议资料"
          >
            <Text style={[styles.retryText, { color: colors.onPrimary }]}>重试</Text>
          </Pressable>
        </View>
      ) : content ? (
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <View style={styles.metaRow}>
            <Text style={[styles.meta, { color: colors.textCaption }]}>
              {content.followLatestSummary ? '整理结果保持最新' : '内容已冻结'}
            </Text>
          </View>
          {content.sections.map(section => (
            <View key={section.key} style={[styles.section, { backgroundColor: colors.backgroundFloat }]}>
              <Text style={[styles.sectionTitle, { color: colors.textTitle }]}>{section.title}</Text>
              <Text selectable style={[styles.sectionContent, { color: colors.textTitle }]}>{section.content}</Text>
            </View>
          ))}
          <Text style={[styles.privacy, { color: colors.textCaption }]}>此页面只显示分享者选择的内容。</Text>
        </ScrollView>
      ) : null}
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  errorTitle: { fontSize: 18, lineHeight: 26, fontWeight: '500' },
  errorText: { marginTop: 8, fontSize: 14, lineHeight: 22, textAlign: 'center' },
  retry: { marginTop: 20, minWidth: 104, height: 48, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  retryText: { fontSize: 17, lineHeight: 24 },
  content: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 32 },
  metaRow: { minHeight: 28, justifyContent: 'center' },
  meta: { fontSize: 12, lineHeight: 18 },
  section: { marginTop: 12, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 14 },
  sectionTitle: { fontSize: 16, lineHeight: 24, fontWeight: '500' },
  sectionContent: { marginTop: 8, fontSize: 15, lineHeight: 24 },
  privacy: { marginTop: 20, fontSize: 12, lineHeight: 18, textAlign: 'center' },
});
