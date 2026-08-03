import React from 'react';
import {
  FlatList,
  Keyboard,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Meeting } from '../types';
import type { MeetingSearchResult } from '../data/repositories';
import { Colors as C } from '../theme/colors';
import { CalendarSlidePage } from './CalendarSlidePage';
import { MeetingListItem } from './MeetingListItem';
import { meetingMatchesSearchMetadata } from '../services/meetingSearchQuery';

const SEARCH_RESULT_LIMIT = 60;

function sourceLabel(sourceKind: MeetingSearchResult['sourceKind']): string {
  switch (sourceKind) {
    case 'title': return '标题';
    case 'tag': return '标签';
    case 'manual_note': return '我的笔记';
    case 'transcript': return '文字记录';
    case 'summary': return '整理结果';
    case 'action': return '待办';
    default: return '会议内容';
  }
}

function MeetingSearchResultItem({
  result,
  onPress,
  onLongPress,
}: {
  result: MeetingSearchResult;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const label = sourceLabel(result.sourceKind);
  return (
    <TouchableOpacity
      testID={`meeting-search-result-${result.resultId}`}
      style={s.resultRow}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={320}
      activeOpacity={0.65}
      accessibilityRole="button"
      accessibilityLabel={`${result.meetingTitle}，${label}`}
      accessibilityHint="打开会议详情，长按显示更多操作"
    >
      <View style={s.resultHeader}>
        <Text style={s.resultTitle} numberOfLines={1}>{result.meetingTitle}</Text>
        <Text style={s.resultSource} numberOfLines={1}>{label}</Text>
      </View>
      <Text style={s.resultSnippet} numberOfLines={2}>{result.snippet}</Text>
    </TouchableOpacity>
  );
}

export function MeetingSearchPage({
  visible,
  meetings,
  onClose,
  onOpenMeeting,
  onOpenMenu,
  searchMeetingContent,
}: {
  visible: boolean;
  meetings: Meeting[];
  onClose: () => void;
  onOpenMeeting: (meetingId: string) => void;
  onOpenMenu: (meetingId: string) => void;
  searchMeetingContent?: (query: string, limit?: number) => Promise<readonly MeetingSearchResult[]>;
}) {
  const [query, setQuery] = React.useState('');
  const [indexedResults, setIndexedResults] = React.useState<readonly MeetingSearchResult[]>([]);
  const [isSearching, setIsSearching] = React.useState(false);
  const requestRef = React.useRef(0);

  React.useEffect(() => {
    if (!visible) {
      requestRef.current += 1;
      setQuery('');
      setIndexedResults([]);
      setIsSearching(false);
    }
  }, [visible]);

  React.useEffect(() => {
    const normalized = query.trim();
    if (!visible || !normalized || !searchMeetingContent) {
      requestRef.current += 1;
      setIndexedResults([]);
      setIsSearching(false);
      return undefined;
    }
    const requestId = ++requestRef.current;
    setIsSearching(true);
    const timer = setTimeout(() => {
      void searchMeetingContent(normalized, SEARCH_RESULT_LIMIT)
        .then(results => {
          if (requestRef.current !== requestId) return;
          setIndexedResults(results);
          setIsSearching(false);
        })
        .catch(() => {
          if (requestRef.current !== requestId) return;
          // The local index is an enhancement. The metadata fallback below
          // remains usable when an older database has not been migrated yet.
          setIndexedResults([]);
          setIsSearching(false);
        });
    }, 120);
    return () => clearTimeout(timer);
  }, [query, searchMeetingContent, visible]);

  const metadataResults = React.useMemo(
    () => meetings.filter(meeting => meetingMatchesSearchMetadata(meeting, query)),
    [meetings, query],
  );
  const visibleIndexedResults = React.useMemo(() => {
    const visibleMeetingIds = new Set(meetings.map(meeting => meeting.id));
    return indexedResults.filter(result => visibleMeetingIds.has(result.navigationMeetingId));
  }, [indexedResults, meetings]);
  const useIndexedResults = query.trim().length > 0 && visibleIndexedResults.length > 0;
  const listData: readonly (Meeting | MeetingSearchResult)[] = React.useMemo(() => {
    if (!useIndexedResults) return metadataResults;
    // The FTS index covers transcript/summary/notes, while the legacy list
    // carries useful metadata (location, status, duration and participants)
    // that is intentionally not duplicated into every index row. Keep the
    // metadata-only matches instead of letting one indexed hit hide them.
    const indexedMeetingIds = new Set(
      visibleIndexedResults.map(result => result.navigationMeetingId),
    );
    const metadataOnly = metadataResults
      .filter(meeting => !indexedMeetingIds.has(meeting.id))
      .slice(0, Math.max(0, SEARCH_RESULT_LIMIT - visibleIndexedResults.length));
    return [...visibleIndexedResults, ...metadataOnly];
  }, [metadataResults, useIndexedResults, visibleIndexedResults]);
  const resultCount = listData.length;

  return (
    <CalendarSlidePage visible={visible} testID="meeting-search-page" onRequestClose={onClose}>
      <View style={s.searchHeader}>
        <TouchableOpacity
          style={s.backAction}
          onPress={onClose}
          activeOpacity={0.65}
          accessibilityRole="button"
          accessibilityLabel="关闭会议搜索"
        >
          <Ionicons name="chevron-back" size={22} color={C.text} />
        </TouchableOpacity>
        <View style={s.searchField}>
          <Ionicons name="search-outline" size={18} color={C.faint} />
          <TextInput
            testID="meeting-search-input"
            style={s.searchInput}
            value={query}
            onChangeText={setQuery}
            placeholder="搜索会议记录"
            placeholderTextColor={C.faint}
            autoFocus
            returnKeyType="search"
            clearButtonMode="never"
          />
          {query ? (
            <TouchableOpacity
              style={s.clearAction}
              onPress={() => setQuery('')}
              accessibilityRole="button"
              accessibilityLabel="清空会议搜索"
            >
              <Ionicons name="close-circle" size={18} color={C.faint} />
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
      <FlatList<Meeting | MeetingSearchResult>
        data={listData}
        keyExtractor={item => 'resultId' in item ? item.resultId : item.id}
        renderItem={({ item }) => 'resultId' in item ? (
          <MeetingSearchResultItem
            result={item}
            onPress={() => onOpenMeeting(item.navigationMeetingId)}
            onLongPress={() => onOpenMenu(item.navigationMeetingId)}
          />
        ) : (
          <MeetingListItem
            meeting={item}
            onPress={() => onOpenMeeting(item.id)}
            onLongPress={() => onOpenMenu(item.id)}
          />
        )}
        style={s.list}
        contentContainerStyle={[s.content, resultCount === 0 && s.emptyContent]}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        onScrollBeginDrag={Keyboard.dismiss}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={<Text style={s.emptyText}>{isSearching ? '正在搜索…' : '无相关结果'}</Text>}
      />
    </CalendarSlidePage>
  );
}

const s = StyleSheet.create({
  searchHeader: {
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: C.appBg,
  },
  backAction: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  searchField: {
    flex: 1,
    minWidth: 0,
    height: 34,
    marginRight: 12,
    paddingLeft: 12,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: C.inputBg,
    borderRadius: 6,
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    height: 34,
    paddingHorizontal: 6,
    paddingVertical: 0,
    fontSize: 15,
    color: C.text,
  },
  clearAction: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  list: { flex: 1, backgroundColor: C.appBg },
  content: { paddingTop: 12, paddingBottom: 24 },
  emptyContent: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 0 },
  emptyText: { fontSize: 14, lineHeight: 20, color: C.sub },
  resultRow: {
    minHeight: 76,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.divider,
  },
  resultHeader: { flexDirection: 'row', alignItems: 'center', minWidth: 0 },
  resultTitle: { flex: 1, minWidth: 0, fontSize: 16, lineHeight: 22, color: C.text },
  resultSource: {
    flexShrink: 0,
    marginLeft: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: C.primaryLight,
    color: C.primary,
    fontSize: 12,
    lineHeight: 16,
  },
  resultSnippet: { marginTop: 4, fontSize: 14, lineHeight: 20, color: C.sub },
});
