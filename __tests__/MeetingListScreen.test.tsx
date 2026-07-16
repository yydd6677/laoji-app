import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { MeetingListScreen } from '../src/screens/MeetingListScreen';
import { useMeetings } from '../src/store/MeetingsStore';
import { MEETING_LIST_ITEM_GEOMETRY } from '../src/components/MeetingListItem';
import { BOTTOM_TAB_BAR_GEOMETRY } from '../src/components/BottomTabBar';

const mockShowDialog = jest.fn();

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('../src/components/ScreenContainer', () => ({
  ScreenContainer: ({ children }: { children: React.ReactNode }) => <View>{children}</View>,
}));
jest.mock('../src/components/CalendarSlidePage', () => ({
  CalendarSlidePage: ({ visible, children, testID }: { visible: boolean; children: React.ReactNode; testID?: string }) => (
    visible ? <View testID={testID}>{children}</View> : null
  ),
}));
jest.mock('../src/components/AppActionSheet', () => ({
  AppActionSheet: ({ visible, title, items, onClose }: {
    visible: boolean;
    title: string;
    items: { key: string; label: string; onPress: () => void }[];
    onClose: () => void;
  }) => visible ? (
    <View accessibilityLabel={title}>
      {items.map(item => (
        <TouchableOpacity
          key={item.key}
          accessibilityLabel={item.label}
          onPress={() => {
            onClose();
            item.onPress();
          }}
        >
          <Text>{item.label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  ) : null,
}));
jest.mock('../src/components/AppDialog', () => ({
  useAppDialog: () => ({ showDialog: mockShowDialog }),
}));
jest.mock('../src/store/MeetingsStore', () => ({
  MeetingDeletionCleanupError: class MeetingDeletionCleanupError extends Error {},
  useMeetings: jest.fn(),
}));

describe('MeetingListScreen Feishu Minutes structure', () => {
  const navigate = jest.fn();
  const navigation = { navigate } as unknown as React.ComponentProps<typeof MeetingListScreen>['navigation'];
  const meetings = [
    {
      id: 'meeting-1',
      title: '产品周会',
      date: '2026年7月14日',
      time: '10:00',
      duration: '35:20',
      tags: [{ label: '项目', color: '#1456F0' }],
      bars: [1, 2, 3],
    },
    {
      id: 'meeting-2',
      title: '季度复盘',
      date: '2026年7月12日',
      time: '15:30',
      duration: '48:05',
      tags: [],
      bars: [3, 2, 1],
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    (useMeetings as jest.Mock).mockReturnValue({
      meetings,
      loading: false,
      error: null,
      deleteMeeting: jest.fn(),
      refreshMeetings: jest.fn(),
    });
  });

  it('uses the source title bar and compact single-column record geometry', async () => {
    await render(<MeetingListScreen navigation={navigation} />);

    expect(screen.getByTestId('meeting-home-titlebar')).toHaveStyle({
      height: 44,
      backgroundColor: '#F8F9FA',
    });
    expect(screen.getByText('会议记录')).toHaveStyle({ fontSize: 20, fontWeight: '700' });
    expect(screen.getByTestId('meeting-list-item-meeting-1')).toHaveStyle({
      minHeight: MEETING_LIST_ITEM_GEOMETRY.minHeight,
      paddingTop: MEETING_LIST_ITEM_GEOMETRY.paddingTop,
      paddingHorizontal: MEETING_LIST_ITEM_GEOMETRY.paddingHorizontal,
      paddingBottom: MEETING_LIST_ITEM_GEOMETRY.paddingBottom,
    });
    expect(screen.getByText('产品周会')).toHaveStyle({ fontSize: 16, fontWeight: '600' });
    expect(screen.getByText('2026年7月14日 10:00')).toHaveStyle({ fontSize: 14 });
    expect(screen.queryByText('35:20')).toBeNull();
    expect(screen.queryByTestId('waveform')).toBeNull();
    expect(StyleSheet.flatten(screen.getByTestId('meeting-home-list').props.style)).toEqual(expect.objectContaining({
      backgroundColor: '#F8F9FA',
    }));
    expect(screen.queryByTestId('bottom-tab-bar')).toBeNull();
    expect(StyleSheet.flatten(screen.getByTestId('meeting-home-list').props.contentContainerStyle))
      .toEqual(expect.objectContaining({
        paddingBottom: BOTTOM_TAB_BAR_GEOMETRY.sceneContentClearance,
      }));
    expect(BOTTOM_TAB_BAR_GEOMETRY.sceneContentClearance).toBeGreaterThan(
      BOTTOM_TAB_BAR_GEOMETRY.micDiameter + BOTTOM_TAB_BAR_GEOMETRY.sceneActionBottom,
    );
  });

  it('replaces ordinary metadata with the current recording state', async () => {
    (useMeetings as jest.Mock).mockReturnValue({
      meetings: [{ ...meetings[0], status: 'recording' }],
      loading: false,
      error: null,
      deleteMeeting: jest.fn(),
      refreshMeetings: jest.fn(),
    });

    await render(<MeetingListScreen navigation={navigation} />);

    expect(screen.getByText('录音中')).toHaveStyle({ color: '#E22E28' });
    expect(screen.queryByText('2026年7月14日 10:00')).toBeNull();
  });

  it('opens an independent search page and filters all meeting metadata', async () => {
    await render(<MeetingListScreen navigation={navigation} />);

    await fireEvent.press(screen.getByLabelText('搜索会议记录'));
    const page = screen.getByTestId('meeting-search-page');
    const search = within(page);
    await fireEvent.changeText(search.getByTestId('meeting-search-input'), '复盘');

    await waitFor(() => {
      expect(search.getByText('季度复盘')).toBeTruthy();
      expect(search.queryByText('产品周会')).toBeNull();
    });

    await fireEvent.press(search.getByText('季度复盘'));
    expect(navigate).toHaveBeenCalledWith('Transcription', { meetingId: 'meeting-2' });
  });

  it('keeps app utilities in the source more menu and item actions on long press', async () => {
    await render(<MeetingListScreen navigation={navigation} />);

    await fireEvent.press(screen.getByLabelText('更多会议操作'));
    await fireEvent.press(screen.getByLabelText('管理讲话人'));
    expect(navigate).toHaveBeenCalledWith('SpeakerManager');

    await fireEvent(screen.getByTestId('meeting-list-item-meeting-1'), 'longPress');
    await waitFor(() => expect(screen.getByLabelText('查看详情')).toBeTruthy());
    expect(screen.getByLabelText('重命名')).toBeTruthy();
    expect(screen.getByLabelText('删除')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('删除'));
    expect(mockShowDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: '删除会议',
      tone: 'danger',
    }));
  });

  it('opens the source rename action with the title field focused', async () => {
    await render(<MeetingListScreen navigation={navigation} />);

    await fireEvent(screen.getByTestId('meeting-list-item-meeting-1'), 'longPress');
    await fireEvent.press(screen.getByLabelText('重命名'));

    expect(navigate).toHaveBeenCalledWith('Transcription', {
      meetingId: 'meeting-1',
      focus: 'title',
    });
  });
});
