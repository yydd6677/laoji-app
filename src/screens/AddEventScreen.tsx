import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ScrollView, KeyboardAvoidingView, Platform,
} from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { Colors as C } from '../theme/colors';
import { ScreenContainer } from '../components/ScreenContainer';
import { useAppDialog } from '../components/AppDialog';

import { CalEvent, RootStackParamList } from '../types';
import { useEvents } from '../store/EventsStore';
import { checkConflict } from '../store/EventsStore';
import { BackHeader } from '../components/Common';
import { useAuth } from '../store/AuthStore';
import {
  DEFAULT_REMINDER_MINUTES,
  REMINDER_OPTIONS,
  ReminderMinutes,
  defaultReminderForEvent,
  loadNotificationPrefs,
} from '../services/notifications';
import {
  EVENT_CATEGORIES,
  EventCategory,
  colorForEventCategory,
  normalizeEventCategory,
} from '../utils/eventColors';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'AddEvent'>;
  route: RouteProp<RootStackParamList, 'AddEvent'>;
};

const REPEAT_OPTIONS = ['不重复', '每天', '每周', '每月', '每年'] as const;

const REPEAT_MAP = {
  '不重复': 'once' as const,
  '每天':   'daily' as const,
  '每周':   'weekly' as const,
  '每月':   'monthly' as const,
  '每年':   'yearly' as const,
};

function repeatToOption(repeat?: CalEvent['repeat']): typeof REPEAT_OPTIONS[number] {
  switch (repeat) {
    case 'daily': return '每天';
    case 'weekly': return '每周';
    case 'monthly': return '每月';
    case 'yearly': return '每年';
    default: return '不重复';
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function parseDateStr(str: string): Date {
  // "YYYY-MM-DD" → Date at local midnight
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function todayDateStr(): string {
  return formatDate(new Date());
}

function parseTimeStr(str: string): Date {
  const [h, min] = str.split(':').map(Number);
  const d = new Date();
  d.setHours(h, min, 0, 0);
  return d;
}

function formatTime(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function timeToMinutes(str: string): number {
  const [h, min] = str.split(':').map(Number);
  return h * 60 + min;
}

// ─────────────────────────────────────────────────────────────────────────────

export function AddEventScreen({ navigation, route }: Props) {
  const { events, addEvent, updateEvent, refreshEvents } = useEvents();
  const { mode, session } = useAuth();
  const { showDialog } = useAppDialog();
  const editingId = route.params?.eventId;
  const editingEvent = editingId ? events.find(e => e.id === editingId) : undefined;
  const isEditing = Boolean(editingId);
  const initDate = route.params?.date ?? editingEvent?.startDate ?? todayDateStr();
  const [saving, setSaving] = React.useState(false);

  const [title, setTitle]       = useState(editingEvent?.title ?? '');
  const [dateObj, setDateObj]   = useState<Date>(() => parseDateStr(initDate));
  const [startObj, setStartObj] = useState<Date>(() => parseTimeStr(editingEvent?.startTime ?? '10:00'));
  const [endObj, setEndObj]     = useState<Date>(() => parseTimeStr(editingEvent?.endTime ?? '11:00'));
  const [isAllDay, setAllDay]   = useState(editingEvent?.isAllDay ?? false);
  const [repeat, setRepeat]     = useState<typeof REPEAT_OPTIONS[number]>(repeatToOption(editingEvent?.repeat));
  const [desc, setDesc]         = useState(editingEvent?.description ?? editingEvent?.detail ?? '');
  const [category, setCategory] = useState<EventCategory>(() => normalizeEventCategory(editingEvent?.category));
  const [location, setLocation] = useState(editingEvent?.location ?? '');
  const [defaultReminder, setDefaultReminder] = useState<ReminderMinutes>(DEFAULT_REMINDER_MINUTES);
  const [reminderMinutes, setReminderMinutes] = useState<ReminderMinutes>(
    editingEvent
      ? editingEvent.reminderMinutes ?? null
      : defaultReminderForEvent(false, '10:00'),
  );
  const notificationScope = mode === 'authenticated' && session ? `user:${session.user.id}` : mode === 'guest' ? 'guest' : 'signed_out';

  React.useEffect(() => {
    if (!editingEvent) return;
    setTitle(editingEvent.title);
    setDateObj(parseDateStr(editingEvent.startDate));
    setStartObj(parseTimeStr(editingEvent.startTime ?? '10:00'));
    setEndObj(parseTimeStr(editingEvent.endTime ?? '11:00'));
    setAllDay(editingEvent.isAllDay ?? false);
    setRepeat(repeatToOption(editingEvent.repeat));
    setDesc(editingEvent.description ?? editingEvent.detail ?? '');
    setCategory(normalizeEventCategory(editingEvent.category));
    setLocation(editingEvent.location ?? '');
    setReminderMinutes(editingEvent.reminderMinutes ?? null);
  }, [editingEvent?.id]);

  React.useEffect(() => {
    let alive = true;
    loadNotificationPrefs(notificationScope).then(prefs => {
      if (!alive) return;
      setDefaultReminder(prefs.defaultReminderMinutes);
      if (!isEditing) {
        setReminderMinutes(defaultReminderForEvent(isAllDay, startTime, prefs.defaultReminderMinutes));
      }
    });
    return () => { alive = false; };
  }, [notificationScope, isEditing]);

  // picker visibility
  const [showDatePicker, setShowDatePicker]   = useState(false);
  const [showStartPicker, setShowStartPicker] = useState(false);
  const [showEndPicker, setShowEndPicker]     = useState(false);

  const date      = formatDate(dateObj);
  const startTime = formatTime(startObj);
  const endTime   = formatTime(endObj);
  const color     = colorForEventCategory(category);

  const canSave = title.trim().length > 0;

  const doSave = async () => {
    setSaving(true);
    try {
      const payload: Omit<CalEvent, 'id'> = {
        title: title.trim(),
        startDate: date,
        startTime: isAllDay ? undefined : startTime,
        endTime: isAllDay ? undefined : endTime,
        isAllDay,
        repeat: REPEAT_MAP[repeat],
        description: desc,
        color,
        category,
        location: location || undefined,
        reminderMinutes,
      };
      if (editingEvent) {
        await updateEvent(editingEvent.id, payload);
      } else {
        await addEvent(payload);
      }
      const d = parseDateStr(date);
      await refreshEvents(d.getFullYear(), d.getMonth() + 1);
      if (editingEvent && !editingEvent.startDate.startsWith(date.slice(0, 7))) {
        const oldDate = parseDateStr(editingEvent.startDate);
        await refreshEvents(oldDate.getFullYear(), oldDate.getMonth() + 1);
      }
      navigation.goBack();
    } catch {
      showDialog({ title: '保存失败', message: '请检查网络后重试', tone: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const handleSave = () => {
    if (!canSave) {
      showDialog({ title: '请输入事项标题', tone: 'info' });
      return;
    }
    if (isEditing && !editingEvent) {
      showDialog({ title: '日程不存在', message: '请返回后重新打开日程', tone: 'warning' });
      return;
    }

    if (!isAllDay && timeToMinutes(startTime) >= timeToMinutes(endTime)) {
      showDialog({ title: '时间不正确', message: '结束时间需要晚于开始时间', tone: 'warning' });
      return;
    }

    if (!isAllDay && startTime && endTime) {
      const { hasConflict, conflicts } = checkConflict(events, date, startTime, endTime, editingEvent?.id);
      if (hasConflict) {
        const names = conflicts.map(e => `• ${e.title} (${e.startTime}–${e.endTime})`).join('\n');
        showDialog({
          title: '时间冲突',
          message: `该时间段与以下日程冲突：\n${names}`,
          hint: '如果确认这些安排可以重叠，仍然可以继续保存。',
          tone: 'warning',
          actions: [
            { text: '仍然保存', role: 'primary', onPress: doSave },
            { text: '取消', role: 'cancel' },
          ],
        });
        return;
      }
    }

    doSave();
  };

  if (isEditing && !editingEvent) {
    return (
      <ScreenContainer>
        <BackHeader title="编辑日程" onBack={() => navigation.goBack()} />
        <View style={s.emptyWrap}>
          <Text style={s.emptyTitle}>日程不存在</Text>
          <Text style={s.emptyText}>请返回日程详情后重新打开编辑。</Text>
        </View>
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer>
      <BackHeader
        title={isEditing ? '编辑日程' : '新建日程'}
        onBack={() => navigation.goBack()}
        right={
          <TouchableOpacity onPress={handleSave} disabled={!canSave || saving}>
            <Text style={[s.saveLink, (!canSave || saving) && { opacity: 0.35 }]}>{saving ? '保存中' : '保存'}</Text>
          </TouchableOpacity>
        }
      />
      <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView style={s.scroll} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>

          {/* Category picker */}
          <View style={s.categoryRow}>
            {EVENT_CATEGORIES.map(item => {
              const selected = category === item;
              const itemColor = colorForEventCategory(item);
              return (
                <TouchableOpacity
                  key={item}
                  onPress={() => setCategory(item)}
                  style={[s.categoryChip, selected && { backgroundColor: itemColor + '1F', borderColor: itemColor }]}
                  activeOpacity={0.78}
                >
                  <View style={[s.categoryDot, { backgroundColor: itemColor }]} />
                  <Text style={[s.categoryText, selected && { color: itemColor }]}>{item}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Title */}
          <View style={s.fieldCard}>
            <TextInput
              style={s.titleInput}
              placeholder="添加标题"
              placeholderTextColor={C.faint}
              value={title}
              onChangeText={setTitle}
              maxLength={60}
            />
          </View>

          {/* Date */}
          <TouchableOpacity style={s.row} onPress={() => setShowDatePicker(true)} activeOpacity={0.7}>
            <View style={[s.iconBox, { backgroundColor: color + '22' }]}>
              <Ionicons name="calendar-outline" size={18} color={color} />
            </View>
            <View style={s.rowContent}>
              <Text style={s.rowLabel}>日期</Text>
              <Text style={s.rowValue}>{date}</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={C.faint} />
          </TouchableOpacity>

          {showDatePicker && (
            <DateTimePicker
              value={dateObj}
              mode="date"
              display={Platform.OS === 'ios' ? 'spinner' : 'default'}
              onChange={(_e, selected) => {
                setShowDatePicker(Platform.OS === 'ios');
                if (selected) setDateObj(selected);
                if (Platform.OS === 'android') setShowDatePicker(false);
              }}
            />
          )}

          {/* All day toggle */}
          <View style={s.row}>
            <View style={[s.iconBox, { backgroundColor: C.purpleLight }]}>
              <Ionicons name="sunny-outline" size={18} color={C.purple} />
            </View>
            <Text style={[s.rowLabel, { flex: 1 }]}>全天</Text>
            <TouchableOpacity
              onPress={() => setAllDay(v => {
                const next = !v;
                setReminderMinutes(defaultReminderForEvent(next, next ? undefined : startTime, defaultReminder));
                return next;
              })}
              style={[s.toggle, { backgroundColor: isAllDay ? C.purple : '#CCC8E0' }]}
            >
              <View style={[s.toggleThumb, { left: isAllDay ? 23 : 3 }]} />
            </TouchableOpacity>
          </View>

          {/* Time */}
          {!isAllDay && (
            <View style={s.row}>
              <View style={[s.iconBox, { backgroundColor: C.purpleLight }]}>
                <Ionicons name="time-outline" size={18} color={C.purple} />
              </View>
              <View style={s.rowContent}>
                <Text style={s.rowLabel}>时间</Text>
                <View style={s.timeRow}>
                  <TouchableOpacity onPress={() => setShowStartPicker(true)} style={s.timeChip}>
                    <Text style={s.timeChipText}>{startTime}</Text>
                  </TouchableOpacity>
                  <Text style={s.timeSep}>–</Text>
                  <TouchableOpacity onPress={() => setShowEndPicker(true)} style={s.timeChip}>
                    <Text style={s.timeChipText}>{endTime}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          )}

          {/* Reminder */}
          <View style={s.row}>
            <View style={[s.iconBox, { backgroundColor: C.purpleLight }]}>
              <Ionicons name="notifications-outline" size={18} color={C.purple} />
            </View>
            <Text style={[s.rowLabel, { flex: 1 }]}>提醒</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.repeatScroll}>
              {REMINDER_OPTIONS.map(opt => {
                const disabled = isAllDay && opt.value !== null;
                const selected = reminderMinutes === opt.value || (isAllDay && opt.value === null);
                return (
                  <TouchableOpacity
                    key={opt.label}
                    style={[
                      s.repeatChip,
                      selected && { backgroundColor: C.purple },
                      disabled && { opacity: 0.35 },
                    ]}
                    onPress={() => {
                      if (!disabled) setReminderMinutes(opt.value);
                    }}
                    disabled={disabled}
                  >
                    <Text style={[s.repeatChipText, selected && { color: '#fff' }]}>{opt.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>

          {showStartPicker && (
            <DateTimePicker
              value={startObj}
              mode="time"
              is24Hour
              display={Platform.OS === 'ios' ? 'spinner' : 'default'}
              onChange={(_e, selected) => {
                setShowStartPicker(Platform.OS === 'ios');
                if (selected) setStartObj(selected);
                if (Platform.OS === 'android') setShowStartPicker(false);
              }}
            />
          )}

          {showEndPicker && (
            <DateTimePicker
              value={endObj}
              mode="time"
              is24Hour
              display={Platform.OS === 'ios' ? 'spinner' : 'default'}
              onChange={(_e, selected) => {
                setShowEndPicker(Platform.OS === 'ios');
                if (selected) setEndObj(selected);
                if (Platform.OS === 'android') setShowEndPicker(false);
              }}
            />
          )}

          {/* Location */}
          <View style={s.row}>
            <View style={[s.iconBox, { backgroundColor: C.purpleLight }]}>
              <Ionicons name="location-outline" size={18} color={C.purple} />
            </View>
            <View style={s.rowContent}>
              <Text style={s.rowLabel}>地点</Text>
              <TextInput style={s.rowInput} value={location} onChangeText={setLocation} placeholder="添加地点" placeholderTextColor={C.faint} />
            </View>
          </View>

          {/* Repeat */}
          <View style={s.row}>
            <View style={[s.iconBox, { backgroundColor: C.purpleLight }]}>
              <Ionicons name="repeat-outline" size={18} color={C.purple} />
            </View>
            <Text style={[s.rowLabel, { flex: 1 }]}>重复</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.repeatScroll}>
              {REPEAT_OPTIONS.map(opt => (
                <TouchableOpacity
                  key={opt}
                  style={[s.repeatChip, repeat === opt && { backgroundColor: C.purple }]}
                  onPress={() => setRepeat(opt)}
                >
                  <Text style={[s.repeatChipText, repeat === opt && { color: '#fff' }]}>{opt}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>

          {/* Description */}
          <View style={s.row}>
            <View style={[s.iconBox, { backgroundColor: C.purpleLight }]}>
              <Ionicons name="document-text-outline" size={18} color={C.purple} />
            </View>
            <View style={s.rowContent}>
              <Text style={s.rowLabel}>备注</Text>
              <TextInput
                style={[s.rowInput, s.descInput]}
                value={desc}
                onChangeText={setDesc}
                placeholder="添加备注"
                placeholderTextColor={C.faint}
                multiline
                numberOfLines={3}
              />
            </View>
          </View>

          {/* Save button */}
          <TouchableOpacity onPress={handleSave} disabled={!canSave || saving} activeOpacity={0.85} style={{ marginTop: 8 }}>
            <LinearGradient
              colors={canSave && !saving ? [C.gradFrom, C.gradTo] : ['#CCC8E0', '#CCC8E0']}
              start={{ x:0,y:0 }} end={{ x:1,y:0 }}
              style={s.saveBtn}
            >
              <Text style={s.saveBtnText}>{saving ? '保存中…' : isEditing ? '保存修改' : '保存到日历'}</Text>
            </LinearGradient>
          </TouchableOpacity>
          <View style={{ height: 40 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </ScreenContainer>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.appBg },
  flex: { flex: 1 },
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  emptyTitle: { fontSize: 17, fontWeight: '700', color: C.text, marginBottom: 8 },
  emptyText: { fontSize: 13, color: C.sub, lineHeight: 20 },
  scroll: { flex: 1 },
  content: { padding: 14, paddingTop: 16 },
  saveLink: { color: C.purple, fontSize: 15, fontWeight: '700' },
  categoryRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14, paddingHorizontal: 4 },
  categoryChip: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderColor: 'rgba(150,100,200,0.08)', backgroundColor: C.card, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 7 },
  categoryDot: { width: 8, height: 8, borderRadius: 4 },
  categoryText: { fontSize: 12, color: C.sub, fontWeight: '700' },
  fieldCard: { backgroundColor: C.card, borderRadius: 16, marginBottom: 12, shadowColor:'#5028A0', shadowOffset:{width:0,height:1}, shadowOpacity:0.06, shadowRadius:8, elevation:2 },
  titleInput: { fontSize: 18, fontWeight: '600', color: C.text, padding: 16 },
  row: { backgroundColor: C.card, borderRadius: 16, marginBottom: 10, flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, shadowColor:'#5028A0', shadowOffset:{width:0,height:1}, shadowOpacity:0.06, shadowRadius:8, elevation:2 },
  iconBox: { width: 38, height: 38, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  rowContent: { flex: 1 },
  rowLabel: { fontSize: 14, fontWeight: '600', color: C.text },
  rowInput: { fontSize: 14, color: C.sub, marginTop: 4 },
  rowValue: { fontSize: 14, color: C.sub, marginTop: 4 },
  descInput: { height: 60, textAlignVertical: 'top' },
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  timeChip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8, backgroundColor: C.purpleLight },
  timeChipText: { fontSize: 14, color: C.purple, fontWeight: '600' },
  timeSep: { color: C.faint },
  toggle: { width: 46, height: 26, borderRadius: 13, justifyContent: 'center' },
  toggleThumb: { position: 'absolute', width: 20, height: 20, borderRadius: 10, backgroundColor: '#fff', shadowColor:'#000', shadowOffset:{width:0,height:1}, shadowOpacity:0.18, shadowRadius:2, elevation:2 },
  repeatScroll: { flexShrink: 1 },
  repeatChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, backgroundColor: C.purpleLight, marginRight: 6 },
  repeatChipText: { fontSize: 12, color: C.purple, fontWeight: '600' },
  saveBtn: { height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center', shadowColor:'#6A38B2', shadowOffset:{width:0,height:6}, shadowOpacity:0.45, shadowRadius:12, elevation:6 },
  saveBtnText: { fontSize: 16, fontWeight: '700', color: '#fff' },
});
