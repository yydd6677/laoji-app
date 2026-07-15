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
import { Colors as C } from '../theme/colors';
import { CalendarSlidePage } from './CalendarSlidePage';
import { MeetingListItem } from './MeetingListItem';

function meetingMatches(meeting: Meeting, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [
    meeting.title,
    meeting.date,
    meeting.time,
    meeting.duration,
    meeting.description,
    meeting.status,
    ...meeting.tags.map(tag => tag.label),
  ].some(value => value?.toLowerCase().includes(normalized));
}

export function MeetingSearchPage({
  visible,
  meetings,
  onClose,
  onOpenMeeting,
  onOpenMenu,
}: {
  visible: boolean;
  meetings: Meeting[];
  onClose: () => void;
  onOpenMeeting: (meetingId: string) => void;
  onOpenMenu: (meetingId: string) => void;
}) {
  const [query, setQuery] = React.useState('');

  React.useEffect(() => {
    if (!visible) setQuery('');
  }, [visible]);

  const results = React.useMemo(
    () => meetings.filter(meeting => meetingMatches(meeting, query)),
    [meetings, query],
  );

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
      <FlatList
        data={results}
        keyExtractor={meeting => meeting.id}
        renderItem={({ item }) => (
          <MeetingListItem
            meeting={item}
            onPress={() => onOpenMeeting(item.id)}
            onLongPress={() => onOpenMenu(item.id)}
          />
        )}
        style={s.list}
        contentContainerStyle={[s.content, results.length === 0 && s.emptyContent]}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        onScrollBeginDrag={Keyboard.dismiss}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={<Text style={s.emptyText}>无相关结果</Text>}
      />
    </CalendarSlidePage>
  );
}

const s = StyleSheet.create({
  searchHeader: {
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F8F9FA',
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
  list: { flex: 1, backgroundColor: '#F8F9FA' },
  content: { paddingTop: 12, paddingBottom: 24 },
  emptyContent: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 0 },
  emptyText: { fontSize: 14, lineHeight: 20, color: C.sub },
});
