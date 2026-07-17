import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { ProfileScreen } from '../src/screens/ProfileScreen';
import { MeetingListScreen } from '../src/screens/MeetingListScreen';
import { useEvents } from '../src/store/EventsStore';
import { useMeetings } from '../src/store/MeetingsStore';
import { useAuth } from '../src/store/AuthStore';

jest.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('expo-image-picker', () => ({
  MediaTypeOptions: { Images: 'images' },
  launchImageLibraryAsync: jest.fn(),
  requestMediaLibraryPermissionsAsync: jest.fn(),
}));
jest.mock('../src/components/Common', () => ({
  Avatar: 'Avatar',
  BackHeader: ({ title, right }: { title: string; right?: React.ReactNode }) => {
    const ReactNative = require('react-native');
    return <><ReactNative.Text>{title}</ReactNative.Text>{right}</>;
  },
  Tag: 'Tag',
  Waveform: 'Waveform',
}));
jest.mock('../src/components/BottomTabBar', () => ({
  BottomTabBar: 'BottomTabBar',
  BOTTOM_TAB_BAR_GEOMETRY: { sceneContentClearance: 72 },
}));
jest.mock('../src/store/EventsStore', () => ({ useEvents: jest.fn() }));
jest.mock('../src/store/MeetingsStore', () => ({ useMeetings: jest.fn() }));
jest.mock('../src/store/AuthStore', () => ({ useAuth: jest.fn() }));
jest.mock('../src/components/AppDialog', () => ({
  useAppDialog: () => ({ showDialog: jest.fn() }),
}));

const longNickname = '这是一个需要在窄屏中稳定省略的超长用户昵称';
const longEmail = 'very-long-account-name-for-layout-check@example-subdomain.test';
const profile = {
  nickname: longNickname,
  email: longEmail,
  phone: '13800138000',
  avatarUrl: '',
  avatarLocalUri: '',
};

describe('responsive profile and meeting states', () => {
  const updateProfile = jest.fn();
  const uploadAvatar = jest.fn();
  const deleteAvatar = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (useEvents as jest.Mock).mockReturnValue({ events: [] });
    (useMeetings as jest.Mock).mockReturnValue({ meetings: [] });
    updateProfile.mockResolvedValue(undefined);
    uploadAvatar.mockResolvedValue(undefined);
    deleteAvatar.mockResolvedValue(undefined);
    (useAuth as jest.Mock).mockReturnValue({
      profile,
      isGuest: false,
      updateProfile,
      uploadAvatar,
      deleteAvatar,
    });
  });

  it('exposes each profile field in the UI-TOKENS-001 full-width settings surface', async () => {
    const navigation = { navigate: jest.fn() } as unknown as React.ComponentProps<typeof ProfileScreen>['navigation'];
    await render(<ProfileScreen navigation={navigation} />);

    expect(screen.getByLabelText('打开设置')).toBeTruthy();
    expect(screen.getByTestId('profile-settings-icon').props.size).toBe(24);
    expect(StyleSheet.flatten(screen.getByLabelText('打开设置').props.style)).toEqual(
      expect.objectContaining({ width: 48, height: 44 }),
    );
    expect(screen.getByLabelText('更换头像')).toBeTruthy();
    expect(screen.getByLabelText('编辑昵称')).toBeTruthy();
    expect(screen.getByLabelText('编辑邮箱')).toBeTruthy();
    expect(screen.getByLabelText('编辑手机号')).toBeTruthy();
    expect(screen.queryByTestId('profile-nickname-input')).toBeNull();
    expect(screen.queryByTestId('profile-save')).toBeNull();
    expect(screen.queryByLabelText('编辑资料')).toBeNull();

    expect(StyleSheet.flatten(screen.getByTestId('profile-settings-group').props.style))
      .toEqual(expect.objectContaining({ marginHorizontal: 0, marginTop: 12, borderRadius: 0 }));
    expect(StyleSheet.flatten(screen.getByTestId('profile-avatar-picker').props.style).minHeight).toBe(64);
    expect(StyleSheet.flatten(screen.getByTestId('profile-nickname-row').props.style).minHeight).toBe(52);

    expect(screen.queryByTestId('profile-identity')).toBeNull();
    expect(screen.queryByText('本月日程')).toBeNull();
    expect(screen.queryByText('会议记录')).toBeNull();
    expect(screen.queryByText('已登录')).toBeNull();

    expect(screen.queryByText('邮箱设置')).toBeNull();
    expect(screen.queryByText('手机号设置')).toBeNull();
    expect(screen.queryByLabelText('隐私与数据')).toBeNull();
    expect(screen.queryByLabelText('使用帮助')).toBeNull();
    expect(screen.queryByLabelText('使用指南')).toBeNull();
    expect(screen.queryByLabelText('版本信息')).toBeNull();

    await fireEvent.press(screen.getByLabelText('打开设置'));
    expect(navigation.navigate).toHaveBeenCalledWith('Privacy');
  });

  it('opens a dedicated source-style editor for each profile value', async () => {
    const navigation = { navigate: jest.fn() } as unknown as React.ComponentProps<typeof ProfileScreen>['navigation'];
    await render(<ProfileScreen navigation={navigation} />);

    await fireEvent.press(screen.getByLabelText('编辑昵称'));
    await fireEvent.press(screen.getByLabelText('编辑邮箱'));
    await fireEvent.press(screen.getByLabelText('编辑手机号'));

    expect(navigation.navigate).toHaveBeenNthCalledWith(1, 'ProfileField', { field: 'nickname' });
    expect(navigation.navigate).toHaveBeenNthCalledWith(2, 'ProfileField', { field: 'email' });
    expect(navigation.navigate).toHaveBeenNthCalledWith(3, 'ProfileField', { field: 'phone' });
    expect(updateProfile).not.toHaveBeenCalled();
  });

  it('uses neutral status copy for a guest profile', async () => {
    (useAuth as jest.Mock).mockReturnValue({
      profile: { ...profile, email: '', phone: '' },
      isGuest: true,
      updateProfile,
      uploadAvatar,
      deleteAvatar,
    });
    const navigation = { navigate: jest.fn() } as unknown as React.ComponentProps<typeof ProfileScreen>['navigation'];
    await render(<ProfileScreen navigation={navigation} />);

    expect(screen.getByText('未登录账号')).toBeTruthy();
    expect(screen.queryByText('资料仅保存在本机')).toBeNull();
    expect(screen.queryByText('资料和日程仅保存在本机')).toBeNull();
  });

  it('keeps a cached meeting sync error in the source notice geometry', async () => {
    const refreshMeetings = jest.fn();
    (useMeetings as jest.Mock).mockReturnValue({
      meetings: [{
        id: 'meeting-1',
        title: '缓存会议',
        date: '2026年7月11日',
        time: '10:00',
        duration: '12:00',
        tags: [],
        bars: [1, 2, 3],
      }],
      loading: false,
      error: 'network unavailable',
      deleteMeeting: jest.fn(),
      refreshMeetings,
    });
    const navigation = { navigate: jest.fn() } as unknown as React.ComponentProps<typeof MeetingListScreen>['navigation'];
    await render(<MeetingListScreen navigation={navigation} />);

    expect(screen.getByText('缓存会议')).toBeTruthy();
    expect(screen.getByLabelText('搜索会议记录')).toBeTruthy();
    expect(screen.getByLabelText('更多会议操作')).toBeTruthy();
    expect(screen.getByLabelText('缓存会议').props.accessibilityHint).toBe('打开会议详情，长按显示更多操作');
    const banner = screen.getByTestId('meeting-cache-error');
    expect(StyleSheet.flatten(banner.props.style)).toEqual(expect.objectContaining({
      height: 44,
    }));

    await fireEvent.press(screen.getByLabelText('更多会议操作'));
    expect(screen.getByLabelText('管理讲话人')).toBeTruthy();
    expect(screen.getByLabelText('个人资料')).toBeTruthy();

    await fireEvent.press(screen.getByLabelText('重新同步会议记录'));
    expect(refreshMeetings).toHaveBeenCalledTimes(1);
  });

  it('retains the full retry state when no cached meetings exist', async () => {
    (useMeetings as jest.Mock).mockReturnValue({
      meetings: [],
      loading: false,
      error: 'network unavailable',
      deleteMeeting: jest.fn(),
      refreshMeetings: jest.fn(),
    });
    const navigation = { navigate: jest.fn() } as unknown as React.ComponentProps<typeof MeetingListScreen>['navigation'];
    await render(<MeetingListScreen navigation={navigation} />);

    expect(screen.queryByTestId('meeting-cache-error')).toBeNull();
    expect(screen.getByText('会议服务暂时不可用')).toBeTruthy();
  });
});
