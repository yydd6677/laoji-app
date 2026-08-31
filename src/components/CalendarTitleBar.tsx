import React from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Appearance, Colors as C } from '../theme/colors';
import { MotionPressable } from './MotionPressable';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

export type CalendarTitleAction = {
  key: string;
  icon: IconName;
  label: string;
  onPress: () => void;
};

export const COMMON_TEXT_TITLE_BAR_GEOMETRY = {
  height: 44,
  titleSize: 18,
  actionSize: 17,
  titleInset: 66,
  leftPaddingStart: 15,
  leftPaddingEnd: 8,
  rightPaddingStart: 9,
  rightPaddingEnd: 15,
} as const;

export function CommonTextTitleBar({
  title,
  leftText = '取消',
  rightText,
  onLeft,
  onRight,
  rightEnabled = true,
  rightTestID,
  testID,
}: {
  title: string;
  leftText?: string;
  rightText?: string;
  onLeft: () => void;
  onRight?: () => void;
  rightEnabled?: boolean;
  rightTestID?: string;
  testID?: string;
}) {
  return (
    <View style={s.commonTextBar} testID={testID}>
      <MotionPressable
        style={s.commonLeftAction}
        onPress={onLeft}
        feedback="quiet"
        pressedStyle={s.textPressed}
        accessibilityRole="button"
        accessibilityLabel={leftText}
      >
        <Text style={s.commonActionText}>{leftText}</Text>
      </MotionPressable>
      <Text
        style={s.commonTextTitle}
        numberOfLines={1}
        testID={testID ? `${testID}-title` : undefined}
      >
        {title}
      </Text>
      <MotionPressable
        testID={rightTestID}
        style={s.commonRightAction}
        onPress={onRight}
        disabled={!onRight || !rightEnabled}
        feedback="quiet"
        pressedStyle={s.textPressed}
        accessibilityRole="button"
        accessibilityLabel={rightText}
        accessibilityState={{ disabled: !onRight || !rightEnabled }}
      >
        {rightText ? (
          <Text
            style={[s.commonActionText, s.commonRightText, !rightEnabled && s.commonRightTextDisabled]}
            testID={testID ? `${testID}-right-text` : undefined}
          >
            {rightText}
          </Text>
        ) : null}
      </MotionPressable>
    </View>
  );
}

export function CalendarDetailTitleBar({
  title,
  titleOpacity,
  titleAlignment = 'center',
  titleColor = C.text,
  onBack,
  actions = [],
}: {
  title: string;
  titleOpacity?: Animated.AnimatedInterpolation<number> | Animated.Value;
  titleAlignment?: 'center' | 'leading';
  titleColor?: string;
  onBack: () => void;
  actions?: CalendarTitleAction[];
}) {
  const titleSide = Math.max(64, actions.length * 44 + 8);
  const titleInsets = titleAlignment === 'leading'
    ? { left: 44, right: actions.length * 44 + 42 }
    : { left: titleSide, right: titleSide };
  return (
    <View style={[s.bar, s.detailBar]}>
      <MotionPressable
        style={s.iconAction}
        onPress={onBack}
        feedback="quiet"
        pressedStyle={s.iconPressed}
        hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
        accessibilityRole="button"
        accessibilityLabel="返回"
      >
        <Ionicons name="chevron-back" size={22} color={C.text} />
      </MotionPressable>
      <Animated.Text
        testID="calendar-detail-collapsed-title"
        numberOfLines={1}
        style={[
          s.detailTitle,
          titleInsets,
          titleAlignment === 'leading' && s.detailTitleLeading,
          { color: titleColor },
          titleOpacity ? { opacity: titleOpacity } : null,
        ]}
      >
        {title}
      </Animated.Text>
      <View style={s.detailActions}>
        {actions.map(action => (
          <MotionPressable
            key={action.key}
            style={s.detailIconAction}
            onPress={action.onPress}
            feedback="quiet"
            pressedStyle={s.iconPressed}
            accessibilityRole="button"
            accessibilityLabel={action.label}
          >
            <Ionicons name={action.icon} size={20} color={C.text} />
          </MotionPressable>
        ))}
      </View>
    </View>
  );
}

export function CalendarEditTitleBar({
  onCancel,
  onSave,
  saveEnabled,
  saving,
  saveAccessibilityLabel,
}: {
  onCancel: () => void;
  onSave: () => void;
  saveEnabled: boolean;
  saving: boolean;
  saveAccessibilityLabel: string;
}) {
  return (
    <View style={s.bar}>
      <MotionPressable
        style={s.textAction}
        onPress={onCancel}
        feedback="quiet"
        pressedStyle={s.textPressed}
        accessibilityRole="button"
        accessibilityLabel="取消编辑"
      >
        <Text style={s.cancelText}>取消</Text>
      </MotionPressable>
      <View style={s.editorTitleSpacer} />
      <MotionPressable
        testID="event-save"
        style={[s.textAction, s.saveAction]}
        onPress={onSave}
        disabled={!saveEnabled || saving}
        feedback="quiet"
        pressedStyle={s.textPressed}
        accessibilityRole="button"
        accessibilityLabel={saveAccessibilityLabel}
        accessibilityState={{ disabled: !saveEnabled || saving }}
      >
        <Text style={[
          s.saveText,
          (!saveEnabled || saving) && s.saveTextDisabled,
        ]}>
          {saving ? '保存中' : '保存'}
        </Text>
      </MotionPressable>
    </View>
  );
}

export function CalendarTextTitleBar({
  title,
  leftText = '取消',
  rightText,
  onLeft,
  onRight,
  rightEnabled = true,
  rightTestID,
  transparent = false,
}: {
  title: string;
  leftText?: string;
  rightText?: string;
  onLeft: () => void;
  onRight?: () => void;
  rightEnabled?: boolean;
  rightTestID?: string;
  transparent?: boolean;
}) {
  return (
    <View style={[s.bar, transparent && s.transparentBar]}>
      <MotionPressable
        style={s.textAction}
        onPress={onLeft}
        feedback="quiet"
        pressedStyle={s.textPressed}
        accessibilityRole="button"
        accessibilityLabel={leftText}
      >
        <Text style={s.cancelText}>{leftText}</Text>
      </MotionPressable>
      <Text style={s.textBarTitle} numberOfLines={1}>{title}</Text>
      <MotionPressable
        testID={rightTestID}
        style={[s.textAction, s.saveAction]}
        onPress={onRight}
        disabled={!onRight || !rightEnabled}
        feedback="quiet"
        pressedStyle={s.textPressed}
        accessibilityRole="button"
        accessibilityLabel={rightText}
        accessibilityState={{ disabled: !onRight || !rightEnabled }}
      >
        {rightText ? (
          <Text style={[s.saveText, !rightEnabled && s.saveTextDisabled]}>{rightText}</Text>
        ) : null}
      </MotionPressable>
    </View>
  );
}

const s = StyleSheet.create({
  commonTextBar: {
    height: COMMON_TEXT_TITLE_BAR_GEOMETRY.height,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'transparent',
  },
  commonLeftAction: {
    minWidth: 57,
    height: COMMON_TEXT_TITLE_BAR_GEOMETRY.height,
    paddingLeft: COMMON_TEXT_TITLE_BAR_GEOMETRY.leftPaddingStart,
    paddingRight: COMMON_TEXT_TITLE_BAR_GEOMETRY.leftPaddingEnd,
    justifyContent: 'center',
  },
  commonRightAction: {
    minWidth: 58,
    height: COMMON_TEXT_TITLE_BAR_GEOMETRY.height,
    marginLeft: 'auto',
    paddingLeft: COMMON_TEXT_TITLE_BAR_GEOMETRY.rightPaddingStart,
    paddingRight: COMMON_TEXT_TITLE_BAR_GEOMETRY.rightPaddingEnd,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  commonActionText: {
    fontSize: COMMON_TEXT_TITLE_BAR_GEOMETRY.actionSize,
    lineHeight: 24,
    fontWeight: '400',
    color: C.text,
  },
  commonRightText: { color: C.primary },
  commonRightTextDisabled: { color: C.faint },
  commonTextTitle: {
    position: 'absolute',
    left: COMMON_TEXT_TITLE_BAR_GEOMETRY.titleInset,
    right: COMMON_TEXT_TITLE_BAR_GEOMETRY.titleInset,
    textAlign: 'center',
    fontSize: COMMON_TEXT_TITLE_BAR_GEOMETRY.titleSize,
    lineHeight: 25,
    fontWeight: '400',
    fontFamily: Appearance.titleFontFamily,
    letterSpacing: Appearance.titleLetterSpacing,
    color: C.text,
  },
  bar: {
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: C.body,
  },
  detailBar: { backgroundColor: 'transparent' },
  transparentBar: { backgroundColor: 'transparent' },
  iconAction: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  detailIconAction: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  iconPressed: { backgroundColor: C.pressed, borderRadius: Appearance.iconRadius },
  textPressed: { backgroundColor: C.pressed },
  detailTitle: {
    position: 'absolute',
    textAlign: 'center',
    fontSize: 17,
    lineHeight: 24,
    fontWeight: '600',
    fontFamily: Appearance.titleFontFamily,
    letterSpacing: Appearance.titleLetterSpacing,
    color: C.text,
  },
  detailTitleLeading: { textAlign: 'left', fontWeight: '400' },
  detailActions: { marginLeft: 'auto', flexDirection: 'row', alignItems: 'center' },
  textAction: { minWidth: 64, height: 44, paddingHorizontal: 16, justifyContent: 'center' },
  cancelText: { fontSize: 16, lineHeight: 22, color: C.text },
  editorTitleSpacer: { flex: 1 },
  textBarTitle: {
    position: 'absolute',
    left: 72,
    right: 72,
    textAlign: 'center',
    fontSize: 17,
    lineHeight: 24,
    fontWeight: '600',
    fontFamily: Appearance.titleFontFamily,
    letterSpacing: Appearance.titleLetterSpacing,
    color: C.text,
  },
  saveAction: { alignItems: 'flex-end' },
  saveText: { fontSize: 16, lineHeight: 22, fontWeight: '500', color: C.primary },
  saveTextDisabled: { color: C.faint },
});
