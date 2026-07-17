import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const source = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

describe('Android native calendar routes [CAL-ROOT-001/CAL-DETAIL-001/CAL-EDIT-001]', () => {
  it('uses native route surfaces without legacy React gesture or overlay owners', () => {
    const schedule = source('src/screens/ScheduleScreen.android.tsx');
    const edit = source('src/screens/AddEventScreen.android.tsx');
    const detail = source('src/screens/EventDetailScreen.android.tsx');
    expect(schedule).toContain('LaojiCalendarView');
    expect(schedule).toContain("presentNativeWindowOverlay(searchOwnerId, 'calendar-search'");
    expect(schedule).not.toContain('LaojiCalendarSearchView');
    expect(schedule).not.toContain('/components/CalendarSearchPage');
    expect(edit).toContain('LaojiCalendarEditView');
    expect(detail).toContain('LaojiCalendarDetailView');
    for (const value of [schedule, edit, detail]) {
      expect(value).not.toMatch(/\bPanResponder\b|\bModal\b|\bKeyboardAvoidingView\b/);
    }
  });

  it('retains repository validation, conflict, recurrence, reminder, and idempotency contracts', () => {
    const edit = source('src/screens/AddEventScreen.android.tsx');
    for (const contract of [
      'validateEventDraft',
      'findConflicts',
      'recurrenceEditDialog',
      'recurrenceDeleteDialog',
      'reminderUnavailableMessage',
      'requestStateForPayload',
    ]) expect(edit).toContain(contract);
    expect(edit).toContain('startTime: value.isAllDay ? undefined : value.startTime ?? undefined');
  });

  it('keeps date and time editing inside the source-mapped native calendar root', () => {
    const directory = path.join(root, 'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/calendarpages');
    const kotlin = fs.readdirSync(directory)
      .filter(file => file.endsWith('.kt'))
      .map(file => fs.readFileSync(path.join(directory, file), 'utf8'))
      .join('\n');
    expect(kotlin).not.toMatch(/\b(?:AlertDialog|DatePickerDialog|TimePickerDialog)\b/);
    expect(kotlin).toContain('class CalendarEditTimePageView');
    expect(kotlin).toContain('class CalendarEditWheelView');
  });

  it('limits the custom create surface accessibility bounds to the real 48dp FAB', () => {
    const shell = source(
      'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/calendar/CalendarShellViews.kt',
    );
    expect(shell).toContain('info.setBoundsInParent(');
    expect(shell).toContain('info.setBoundsInScreen(');
    expect(shell).toContain('screenLocation[0] + bounds.left.toInt()');
    expect(shell).toContain('screenLocation[1] + bounds.top.toInt()');
    expect(shell).toContain('val bounds = fabRect()');
  });
});
