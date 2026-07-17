import {
  getNativeBottomBarHeight,
  NATIVE_BOTTOM_BAR_CONTENT_HEIGHT,
} from '../src/navigation/nativeBottomBarGeometry';
import fs from 'fs';
import path from 'path';

describe('native Android tab bar insets [UI-SHELL-001/UI-MOTION-001]', () => {
  it('keeps the source-mapped 65dp controls above gesture and three-button navigation', () => {
    expect(NATIVE_BOTTOM_BAR_CONTENT_HEIGHT).toBe(65);
    expect(getNativeBottomBarHeight(0)).toBe(NATIVE_BOTTOM_BAR_CONTENT_HEIGHT);
    expect(getNativeBottomBarHeight(34)).toBe(NATIVE_BOTTOM_BAR_CONTENT_HEIGHT + 34);
    expect(getNativeBottomBarHeight(-8)).toBe(NATIVE_BOTTOM_BAR_CONTENT_HEIGHT);
  });

  it('mounts exactly one exported native tab root at a time', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../src/navigation/MainTabs.android.tsx'), 'utf8');
    expect(source).not.toContain('createBottomTabNavigator');
    expect(source).not.toContain('<View');
    expect(source).not.toContain('LaojiNativeMainContainer');
    expect(source).not.toContain('LaojiNativeBottomBar');
    expect(source).toContain("selectedTab === 'Schedule' ? (");
    expect(source).toContain('<ScheduleScreen navigation={navigation} onTabPress={handleTabPress} />');
    expect(source).toContain('<MeetingListScreen navigation={navigation} onTabPress={handleTabPress} />');
  });

  it('lets each exported tab root own its native bar and status inset', () => {
    const calendarPath = '../modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/calendar/CalendarHostView.kt';
    const minutesPath = '../modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/minutes/LaojiMinutesView.kt';
    for (const relativePath of [calendarPath, minutesPath]) {
      const source = fs.readFileSync(path.resolve(__dirname, relativePath), 'utf8');
      expect(source).toContain('LaojiNativeBottomBarView(context, appContext)');
      expect(source).toContain('setBridgeEventsEnabled(false)');
      expect(source).toContain('addView(bottomBar');
    }
    const calendarSource = fs.readFileSync(path.resolve(__dirname, calendarPath), 'utf8');
    const minutesSource = fs.readFileSync(path.resolve(__dirname, minutesPath), 'utf8');
    expect(calendarSource).toContain('installStatusBarInsetPadding()');
    expect(minutesSource).toContain(
      'installStatusBarInsetPadding { surfaceName == MinutesSurface.LIST.wireName }',
    );
    expect(minutesSource).toContain(
      'bottomBar.visibility = if (value == MinutesSurface.LIST.wireName) View.VISIBLE else View.GONE',
    );
    const insetSource = fs.readFileSync(
      path.resolve(__dirname, '../modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/ui/NativeSystemInsets.kt'),
      'utf8',
    );
    expect(insetSource).toContain('if (isAttachedToWindow)');
    expect(insetSource).toContain('addOnAttachStateChangeListener');
    expect(insetSource).toContain('view.requestApplyInsets()');
    const bottomBarSource = fs.readFileSync(
      path.resolve(__dirname, '../modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/ui/NativeBottomBarView.kt'),
      'utf8',
    );
    expect(bottomBarSource).toContain('requestInsetsWhenAttached()');
  });

  it('mounts the calendar native surface directly without a flattenable React wrapper', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../src/screens/ScheduleScreen.android.tsx'), 'utf8');
    expect(source).toContain('<LaojiCalendarView');
    expect(source).not.toContain('<ScreenContainer');
    expect(source).not.toContain('collapsableChildren');
  });

  it('mounts the meeting list surface directly without a flattenable React wrapper', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../src/screens/MeetingListScreen.android.tsx'), 'utf8');
    expect(source).toContain('<LaojiMinutesView');
    expect(source).not.toContain('<ScreenContainer');
    expect(source).not.toContain('collapsableChildren');
  });
});
