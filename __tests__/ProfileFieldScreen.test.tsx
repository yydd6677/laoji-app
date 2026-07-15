import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import {
  PROFILE_FIELD_GEOMETRY,
  PROFILE_FIELD_SCREEN_OPTIONS,
  ProfileFieldScreen,
} from '../src/screens/ProfileFieldScreen';
import { COMMON_TEXT_TITLE_BAR_GEOMETRY } from '../src/components/CalendarTitleBar';
import { Colors as C } from '../src/theme/colors';
import { useAuth } from '../src/store/AuthStore';

const mockShowDialog = jest.fn();

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('../src/components/ScreenContainer', () => ({ ScreenContainer: 'ScreenContainer' }));
jest.mock('../src/store/AuthStore', () => ({ useAuth: jest.fn() }));
jest.mock('../src/components/AppDialog', () => ({
  useAppDialog: () => ({ showDialog: mockShowDialog }),
}));

const profile = {
  nickname: '老记用户',
  email: 'user@example.com',
  phone: '13800138000',
  avatarInitial: '',
  avatarInitialManual: false,
  avatarColors: ['#5083FB', '#1456F0'] as [string, string],
  avatarUrl: null,
  avatarLocalUri: null,
};

describe('ProfileFieldScreen source-aligned editing flow', () => {
  const updateProfile = jest.fn();
  const goBack = jest.fn();
  const navigation = { goBack } as unknown as React.ComponentProps<typeof ProfileFieldScreen>['navigation'];

  beforeEach(() => {
    jest.clearAllMocks();
    updateProfile.mockResolvedValue(undefined);
    (useAuth as jest.Mock).mockReturnValue({ profile, updateProfile });
  });

  function route(field: 'nickname' | 'email' | 'phone') {
    return {
      key: `profile-${field}`,
      name: 'ProfileField' as const,
      params: { field },
    } as React.ComponentProps<typeof ProfileFieldScreen>['route'];
  }

  it('uses the source text titlebar and name input geometry', async () => {
    const view = await render(<ProfileFieldScreen navigation={navigation} route={route('nickname')} />);

    expect(view.getByText('修改昵称')).toBeTruthy();
    expect(view.getByLabelText('取消')).toBeTruthy();
    expect(view.getByLabelText('保存')).toBeTruthy();
    expect(view.getByLabelText('保存').props.accessibilityState).toEqual({ disabled: false });
    expect(PROFILE_FIELD_SCREEN_OPTIONS).toEqual({ animation: 'slide_from_bottom' });
    expect(COMMON_TEXT_TITLE_BAR_GEOMETRY).toEqual(expect.objectContaining({
      height: 44,
      titleSize: 18,
      actionSize: 17,
      leftPaddingStart: 15,
      rightPaddingEnd: 15,
    }));
    expect(StyleSheet.flatten(view.getByTestId('profile-field-titlebar').props.style)).toEqual(
      expect.objectContaining({ height: 44 }),
    );
    expect(StyleSheet.flatten(view.getByTestId('profile-field-titlebar-title').props.style)).toEqual(
      expect.objectContaining({ fontSize: 18, fontWeight: '400', left: 66, right: 66 }),
    );
    expect(view.getByTestId('profile-field-input').props.value).toBe('老记用户');
    expect(StyleSheet.flatten(view.getByTestId('profile-field-input-group').props.style)).toEqual(
      expect.objectContaining({
        height: PROFILE_FIELD_GEOMETRY.inputHeight,
        marginHorizontal: 16,
        marginTop: 16,
        borderRadius: 6,
        borderColor: C.border,
      }),
    );
    await fireEvent(view.getByTestId('profile-field-input'), 'focus');
    expect(StyleSheet.flatten(view.getByTestId('profile-field-input-group').props.style).borderColor).toBe(C.primary);

    await fireEvent.press(view.getByLabelText('取消'));
    expect(goBack).toHaveBeenCalledTimes(1);
  });

  it('saves one changed field and returns to the profile list', async () => {
    const view = await render(<ProfileFieldScreen navigation={navigation} route={route('nickname')} />);
    await fireEvent.changeText(view.getByTestId('profile-field-input'), '新的昵称');
    await fireEvent.press(view.getByLabelText('保存'));

    await waitFor(() => expect(updateProfile).toHaveBeenCalledWith(expect.objectContaining({
      nickname: '新的昵称',
      email: 'user@example.com',
      phone: '13800138000',
    })));
    expect(goBack).toHaveBeenCalledTimes(1);
  });

  it('keeps invalid email on the editor page and shows the custom error', async () => {
    const view = await render(<ProfileFieldScreen navigation={navigation} route={route('email')} />);
    await fireEvent.changeText(view.getByTestId('profile-field-input'), 'not-an-email');
    await fireEvent.press(view.getByLabelText('保存'));

    expect(mockShowDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: '邮箱格式不正确',
      tone: 'warning',
    }));
    expect(updateProfile).not.toHaveBeenCalled();
    expect(goBack).not.toHaveBeenCalled();
  });

  it('reserves the clear action and allows optional fields to be removed', async () => {
    const view = await render(<ProfileFieldScreen navigation={navigation} route={route('phone')} />);
    expect(view.getByPlaceholderText('请输入手机号或固定电话')).toBeTruthy();
    expect(view.getByText('请输入手机号或固定电话，固定电话请添加区号')).toBeTruthy();
    expect(StyleSheet.flatten(view.getByTestId('profile-field-input-group').props.style).marginTop).toBe(12);
    expect(view.getByTestId('profile-field-clear-icon').props.size).toBe(16);
    await fireEvent.press(view.getByLabelText('清空输入'));
    expect(view.getByTestId('profile-field-input').props.value).toBe('');
    await fireEvent.press(view.getByLabelText('保存'));

    await waitFor(() => expect(updateProfile).toHaveBeenCalledWith(expect.objectContaining({ phone: '' })));
  });
});
