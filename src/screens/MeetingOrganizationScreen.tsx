import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { ManageMeetingOrganizationUseCase } from '../application/meeting';
import { ScreenContainer } from '../components/ScreenContainer';
import { SettingsTitleBar } from '../components/SettingsGroup';
import type {
  MeetingOrganizationMeeting,
  MeetingOrganizationProjection,
  MeetingPersonAggregate,
  MeetingTopicAggregate,
} from '../data/repositories';
import { sqliteMeetingNoteRepository } from '../data/repositories';
import { getFeatureFlags } from '../config/featureFlags';
import type { ScopeKey } from '../domain/meeting';
import { readableErrorMessage } from '../services/errors';
import { useAuth } from '../store/AuthStore';
import {
  FEISHU_FONT_SIZES,
  FEISHU_RADII,
  getFeishuTokens,
} from '../theme/feishuTokens';
import type { RootStackParamList } from '../types';
import { displayMeetingTitle } from '../utils/meetingTitle';

const { colors: F } = getFeishuTokens();
const meetingOrganization = new ManageMeetingOrganizationUseCase(sqliteMeetingNoteRepository);
const AUTOMATIC_TOPICS_ENABLED = getFeatureFlags().meetingAutomaticTopicsV1;
const EMPTY_PROJECTION: MeetingOrganizationProjection = { people: [], topics: [] };

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'MeetingOrganization'>;
};

type OrganizationMode = 'people' | 'topics';
type OrganizationGroup =
  | { kind: 'person'; aggregate: MeetingPersonAggregate }
  | { kind: 'topic'; aggregate: MeetingTopicAggregate };

function formatMeetingMoment(value: number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const localDay = (item: Date) => Date.UTC(
    item.getFullYear(),
    item.getMonth(),
    item.getDate(),
  ) / 86_400_000;
  const dayOffset = localDay(date) - localDay(now);
  const day = dayOffset === 0
    ? '今天'
    : dayOffset === -1
      ? '昨天'
      : `${date.getFullYear() === now.getFullYear() ? '' : `${date.getFullYear()}年`}${date.getMonth() + 1}月${date.getDate()}日`;
  return `${day} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function MeetingRow({
  meeting,
  occurrenceLabel,
  onPress,
}: {
  meeting: MeetingOrganizationMeeting;
  occurrenceLabel?: string;
  onPress: () => void;
}) {
  const moment = formatMeetingMoment(meeting.recordedAtMs);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={[
        displayMeetingTitle(meeting.title),
        moment,
        occurrenceLabel,
      ].filter(Boolean).join('，')}
      style={({ pressed }) => [styles.meetingRow, pressed && { backgroundColor: F.pressedFill }]}
    >
      <View style={styles.meetingCopy}>
        <Text style={[styles.meetingTitle, { color: F.textTitle }]} numberOfLines={1}>
          {displayMeetingTitle(meeting.title)}
        </Text>
        <Text style={[styles.meetingMeta, { color: F.textCaption }]} numberOfLines={1}>
          {[moment, occurrenceLabel].filter(Boolean).join('  ·  ')}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={16} color={F.iconTertiary} />
    </Pressable>
  );
}

function OrganizationGroupCard({
  group,
  onOpenMeeting,
}: {
  group: OrganizationGroup;
  onOpenMeeting: (meetingId: string) => void;
}) {
  const person = group.kind === 'person' ? group.aggregate : null;
  const topic = group.kind === 'topic' ? group.aggregate : null;
  const isPerson = person !== null;
  const isSummaryTopic = topic?.source === 'summary';
  const aggregate = group.aggregate;
  const name = aggregate.name;
  const meetingCount = aggregate.meetingCount;
  const summary = person
    ? `${meetingCount} 场会议 · ${person.occurrenceCount} 段发言`
    : `${meetingCount} 场会议`;
  return (
    <View style={[styles.group, { backgroundColor: F.backgroundFloat }]}>
      <View style={styles.groupHeader}>
        <View style={[
          styles.groupIcon,
          { backgroundColor: isSummaryTopic ? F.backgroundBodyOverlay : F.primarySoft },
        ]}>
          {isPerson ? (
            <Text style={[styles.groupInitial, { color: F.primary }]} numberOfLines={1}>
              {name.slice(0, 1)}
            </Text>
          ) : (
            <Ionicons
              name={isSummaryTopic ? 'document-text-outline' : 'pricetag-outline'}
              size={20}
              color={isSummaryTopic ? F.iconSecondary : F.primary}
            />
          )}
        </View>
        <View style={styles.groupCopy}>
          <View style={styles.groupTitleLine}>
            <Text style={[styles.groupTitle, { color: F.textTitle }]} numberOfLines={1}>
              {name}
            </Text>
            {person && !person.confirmed ? (
              <View style={[styles.badge, { backgroundColor: F.backgroundBodyOverlay }]}>
                <Text style={[styles.badgeText, { color: F.textCaption }]}>未确认</Text>
              </View>
            ) : null}
            {topic ? (
              <View style={[
                styles.badge,
                { backgroundColor: isSummaryTopic ? F.backgroundBodyOverlay : F.primarySoft },
              ]}>
                <Text style={[
                  styles.badgeText,
                  { color: isSummaryTopic ? F.textCaption : F.primary },
                ]}>
                  {isSummaryTopic ? '整理主题' : '用户标签'}
                </Text>
              </View>
            ) : null}
          </View>
          <Text style={[styles.groupMeta, { color: F.textCaption }]} numberOfLines={1}>
            {summary}
          </Text>
        </View>
      </View>
      <View style={[styles.groupDivider, { backgroundColor: F.divider }]} />
      {aggregate.meetings.map((meeting, index) => (
        <React.Fragment key={meeting.meetingId}>
          <MeetingRow
            meeting={meeting}
            occurrenceLabel={isPerson ? `${meeting.occurrenceCount} 段发言` : undefined}
            onPress={() => onOpenMeeting(meeting.navigationMeetingId)}
          />
          {index < aggregate.meetings.length - 1 ? (
            <View style={[styles.meetingDivider, { backgroundColor: F.divider }]} />
          ) : null}
        </React.Fragment>
      ))}
    </View>
  );
}

export function MeetingOrganizationScreen({ navigation }: Props) {
  const { isGuest, session } = useAuth();
  const scopeKey = isGuest ? 'guest' as ScopeKey : session ? `user:${session.user.id}` as ScopeKey : null;
  const [mode, setMode] = useState<OrganizationMode>('people');
  const [projection, setProjection] = useState<MeetingOrganizationProjection>(EMPTY_PROJECTION);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const generationRef = useRef(0);

  const load = useCallback(async () => {
    const generation = ++generationRef.current;
    if (!scopeKey) {
      setProjection(EMPTY_PROJECTION);
      setLoading(false);
      setError('当前无法读取会议分类。');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const result = await meetingOrganization.listAggregates(scopeKey, {
        includeSummaryTopics: AUTOMATIC_TOPICS_ENABLED,
      });
      if (generationRef.current === generation) setProjection(result);
    } catch (reason) {
      if (generationRef.current === generation) {
        setProjection(EMPTY_PROJECTION);
        setError(readableErrorMessage(reason, '会议分类暂时无法加载，请稍后重试。'));
      }
    } finally {
      if (generationRef.current === generation) setLoading(false);
    }
  }, [scopeKey]);

  useFocusEffect(useCallback(() => {
    void load();
    return () => { generationRef.current += 1; };
  }, [load]));

  const groups = useMemo<readonly OrganizationGroup[]>(() => (
    mode === 'people'
      ? projection.people.map(aggregate => ({ kind: 'person' as const, aggregate }))
      : projection.topics.map(aggregate => ({ kind: 'topic' as const, aggregate }))
  ), [mode, projection.people, projection.topics]);

  const renderState = () => {
    if (loading && groups.length === 0) {
      return <View style={styles.state}><ActivityIndicator size="small" color={F.primary} /></View>;
    }
    if (error) {
      return (
        <View style={styles.state} accessibilityRole="alert">
          <Text style={[styles.stateText, { color: F.textCaption }]}>{error}</Text>
          <Pressable
            onPress={() => { void load(); }}
            accessibilityRole="button"
            accessibilityLabel="重新加载会议分类"
            style={({ pressed }) => [styles.retry, pressed && { backgroundColor: F.pressedFill }]}
          >
            <Text style={[styles.retryText, { color: F.primary }]}>重试</Text>
          </Pressable>
        </View>
      );
    }
    return (
      <View style={styles.state}>
        <Ionicons
          name={mode === 'people' ? 'people-outline' : 'pricetags-outline'}
          size={44}
          color={F.iconDisabled}
        />
        <Text style={[styles.emptyText, { color: F.textCaption }]}>
          {mode === 'people' ? '暂无可归类的人物' : '暂无主题'}
        </Text>
      </View>
    );
  };

  return (
    <ScreenContainer edges={['top', 'bottom']} bg={F.backgroundBase}>
      <SettingsTitleBar title="分类查看" onBack={() => navigation.goBack()} />
      <View
        style={[styles.tabs, { backgroundColor: F.backgroundBody, borderBottomColor: F.divider }]}
        accessibilityRole="tablist"
      >
        {(['people', 'topics'] as const).map(item => {
          const selected = item === mode;
          const label = item === 'people' ? '人物' : '主题';
          return (
            <Pressable
              key={item}
              onPress={() => setMode(item)}
              accessibilityRole="tab"
              accessibilityLabel={label}
              accessibilityState={{ selected }}
              style={({ pressed }) => [
                styles.tab,
                pressed && !selected && { backgroundColor: F.pressedFill },
              ]}
            >
              <Text style={[styles.tabText, { color: selected ? F.primary : F.textCaption }]}>
                {label}
              </Text>
              {selected ? <View style={[styles.tabIndicator, { backgroundColor: F.primary }]} /> : null}
            </Pressable>
          );
        })}
      </View>
      <FlatList
        data={groups}
        keyExtractor={group => group.kind === 'person'
          ? `person:${group.aggregate.key}`
          : `topic:${group.aggregate.key}`}
        renderItem={({ item }) => (
          <OrganizationGroupCard
            group={item}
            onOpenMeeting={meetingId => navigation.navigate('Transcription', { meetingId })}
          />
        )}
        contentContainerStyle={[styles.content, groups.length === 0 && styles.emptyContent]}
        showsVerticalScrollIndicator={false}
        refreshing={loading && groups.length > 0}
        onRefresh={() => { void load(); }}
        ListEmptyComponent={renderState}
        testID="meeting-organization-list"
      />
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  tabs: {
    height: 48,
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tab: {
    flex: 1,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabText: {
    fontSize: FEISHU_FONT_SIZES.body0,
    lineHeight: 24,
    fontWeight: '400',
  },
  tabIndicator: {
    position: 'absolute',
    bottom: 0,
    width: 24,
    height: 2,
    borderRadius: 1,
  },
  content: {
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 24,
  },
  emptyContent: { flexGrow: 1 },
  group: {
    marginBottom: 12,
    borderRadius: FEISHU_RADII.l,
    overflow: 'hidden',
  },
  groupHeader: {
    minHeight: 68,
    paddingHorizontal: 16,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
  },
  groupIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  groupInitial: {
    maxWidth: 28,
    fontSize: FEISHU_FONT_SIZES.title3,
    lineHeight: 24,
    fontWeight: '500',
  },
  groupCopy: { flex: 1, minWidth: 0, marginLeft: 12 },
  groupTitleLine: { flexDirection: 'row', alignItems: 'center' },
  groupTitle: {
    flexShrink: 1,
    fontSize: FEISHU_FONT_SIZES.body0,
    lineHeight: 22,
    fontWeight: '500',
  },
  badge: {
    height: 20,
    marginLeft: 8,
    paddingHorizontal: 6,
    borderRadius: FEISHU_RADII.s,
    justifyContent: 'center',
  },
  badgeText: { fontSize: FEISHU_FONT_SIZES.caption1, lineHeight: 18 },
  groupMeta: { marginTop: 2, fontSize: FEISHU_FONT_SIZES.caption1, lineHeight: 18 },
  groupDivider: { height: StyleSheet.hairlineWidth, marginLeft: 68 },
  meetingRow: {
    minHeight: 60,
    paddingLeft: 68,
    paddingRight: 12,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
  },
  meetingCopy: { flex: 1, minWidth: 0, marginRight: 8 },
  meetingTitle: { fontSize: FEISHU_FONT_SIZES.body1, lineHeight: 20, fontWeight: '400' },
  meetingMeta: { marginTop: 2, fontSize: FEISHU_FONT_SIZES.caption1, lineHeight: 18 },
  meetingDivider: { height: StyleSheet.hairlineWidth, marginLeft: 68 },
  state: {
    flex: 1,
    minHeight: 300,
    paddingHorizontal: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stateText: { fontSize: FEISHU_FONT_SIZES.body1, lineHeight: 22, textAlign: 'center' },
  emptyText: { marginTop: 14, fontSize: FEISHU_FONT_SIZES.body1, lineHeight: 22 },
  retry: {
    minWidth: 76,
    height: 44,
    marginTop: 8,
    borderRadius: FEISHU_RADII.m,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retryText: { fontSize: FEISHU_FONT_SIZES.body0, lineHeight: 22 },
});
