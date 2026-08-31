import React from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { CalendarSlidePage } from './CalendarSlidePage';
import { CalendarDetailTitleBar, CalendarTextTitleBar } from './CalendarTitleBar';
import { CalendarSwitch } from './CalendarSwitch';
import { useAppDialog } from './AppDialog';
import { Colors as C } from '../theme/colors';

export type RepeatChoice = {
  key: string;
  label: string;
};

export function RepeatSelectionPage({
  visible,
  selectedKey,
  options,
  onSelect,
  onClose,
}: {
  visible: boolean;
  selectedKey: string;
  options: RepeatChoice[];
  onSelect: (key: string) => void;
  onClose: () => void;
}) {
  return (
    <CalendarSlidePage
      visible={visible}
      direction="vertical"
      testID="event-repeat-page"
      onRequestClose={onClose}
    >
      <CalendarDetailTitleBar title="选择重复" onBack={onClose} />
      <ScrollView style={s.page} contentContainerStyle={s.repeatList}>
        {options.map(option => (
          <TouchableOpacity
            key={option.key}
            testID={`event-repeat-option-${option.key}`}
            style={s.repeatRow}
            onPress={() => {
              onSelect(option.key);
              onClose();
            }}
            activeOpacity={0.65}
            accessibilityRole="button"
            accessibilityState={{ selected: option.key === selectedKey }}
            accessibilityLabel={option.label}
          >
            <Text
              testID={`event-repeat-option-${option.key}-label`}
              style={[s.rowText, option.key === selectedKey && s.selectedText]}
            >
              {option.label}
            </Text>
            {option.key === selectedKey ? (
              <Ionicons name="checkmark" size={24} color={C.primary} />
            ) : null}
          </TouchableOpacity>
        ))}
      </ScrollView>
    </CalendarSlidePage>
  );
}

export type ReminderChoice = {
  key: string;
  label: string;
  value: number;
};

export function ReminderSelectionPage({
  visible,
  value,
  defaultValue,
  options,
  disabled,
  onDone,
  onClose,
}: {
  visible: boolean;
  value: number | null;
  defaultValue: number;
  options: ReminderChoice[];
  disabled: boolean;
  onDone: (value: number | null) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = React.useState<number | null>(value);

  React.useEffect(() => {
    if (visible) setDraft(value);
  }, [value, visible]);

  const enabled = !disabled && draft != null;

  return (
    <CalendarSlidePage
      visible={visible}
      direction="vertical"
      testID="event-reminder-page"
      onRequestClose={onClose}
    >
      <CalendarTextTitleBar
        title="选择提醒时间"
        onLeft={onClose}
        rightText="完成"
        onRight={() => onDone(disabled ? null : draft)}
        rightTestID="event-reminder-done"
      />
      <ScrollView style={s.page}>
        <View style={s.reminderSwitchRow}>
          <Text style={s.rowText}>日程提醒</Text>
          <CalendarSwitch
            checked={enabled}
            disabled={disabled}
            onChange={checked => setDraft(checked ? defaultValue : null)}
            accessibilityLabel="日程提醒"
            testID="event-reminder-switch"
          />
        </View>
        {enabled ? (
          <>
            <View style={s.sectionDivider} />
            <View style={s.reminderList} testID="event-reminder-options">
              {options.map(option => {
                const selected = draft === option.value;
                return (
                  <TouchableOpacity
                    key={option.key}
                    testID={`event-reminder-option-${option.key}`}
                    style={s.reminderRow}
                    onPress={() => setDraft(option.value)}
                    activeOpacity={0.65}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    accessibilityLabel={option.label}
                  >
                    <Text
                      testID={`event-reminder-option-${option.key}-label`}
                      style={[s.rowText, selected && s.selectedText]}
                    >
                      {option.label}
                    </Text>
                    <View style={s.reminderCheckSlot}>
                      {selected ? <Ionicons name="checkmark" size={16} color={C.primary} /> : null}
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          </>
        ) : null}
      </ScrollView>
    </CalendarSlidePage>
  );
}

export function LocationEditorPage({
  visible,
  value,
  onDone,
  onClose,
}: {
  visible: boolean;
  value: string;
  onDone: (value: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = React.useState(value);

  React.useEffect(() => {
    if (visible) setDraft(value);
  }, [value, visible]);

  return (
    <CalendarSlidePage
      visible={visible}
      direction="vertical"
      testID="event-location-page"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={s.editorPage}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <CalendarTextTitleBar
          title=""
          onLeft={onClose}
          rightText="完成"
          onRight={() => onDone(draft)}
          rightTestID="event-location-done"
        />
        <TextInput
          style={s.locationInput}
          value={draft}
          onChangeText={setDraft}
          placeholder="输入地点"
          placeholderTextColor={C.faint}
          autoFocus={visible}
          maxLength={400}
          returnKeyType="done"
          onSubmitEditing={() => onDone(draft)}
          testID="event-location-input"
        />
        <View style={s.fullDivider} />
      </KeyboardAvoidingView>
    </CalendarSlidePage>
  );
}

export function DescriptionEditorPage({
  visible,
  value,
  onDone,
  onClose,
}: {
  visible: boolean;
  value: string;
  onDone: (value: string) => void;
  onClose: () => void;
}) {
  const { showDialog } = useAppDialog();
  const [draft, setDraft] = React.useState(value);

  React.useEffect(() => {
    if (visible) setDraft(value);
  }, [value, visible]);

  const requestClose = React.useCallback(() => {
    if (draft === value) {
      onClose();
      return;
    }
    showDialog({
      title: '提示',
      message: '还有未保存的描述，确认退出吗？',
      tone: 'warning',
      actions: [
        { text: '确定', role: 'primary', onPress: onClose },
        { text: '取消', role: 'cancel' },
      ],
    });
  }, [draft, onClose, showDialog, value]);

  return (
    <CalendarSlidePage
      visible={visible}
      direction="vertical"
      testID="event-description-page"
      onRequestClose={requestClose}
    >
      <KeyboardAvoidingView
        style={s.editorPage}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <CalendarTextTitleBar
          title="添加描述"
          onLeft={requestClose}
          rightText="完成"
          onRight={() => onDone(draft)}
          rightTestID="event-description-done"
        />
        <TextInput
          style={s.descriptionEditor}
          value={draft}
          onChangeText={setDraft}
          placeholder="请输入内容"
          placeholderTextColor={C.faint}
          autoFocus={visible}
          multiline
          textAlignVertical="top"
          maxLength={10000}
          testID="event-description-input"
        />
      </KeyboardAvoidingView>
    </CalendarSlidePage>
  );
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: C.body },
  repeatList: { paddingTop: 14, paddingLeft: 15 },
  repeatRow: { height: 48, paddingRight: 15, flexDirection: 'row', alignItems: 'center' },
  rowText: { flex: 1, fontSize: 16, lineHeight: 22, color: C.text },
  selectedText: { color: C.primary },
  reminderSwitchRow: { marginTop: 14, minHeight: 48, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center' },
  sectionDivider: { height: StyleSheet.hairlineWidth, marginLeft: 16, marginVertical: 14, backgroundColor: C.divider },
  reminderList: { paddingTop: 14 },
  reminderRow: { height: 48, paddingLeft: 16, paddingRight: 16, flexDirection: 'row', alignItems: 'center' },
  reminderCheckSlot: { width: 16, height: 16, alignItems: 'center', justifyContent: 'center' },
  editorPage: { flex: 1, backgroundColor: C.body },
  locationInput: {
    minHeight: 50,
    marginHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 12,
    paddingHorizontal: 0,
    fontSize: 20,
    lineHeight: 28,
    color: C.text,
  },
  fullDivider: { height: StyleSheet.hairlineWidth, backgroundColor: C.divider },
  descriptionEditor: {
    flex: 1,
    paddingTop: 16,
    paddingHorizontal: 16,
    paddingBottom: 24,
    fontSize: 16,
    lineHeight: 24,
    color: C.text,
  },
});
