const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ts = require('typescript');
const { DatabaseSync, backup } = require('node:sqlite');

function loader(overrides = {}) {
  const cache = new Map();
  function load(file) {
    file = path.resolve(file);
    if (Object.hasOwn(overrides, file)) return overrides[file];
    if (cache.has(file)) return cache.get(file).exports;
    const m = { exports: {} }; cache.set(file, m);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    new Function('require', 'module', 'exports', code)(name => {
      if (Object.hasOwn(overrides, name)) return overrides[name];
      if (!name.startsWith('.')) throw Error(`unexpected dependency ${name}`);
      return load(path.resolve(path.dirname(file), `${name}.ts`));
    }, m, m.exports);
    return m.exports;
  }
  return load;
}
const simple = loader({ [path.resolve('src/theme/colors.ts')]: {} });
const time = simple('src/domain/scheduleTime.ts');
const editor = simple('src/domain/scheduleEditor.ts');
const eventTime = simple('src/utils/scheduleEventTime.ts');
function draft(extra = {}) {
  return editor.createScheduleEditorDraft({ id: 'draft-1', saveRequestId: 'save-1', startDate: '2026-10-28', ...extra });
}
function begin(value, mode = 'patch', id = 'input-1') {
  return editor.beginScheduleEditorInput(value, { id, mode,
    referenceDatetime: '2026-10-27T16:00:00.000Z', timezone: 'Asia/Shanghai', text: '本次输入' });
}
function apply(value, changes) {
  const op = value.pendingInput;
  return editor.applyScheduleEditorInput(value, { id: op.id, baseRevision: op.baseRevision, sequence: op.sequence }, changes);
}
const exact = (startTime, endTime = null) => ({ precision: 'exact', period: null, startTime, endTime });
const period = value => ({ precision: 'period', period: value, startTime: null, endTime: null });

test('a truncated lexical clause is not certified local-safe; existing graph owns the whole input', () => {
  const parser = simple('src/services/localScheduleParser.ts');
  const reference = new Date('2026-10-28T14:00:00+08:00');
  for (const text of ['记着，周五上午十点零一，把窗帘送洗', '定在这周五中午十二点十分拿蛋糕',
    '明天下午三点联系装修师傅，核对材料', '后天上午十点买菜，带上购物袋']) {
    const parsed = parser.parseLocalScheduleText(text, reference, 'Asia/Shanghai');
    assert.equal(parser.classifyScheduleParseRoute(text, parsed, reference, 'Asia/Shanghai').route, 'server_required', text);
  }
  for (const text of ['提醒我，周六晚上七点四十看电影', '周五上午十点零一把窗帘送洗', '明天下午三点开会']) {
    const parsed = parser.parseLocalScheduleText(text, reference, 'Asia/Shanghai');
    assert.equal(parser.classifyScheduleParseRoute(text, parsed, reference, 'Asia/Shanghai').route, 'local_safe', text);
  }
});

test('initial date omission uses fixed input timezone, explicit entry wins, uncertainty never defaults', () => {
  const parsed = { title: '取快递', start_date: '', date_resolution: 'omitted', event_type: 'once',
    start_time: null, end_time: null, description: null, reference_datetime: '2026-10-28T16:00:01.000Z', timezone: 'Asia/Shanghai' };
  assert.deepEqual(editor.initialScheduleEditorDate(parsed), { date: '2026-10-29', origin: 'default' });
  assert.equal(editor.initialScheduleEditorDate(parsed, { timezone: 'America/Los_Angeles' }).date, '2026-10-28');
  assert.deepEqual(editor.initialScheduleEditorDate(parsed, { entryDate: '2026-09-03' }), { date: '2026-09-03', origin: 'context' });
  assert.equal(editor.initialScheduleEditorDate({ ...parsed, start_date: '2026-11-04', date_resolution: 'resolved' },
    { entryDate: '2026-09-03' }).date, '2026-11-04');
  for (const date_resolution of ['unresolved', null, undefined]) {
    assert.equal(editor.initialScheduleEditorDate({ ...parsed, date_resolution }, { entryDate: '2026-09-03' }).date, null);
  }
  for (const reference_datetime of [undefined, '2026-10-29T00:01:00', 'invalid']) {
    assert.equal(editor.initialScheduleEditorDate({ ...parsed, reference_datetime }).date, null);
  }
  assert.equal(editor.initialScheduleEditorDate({ ...parsed, timezone: 'Invalid/Zone' }).date, null);
  const earlier = { referenceDatetime: '2026-10-28T15:59:59Z', timezone: 'Asia/Shanghai' };
  assert.equal(editor.initialScheduleEditorDate(parsed, earlier).date, '2026-10-28');
  assert.equal(editor.initialScheduleEditorDate(parsed, earlier).date, '2026-10-28');
  assert.equal(editor.initialScheduleEditorChanges(parsed).startDate, '2026-10-29');
  assert.equal(editor.initialScheduleEditorChanges({ ...parsed, date_resolution: 'unresolved', end_date: '2026-10-30' }).endDate, null);
});

test('default/context origins survive persistence and undo without overriding later manual date', () => {
  const seed = draft({ dateOrigin: 'default' });
  const active = begin(seed, 'initial');
  const op = active.pendingInput;
  const applied = editor.applyScheduleEditorInput(active, { id: op.id, baseRevision: op.baseRevision, sequence: op.sequence },
    { title: '取快递', startDate: '2026-10-29' }, { startDate: 'default' }).draft;
  assert.equal(applied.fieldOrigins.startDate, 'default');
  editor.assertScheduleEditorDraft(JSON.parse(JSON.stringify(applied)));
  assert.equal(editor.undoScheduleEditorInput(applied).startDate, '2026-10-28');
  const manual = editor.editScheduleFields(applied, { startDate: '2026-11-01' });
  assert.equal(editor.undoScheduleEditorInput(manual).startDate, '2026-11-01');
  assert.equal(draft({ dateOrigin: 'context' }).fieldOrigins.startDate, 'context');
});

test('three precisions are mutually exclusive, all six periods preserve their identity and exact minutes', () => {
  for (const value of time.SCHEDULE_PERIODS) {
    const current = period(value);
    assert.equal(time.isScheduleTimeValue(current), true);
    assert.notEqual(time.scheduleTimeLabel(current), '全天');
    assert.equal(time.isScheduleTimeValue({ ...current, startTime: '19:00' }), false);
  }
  assert.equal(time.isScheduleTimeValue(exact('09:23')), true);
  assert.equal(time.scheduleTimeLabel(exact('09:23', '10:07')), '09:23 - 10:07');
  for (const invalid of [exact('24:00'), exact('09:60'), exact('9:23'),
    { precision: 'unspecified', period: 'night', startTime: null, endTime: null },
    { precision: 'exact', period: null, startTime: null, endTime: '12:00' }]) {
    assert.equal(time.isScheduleTimeValue(invalid), false);
  }
});

test('initial mobile parsing preserves all sixty spoken minutes before editor projection', () => {
  const parser = simple('src/services/localScheduleParser.ts');
  const digits = '零一二三四五六七八九';
  for (let minute = 0; minute < 60; minute++) {
    const chinese = minute < 10 ? digits[minute] : (minute >= 20 ? digits[Math.floor(minute / 10)] : '')
      + '十' + (minute % 10 ? digits[minute % 10] : '');
    for (const form of new Set([String(minute), chinese, minute < 10 ? `零${digits[minute]}` : chinese])) {
      for (const suffix of ['', '分']) {
        const text = `明天上午九点${form}${suffix}取快递`;
        const parsed = parser.parseLocalScheduleText(text, new Date('2026-10-28T10:00:00+08:00'), 'Asia/Shanghai');
        assert.equal(parsed?.start_time, `09:${String(minute).padStart(2, '0')}`, text);
        assert.equal(parsed?.title, '取快递', text);
      }
    }
  }
});

test('a creation grammar miss is not a rejection; explicit non-schedule controls still reject', () => {
  const parser = simple('src/services/localScheduleParser.ts');
  const reference = new Date('2026-10-28T18:00:00+08:00');
  for (const text of ['下午去修眼镜', '改天去配眼镜', '日期没定，陪爸爸去医院',
    '下个月找时间保养车', '有空再去取衣服', '等放假了再去办护照']) {
    const parsed = parser.parseLocalScheduleText(text, reference, 'Asia/Shanghai');
    assert.equal(parser.classifyScheduleParseRoute(text, parsed, reference, 'Asia/Shanghai').route, 'server_required', text);
  }
  for (const text of ['', '你好', '不要创建日程']) {
    const parsed = parser.parseLocalScheduleText(text, reference, 'Asia/Shanghai');
    assert.equal(parser.classifyScheduleParseRoute(text, parsed, reference, 'Asia/Shanghai').route, 'reject', text);
  }
});

test('only legacy events can recover a period from raw text, never explicit edited values', () => {
  const legacy = { rawText: '晚上吃饭', isAllDay: false };
  assert.equal(eventTime.eventTimeLabel(legacy), '晚上');
  assert.equal(eventTime.eventTimeLabel({ ...legacy, timePrecision: 'unspecified', timePeriod: null }), '未设置');
  assert.equal(eventTime.eventTimeLabel({ ...legacy, timePrecision: 'exact', timePeriod: null, startTime: '09:23' }), '09:23');
  assert.equal(eventTime.eventTimeLabel({ ...legacy, timePrecision: 'period', timePeriod: 'afternoon' }), '下午');
  assert.throws(() => eventTime.scheduleTimeForEvent({ ...legacy, timePrecision: 'period', timePeriod: 'night', startTime: '19:00' }));
});

test('phase, transcript and operation sequence never advance structural revision', () => {
  const initial = draft();
  const recording = editor.beginScheduleEditorInput(initial, { id: 'capture-1', mode: 'initial', recording: true,
    referenceDatetime: '2026-10-27T23:59:59+08:00', timezone: 'Asia/Shanghai' });
  const recognizing = editor.finishScheduleEditorTranscript(recording, 'capture-1', '已经转写');
  assert.equal(recording.revision, initial.revision);
  assert.equal(recognizing.revision, initial.revision);
  assert.equal(recognizing.pendingInput.referenceDatetime, '2026-10-27T23:59:59+08:00');
  assert.equal(recognizing.pendingInput.sequence, 1);
  assert.ok(recognizing.stateRevision > recording.stateRevision);
  assert.strictEqual(editor.finishScheduleEditorTranscript(recognizing, 'old', '旧输入'), recognizing);
});

test('entry recovery separates manual creation, explicit date/slot, event scope, hardware and action identities', () => {
  assert.equal(editor.isScheduleEditorResumeCandidate(draft(), {}), false, 'an untouched date default is not a user draft');
  const retained = editor.editScheduleFields(draft(), { title: '复查', time: exact('09:23', '10:07') });
  assert.equal(editor.isScheduleEditorResumeCandidate(retained, {}), true);
  assert.equal(editor.isScheduleEditorResumeCandidate(retained, { date: '2026-10-28' }), true);
  assert.equal(editor.isScheduleEditorResumeCandidate(retained, { date: '2026-10-29' }), false);
  assert.equal(editor.isScheduleEditorResumeCandidate(retained, { date: '2026-10-28', startTime: '09:23', endTime: '10:07' }), true);
  assert.equal(editor.isScheduleEditorResumeCandidate(retained, { date: '2026-10-28', startTime: '09:00' }), false);
  const dateOnly = editor.editScheduleFields(draft(), { startDate: '2026-10-29' });
  assert.equal(editor.isScheduleEditorResumeCandidate(dateOnly, {}), true);
  const speechOnly = { ...draft(), latestInputText: '周末再定时间' };
  assert.equal(editor.isScheduleEditorResumeCandidate(speechOnly, {}), true);
  const hardware = { ...retained, sourceKind: 'hardware_voice', sourceInputJobId: 'input-1' };
  assert.equal(editor.isScheduleEditorResumeCandidate(hardware, {}), false);
  assert.equal(editor.isScheduleEditorResumeCandidate(hardware, { draft: { inputJobId: 'input-1' } }), true);
  assert.equal(editor.isScheduleEditorResumeCandidate(hardware, { draft: { inputJobId: 'other' } }), false);
  const action = { ...retained, sourceKind: 'meeting_action', saveRequestId: 'action-1' };
  assert.equal(editor.isScheduleEditorResumeCandidate(action, {}), false);
  assert.equal(editor.isScheduleEditorResumeCandidate(action, { followup: { clientRequestId: 'action-1' } }), true);
  assert.equal(editor.isScheduleEditorResumeCandidate(action, { followup: { clientRequestId: 'other' } }), false);
  const ref = { sourceEventId: 'original', occurrenceDate: '2026-10-28' };
  const editing = editor.editScheduleFields(draft({ eventRef: ref, recurrenceScope: 'following' }), { title: '已修改' });
  assert.equal(editor.isScheduleEditorResumeCandidate(editing, {}), false);
  assert.equal(editor.isScheduleEditorResumeCandidate(editing, { eventRef: ref, recurrenceScope: 'following' }), true);
  assert.equal(editor.isScheduleEditorResumeCandidate(editing, { eventRef: ref, recurrenceScope: 'series' }), false);
  assert.equal(editor.isScheduleEditorResumeCandidate(editing, { eventRef: { ...ref, occurrenceDate: '2026-10-29' }, recurrenceScope: 'following' }), false);
  assert.equal(editor.isScheduleEditorResumeCandidate({ ...retained, phase: 'saved' }, {}), false);
});

test('manual editing wins over a late semantic patch without losing new input text', () => {
  const request = begin(draft({ content: { title: '当前标题', location: '图书馆' } }));
  const manual = editor.editScheduleFields(request, { title: '手动修改' });
  const late = apply(manual, { title: '旧结果' });
  assert.equal(late.accepted, false);
  assert.equal(late.draft.title, '手动修改');
  assert.equal(late.draft.latestInputText, '本次输入');
  assert.equal(late.draft.location, '图书馆');
  assert.equal(late.draft.phase, 'editing');
});

test('cancel, replacement operation and saved state reject stale input, edit mode stays attached', () => {
  const ref = { sourceEventId: 'original', occurrenceDate: '2026-10-28' };
  const first = begin(draft({ eventRef: ref, eventRevision: 9 }));
  const second = begin(first, 'replace', 'input-2');
  const old = editor.applyScheduleEditorInput(second, { id: 'input-1', baseRevision: 1, sequence: 1 }, { title: '旧' });
  assert.strictEqual(old.draft, second); assert.equal(old.accepted, false);
  const replaced = apply(second, editor.initialScheduleEditorChanges({ title: '新标题', start_date: '2026-10-29',
    date_resolution: 'resolved', event_type: 'once', category: '其他' })).draft;
  assert.equal(replaced.mode, 'edit'); assert.deepEqual(replaced.eventRef, ref);
  const cancelled = editor.cancelScheduleEditorInput(first);
  assert.equal(editor.applyScheduleEditorInput(cancelled, { id: 'input-1', baseRevision: 1, sequence: 1 }, { title: '迟到' }).accepted, false);
  const saving = { ...cancelled, phase: 'saving' };
  assert.strictEqual(editor.editScheduleFields(saving, { title: '不能变更' }), saving);
  assert.strictEqual(begin(saving), saving);
});

test('replacement requires complete content, resets omitted fields, and keeps the same durable identity', () => {
  const seed = draft({ eventRef: { sourceEventId: 'original', occurrenceDate: '2026-10-28' },
    eventRevision: 9, recurrenceScope: 'following', sourceInputJobId: 'job-1', sourceKind: 'hardware_voice',
    content: { title: '原事项', endDate: '2026-10-30', location: '旧地点', notes: '旧备注',
      time: exact('09:23', '10:07'), category: '工作', repeat: 'weekly', recurrenceInterval: 2,
      recurrenceWeekdays: [1, 3], recurrenceUntilDate: '2026-12-30', reminderMinutes: 10 } });
  const pending = begin(seed, 'replace');
  assert.throws(() => apply(pending, { title: '不完整结果' }));
  assert.equal(pending.location, '旧地点');
  const changes = editor.initialScheduleEditorChanges({ title: '新事项', start_date: '', date_resolution: 'omitted',
    event_type: 'once', category: '生活' }, pending.pendingInput);
  const result = apply(pending, changes);
  assert.equal(result.accepted, true);
  assert.equal(result.draft.title, '新事项');
  assert.equal(result.draft.startDate, '2026-10-28');
  for (const [key, value] of Object.entries({ endDate: null, location: '', notes: '', time: time.unspecifiedScheduleTime(),
    repeat: 'once', recurrenceInterval: 1, recurrenceWeekdays: [], recurrenceUntilDate: null, reminderMinutes: null })) {
    assert.deepEqual(result.draft[key], value, key);
  }
  for (const key of ['id', 'mode', 'eventRef', 'eventRevision', 'recurrenceScope', 'sourceInputJobId', 'sourceKind', 'saveRequestId']) {
    assert.deepEqual(result.draft[key], seed[key], key);
  }
  const cancelled = editor.cancelScheduleEditorInput(pending);
  assert.equal(apply(pending, changes).draft.saveRequestId, 'save-1');
  assert.equal(editor.applyScheduleEditorInput(cancelled, { id: 'input-1', sequence: 1, baseRevision: 1 }, changes).accepted, false);
  const manual = editor.editScheduleFields(pending, { location: '用户新地点' });
  assert.equal(apply(manual, changes).accepted, false);
  assert.equal(apply(manual, changes).draft.location, '用户新地点');
});

test('replacement clears only legacy time semantics, can undo equal-valued fields, and respects later manual ownership', () => {
  const seed = editor.editScheduleFields(draft({ content: { legacyIsAllDay: true } }), { title: '还书', location: '旧地点' });
  const changes = editor.initialScheduleEditorChanges({ title: '还书', start_date: '2026-10-28', date_resolution: 'resolved',
    event_type: 'once', category: '其他' });
  const replaced = apply(begin(seed, 'replace'), changes).draft;
  assert.equal(replaced.legacyIsAllDay, false);
  assert.equal(replaced.fieldOrigins.title, 'explicit');
  const restored = editor.undoScheduleEditorInput(editor.recoverScheduleEditorDraft(JSON.parse(JSON.stringify(replaced))));
  assert.equal(restored.title, '还书');
  assert.equal(restored.fieldOrigins.title, 'manual');
  assert.equal(restored.location, '旧地点');
  assert.equal(restored.legacyIsAllDay, true);
  const manual = editor.editScheduleFields(replaced, { title: '手动新标题' });
  const undone = editor.undoScheduleEditorInput(manual);
  assert.equal(undone.title, '手动新标题');
  assert.equal(undone.location, '旧地点');
  assert.equal(undone.legacyIsAllDay, true);
  const manualTime = editor.editScheduleFields(replaced, { time: period('night') });
  const keepTime = editor.undoScheduleEditorInput(manualTime);
  assert.equal(keepTime.time.period, 'night');
  assert.equal(keepTime.legacyIsAllDay, false);
  const legacyOnly = draft({ content: { title: '还书', legacyIsAllDay: true } });
  const reset = apply(begin(legacyOnly, 'replace'), changes).draft;
  assert.equal(reset.revision, legacyOnly.revision + 1);
  const inverse = editor.undoScheduleEditorInput(reset);
  assert.equal(inverse.revision, reset.revision + 1);
  assert.equal(inverse.legacyIsAllDay, true);
});

test('semantic changes are atomic, clear invalid reminders, and never add a hidden end time', () => {
  const initial = draft({ content: { time: exact('09:23'), reminderMinutes: 10 } });
  assert.equal(editor.scheduleEditorEventValue(initial).endTime, undefined);
  const pending = begin(initial);
  assert.throws(() => apply(pending, { title: '不应部分更新', time: exact('09:23', '08:00') }));
  assert.equal(pending.title, '');
  const changed = apply(pending, { time: period('night') }).draft;
  assert.equal(changed.reminderMinutes, null);
  assert.equal(changed.time.startTime, null);
  assert.equal(changed.legacyIsAllDay, false);
  assert.equal(changed.revision, 2);
});

test('empty editor weekday selection projects to an absent optional event field, never an invalid empty cache value', () => {
  assert.equal(editor.scheduleEditorEventValue(draft()).recurrenceWeekdays, undefined);
  const selected = draft({ content: { repeat: 'weekly', recurrenceWeekdays: [1, 3] } });
  assert.deepEqual(editor.scheduleEditorEventValue(selected).recurrenceWeekdays, [1, 3]);
});

test('undo does not overwrite later manual values or leave an invalid coupled time/reminder', () => {
  const initial = draft({ content: { title: '旧标题', time: exact('09:23'), reminderMinutes: 10 } });
  const changed = apply(begin(initial), { title: '语音标题', time: period('night') }).draft;
  const manual = editor.editScheduleFields(changed, { title: '用户标题' });
  const undone = editor.undoScheduleEditorInput(manual);
  assert.equal(undone.title, '用户标题'); assert.equal(undone.time.startTime, '09:23');
  assert.equal(undone.reminderMinutes, 10); assert.equal(undone.lastUndo, null);
  const conflict = editor.editScheduleFields(changed, { time: time.unspecifiedScheduleTime() });
  const kept = editor.undoScheduleEditorInput(conflict);
  assert.equal(kept.time.precision, 'unspecified'); assert.equal(kept.reminderMinutes, null);
  const legacy = draft({ content: { legacyIsAllDay: true } });
  const updated = apply(begin(legacy), { time: period('morning') }).draft;
  assert.equal(editor.undoScheduleEditorInput(updated).legacyIsAllDay, true);
});

test('undo preserves later manual ownership even when the user returns to the generated value', () => {
  const generated = apply(begin(draft({ content: { title: '原来的标题', location: '原来的地点' } })),
    { title: '讨论需求', location: '语音地点' }).draft;
  const changed = editor.editScheduleFields(generated, { title: '讨论排期' });
  const returned = editor.editScheduleFields(changed, { title: '讨论需求' });
  assert.equal(returned.fieldOrigins.title, 'manual');
  assert.equal(returned.revision, 4);
  const restored = editor.recoverScheduleEditorDraft(JSON.parse(JSON.stringify(returned)));
  const undone = editor.undoScheduleEditorInput(restored);
  assert.equal(undone.title, '讨论需求', 'matching text does not surrender the later manual decision');
  assert.equal(undone.fieldOrigins.title, 'manual');
  assert.equal(undone.location, '原来的地点', 'an unrelated untouched field remains reversible');
  assert.equal(undone.lastUndo, null);

  const onlyTitle = apply(begin(draft({ content: { title: '原来的标题' } })), { title: '讨论需求' }).draft;
  const manualTitle = editor.editScheduleFields(editor.editScheduleFields(onlyTitle, { title: '讨论排期' }), { title: '讨论需求' });
  const noContentChange = editor.undoScheduleEditorInput(manualTitle);
  assert.equal(noContentChange.title, '讨论需求');
  assert.equal(noContentChange.revision, manualTitle.revision);
  assert.equal(noContentChange.stateRevision, manualTitle.stateRevision + 1);
});

test('undo never erases a manually owned value through an implicit dependency', () => {
  const initial = draft({ content: { time: period('night') } });
  const generated = apply(begin(initial), { time: exact('09:23'), reminderMinutes: 10 }).draft;
  const manualReminder = editor.editScheduleFields(editor.editScheduleFields(generated,
    { reminderMinutes: 5 }), { reminderMinutes: 10 });
  assert.equal(manualReminder.fieldOrigins.reminderMinutes, 'manual');
  const undone = editor.undoScheduleEditorInput(manualReminder);
  assert.equal(undone.time.startTime, '09:23', 'cannot restore period by silently clearing the manual reminder');
  assert.equal(undone.reminderMinutes, 10);
  assert.equal(undone.fieldOrigins.reminderMinutes, 'manual');
  assert.equal(undone.revision, manualReminder.revision);
  assert.equal(undone.lastUndo, null);
});

test('manual ownership protects every editable field after a value round trip', () => {
  const cases = [
    ['title', '原主题', '新主题', '另一主题'],
    ['location', '原地点', '新地点', '另一地点'],
    ['notes', '原备注', '新备注', '另一备注'],
    ['startDate', '2026-10-28', '2026-10-29', '2026-10-30'],
    ['endDate', '2026-10-29', '2026-10-30', '2026-10-31'],
    ['time', exact('09:23'), exact('10:07'), period('night')],
    ['category', '其他', '工作', '生活'],
    ['repeat', 'weekly', 'daily', 'monthly'],
    ['recurrenceInterval', 1, 2, 3],
    ['recurrenceWeekdays', [1], [1, 3], [2]],
    ['recurrenceUntilDate', '2026-11-01', '2026-11-02', '2026-11-03'],
    ['reminderMinutes', 10, 15, 30],
  ];
  for (const [field, before, generated, intermediate] of cases) {
    const initial = draft({ content: { repeat: 'weekly', time: exact('09:23'), [field]: before } });
    const observed = apply(begin(initial), { [field]: generated }).draft;
    const manual = editor.editScheduleFields(editor.editScheduleFields(observed, { [field]: intermediate }), { [field]: generated });
    const originalJson = JSON.stringify(manual);
    Object.freeze(manual); Object.freeze(manual.fieldOrigins);
    const undone = editor.undoScheduleEditorInput(manual);
    assert.deepEqual(undone[field], generated, field);
    assert.equal(undone.fieldOrigins[field], 'manual', field);
    assert.equal(JSON.stringify(manual), originalJson, `${field}: inverse is immutable`);
    assert.equal(undone.lastUndo, null);
  }
});

test('draft restore keeps unsaved text but does not pretend a lost model process is running', () => {
  const pending = begin(draft());
  const restored = editor.recoverScheduleEditorDraft(JSON.parse(JSON.stringify(pending)));
  assert.equal(restored.phase, 'editing'); assert.equal(restored.pendingInput, null);
  assert.equal(restored.latestInputText, '本次输入'); assert.equal(restored.revision, pending.revision);
  assert.equal(restored.saveRequestId, 'save-1');
  const saving = { ...restored, phase: 'saving' };
  assert.strictEqual(editor.recoverScheduleEditorDraft(saving), saving, 'uncertain commits need receipt reconciliation');
});

function sqliteWrapper(filename) {
  return {
    raw: new DatabaseSync(filename), databasePath: filename,
    async execAsync(sql) { this.raw.exec(sql); },
    async getFirstAsync(sql, ...args) { return this.raw.prepare(sql).get(...args) ?? null; },
    async getAllAsync(sql, ...args) { return this.raw.prepare(sql).all(...args); },
    async runAsync(sql, ...args) { return this.raw.prepare(sql).run(...args); },
    async closeAsync() { if (this.raw.isOpen) this.raw.close(); },
  };
}
function databaseFixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'laoji-schedule-editor-'));
  const handles = [];
  let copies = 0;
  const expo = {
    async openDatabaseAsync(name) {
      const db = sqliteWrapper(path.join(directory, name)); handles.push(db);
      if (options.failDDL && name === 'laoji-schedule.db') {
        const original = db.execAsync;
        db.execAsync = function (sql) { if (sql.includes('CREATE TABLE IF NOT EXISTS schedule_editor_drafts')) throw Error('injected DDL error'); return original.call(this, sql); };
      }
      return db;
    },
    async backupDatabaseAsync({ sourceDatabase, destDatabase }) {
      copies++;
      destDatabase.raw.close();
      await backup(sourceDatabase.raw, destDatabase.databasePath);
      destDatabase.raw = new DatabaseSync(destDatabase.databasePath);
      if (options.failBackup) throw Error('injected incomplete backup');
    },
    async deleteDatabaseAsync(name) { fs.rmSync(path.join(directory, name), { force: true }); },
  };
  const load = loader({ 'expo-sqlite': expo, [path.resolve('src/theme/colors.ts')]: {},
    [path.resolve('src/services/diagnostics.ts')]: { diagnosticAudit() {} }, ...options.overrides });
  const database = load('src/data/db/openScheduleDatabase.ts');
  const repo = load('src/data/repositories/scheduleEditorRepository.ts');
  t.after(async () => { await database.closeScheduleDatabaseForTests();
    for (const db of handles) await db.closeAsync(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { load, database, repo, directory, copies: () => copies,
    adopt: raw => handles.push({ raw, async closeAsync() { if (raw.isOpen) raw.close(); } }) };
}

function seedV3(f) {
  const db = new DatabaseSync(path.join(f.directory, 'laoji-schedule.db'));
  // Existing v3 tables and their exact event_json values, no editor table.
  const sql = f.database.SCHEDULE_DATABASE_SCHEMA_SQL.split('CREATE TABLE IF NOT EXISTS schedule_editor_drafts')[0]
    .replace('VALUES (1, 4)', 'VALUES (1, 3)');
  db.exec(sql); db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA user_version=3');
  for (let i = 0; i < 3; i++) db.prepare(`INSERT INTO local_schedule_events
    (id,start_date,title,event_json,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?)`)
    .run(`original-${i}`, '2026-10-28', '用户原记录', JSON.stringify({ id: `original-${i}`, isAllDay: i === 1, startTime: i === 2 ? '09:23' : null }), 1, 1);
  f.adopt(db); // Keep its WAL live while the production initializer backs up.
}

const followupParams = { meetingId: 'legacy-meeting', canonicalMeetingId: 'canonical-meeting', actionId: 'canonical-action', clientRequestId: 'save-action' };
async function committedFollowup(f, extra = {}) {
  const initial = draft({ id: 'draft-action', saveRequestId: followupParams.clientRequestId,
    sourceKind: 'meeting_action', followup: followupParams, content: { title: '发送修订稿', time: exact('09:23') }, ...extra });
  await f.repo.createStoredScheduleEditorDraft(initial);
  const saving = { ...initial, phase: 'saving', stateRevision: initial.stateRevision + 1 };
  await f.repo.persistScheduleEditorDraft(saving, initial.stateRevision);
  const request = { draftId: initial.id, saveRequestId: initial.saveRequestId, stateRevision: saving.stateRevision };
  const ref = { sourceEventId: initial.id + '-event', occurrenceDate: initial.startDate };
  const event = { ...editor.scheduleEditorEventValue(saving), id: ref.sourceEventId, clientRequestId: initial.saveRequestId };
  await f.load('src/data/repositories/localScheduleRepository.ts').replaceLocalScheduleEvents([event], db =>
    f.repo.completeScheduleEditorSaveInTransaction(db, request, ref, event));
  return { request, event, saved: await f.repo.loadStoredScheduleEditorDraft(initial.id) };
}

test('adoption receipt persists across close/reopen; unique request reentry cannot seed or overwrite a second draft', async t => {
  const f = databaseFixture(t), { request, event, saved } = await committedFollowup(f);
  assert.equal((await f.repo.listSavedScheduleFollowups()).length, 1);
  await f.database.closeScheduleDatabaseForTests();
  assert.deepEqual((await f.repo.findScheduleEditorFollowup(followupParams)).followup.params, followupParams);
  const reentered = await f.repo.createStoredScheduleEditorDraft(draft({ id: 'another-route-id', saveRequestId: 'save-action',
    sourceKind: 'meeting_action', followup: followupParams, content: { title: '不要覆盖原日程' } }));
  assert.equal(reentered.id, saved.id); assert.equal(reentered.title, '发送修订稿');
  assert.equal(await f.repo.settleScheduleEditorFollowup(saved, 'pending', Date.now() + 1000), true);
  assert.equal(await f.repo.settleScheduleEditorFollowup(saved, 'linked'), false, 'stale attempt cannot settle another attempt');
  const pending = (await f.repo.listSavedScheduleFollowups())[0];
  assert.equal(pending.followup.attempts, 1); assert.equal(pending.stateRevision, saved.stateRevision);
  assert.equal(await f.repo.settleScheduleEditorFollowup(pending, 'linked'), true);
  assert.equal((await f.repo.listSavedScheduleFollowups()).length, 0);
  assert.equal((await f.repo.findCommittedScheduleEditorSave(request, event)).stateRevision, saved.stateRevision,
    'source completion must not invalidate an in-flight editor receipt');
  const db = await f.database.openScheduleDatabase();
  assert.equal((await db.getFirstAsync('SELECT count(*) AS n FROM local_schedule_events')).n, 1);
  assert.equal((await db.getFirstAsync('SELECT count(*) AS n FROM schedule_editor_drafts')).n, 1);
  await assert.rejects(f.repo.findScheduleEditorFollowup({ ...followupParams, actionId: 'another-action' }));
});

test('legacy unfinished adoption attaches only matching source metadata without changing content', async t => {
  const f = databaseFixture(t);
  const initial = draft({ saveRequestId: 'save-action', sourceKind: 'meeting_action', content: { title: '手动修改保留' } });
  await f.repo.createStoredScheduleEditorDraft(initial);
  const attached = await f.repo.loadStoredScheduleEditorDraft(initial.id, followupParams);
  assert.equal(attached.title, initial.title); assert.equal(attached.stateRevision, initial.stateRevision + 1);
  assert.deepEqual(attached.followup.params, followupParams);
  await assert.rejects(f.repo.persistScheduleEditorDraft({ ...attached, followup: undefined, stateRevision: attached.stateRevision + 1 }, attached.stateRevision));
  await assert.rejects(f.repo.findScheduleEditorFollowup({ ...followupParams, clientRequestId: 'other-request' }).then(value => { if (!value) throw Error('not found'); }));
});

for (const failure of ['transient', 'conflict', 'missing']) {
  test(`saved source completion recovers ${failure} without recreating or rewriting calendar events`, async t => {
    let calls = 0;
    const unavailable = class extends Error {};
    const conflict = class extends Error {};
    const f = databaseFixture(t, { overrides: {
      [path.resolve('src/application/meeting.ts')]: { LinkMeetingActionFollowupEventUseCase: class {
        async execute(input) {
          calls++; assert.equal(input.meetingId, 'canonical-meeting'); assert.equal(input.eventSourceId, 'draft-action-event');
          if (failure === 'transient' && calls === 1) throw Error('temporary local transaction failure');
          if (failure === 'conflict') throw new conflict();
          if (failure === 'missing') throw new unavailable();
        }
      } },
      [path.resolve('src/application/meeting/linkMeetingActionFollowupEvent.ts')]: {
        MeetingActionFollowupConflictError: conflict, MeetingActionFollowupUnavailableError: unavailable },
      [path.resolve('src/data/repositories/sqliteMeetingNoteRepository.ts')]: { sqliteMeetingNoteRepository: {} },
    } });
    const { event, saved } = await committedFollowup(f);
    const local = f.load('src/data/repositories/localScheduleRepository.ts');
    await local.replaceLocalScheduleEvents([{ ...event, title: '后来手动修改', startDate: '2026-11-12' }]);
    const service = f.load('src/services/meetingActionFollowup.ts');
    const first = service.reconcileSavedScheduleFollowups();
    assert.strictEqual(service.reconcileSavedScheduleFollowups(), first, 'only one in-flight source reconciler');
    const result = await first;
    if (failure === 'transient') {
      assert.ok(result.retryInMs > 0); assert.equal(calls, 1);
      await f.database.closeScheduleDatabaseForTests();
      await service.reconcileSavedScheduleFollowups(); assert.equal(calls, 1, 'backoff survives DB reopen');
      const db = await f.database.openScheduleDatabase();
      const row = await f.repo.loadStoredScheduleEditorDraft(saved.id);
      row.followup.retryAtMs = 0;
      await db.runAsync('UPDATE schedule_editor_drafts SET draft_json=? WHERE id=?', JSON.stringify(row), row.id);
      assert.equal((await service.reconcileSavedScheduleFollowups()).retryInMs, null); assert.equal(calls, 2);
      assert.equal((await f.repo.loadStoredScheduleEditorDraft(saved.id)).followup.state, 'linked');
    } else {
      assert.equal(result.retryInMs, null);
      assert.equal((await f.repo.loadStoredScheduleEditorDraft(saved.id)).followup.state, 'retired');
    }
    assert.equal((await local.loadLocalScheduleEvents()).length, 1);
    assert.equal((await local.loadLocalScheduleEvents())[0].title, '后来手动修改');
  });
}

test('a deleted calendar target retires source completion without linking or resurrecting it', async t => {
  const f = databaseFixture(t, { overrides: {
    [path.resolve('src/application/meeting.ts')]: { LinkMeetingActionFollowupEventUseCase: class {
      async execute() { assert.fail('deleted target cannot be linked'); }
    } },
    [path.resolve('src/data/repositories/sqliteMeetingNoteRepository.ts')]: { sqliteMeetingNoteRepository: {} },
    [path.resolve('src/application/meeting/linkMeetingActionFollowupEvent.ts')]: {
      MeetingActionFollowupConflictError: class extends Error {}, MeetingActionFollowupUnavailableError: class extends Error {} },
  } });
  const { saved } = await committedFollowup(f);
  const local = f.load('src/data/repositories/localScheduleRepository.ts');
  await local.replaceLocalScheduleEvents([]);
  assert.equal((await f.load('src/services/meetingActionFollowup.ts').reconcileSavedScheduleFollowups()).retryInMs, null);
  assert.equal((await f.repo.loadStoredScheduleEditorDraft(saved.id)).followup.state, 'retired');
  assert.equal((await local.loadLocalScheduleEvents()).length, 0);
});

test('a committed meeting link with an interrupted completion checkpoint replays the same source only', async t => {
  let linkedId = null, calls = 0, interrupted = false;
  const f = databaseFixture(t, { overrides: {
    [path.resolve('src/application/meeting.ts')]: { LinkMeetingActionFollowupEventUseCase: class {
      async execute(input) {
        calls++; if (linkedId) assert.equal(input.eventSourceId, linkedId);
        linkedId = input.eventSourceId;
      }
    } },
    [path.resolve('src/application/meeting/linkMeetingActionFollowupEvent.ts')]: {
      MeetingActionFollowupConflictError: class extends Error {}, MeetingActionFollowupUnavailableError: class extends Error {} },
    [path.resolve('src/data/repositories/sqliteMeetingNoteRepository.ts')]: { sqliteMeetingNoteRepository: {} },
  } });
  const { saved } = await committedFollowup(f);
  const settle = f.repo.settleScheduleEditorFollowup;
  f.repo.settleScheduleEditorFollowup = async (...args) => {
    if (!interrupted && args[1] === 'linked') { interrupted = true; throw Error('injected checkpoint interruption after meeting commit'); }
    return settle(...args);
  };
  const service = f.load('src/services/meetingActionFollowup.ts');
  assert.ok((await service.reconcileSavedScheduleFollowups()).retryInMs > 0);
  await f.database.closeScheduleDatabaseForTests();
  const pending = await f.repo.loadStoredScheduleEditorDraft(saved.id); pending.followup.retryAtMs = 0;
  await (await f.database.openScheduleDatabase()).runAsync('UPDATE schedule_editor_drafts SET draft_json=? WHERE id=?', JSON.stringify(pending), pending.id);
  assert.equal((await service.reconcileSavedScheduleFollowups()).retryInMs, null); assert.equal(calls, 2);
  assert.equal(linkedId, saved.savedEventRef.sourceEventId);
  assert.equal((await f.repo.loadStoredScheduleEditorDraft(saved.id)).followup.state, 'linked');
  assert.equal((await f.load('src/data/repositories/localScheduleRepository.ts').loadLocalScheduleEvents()).length, 1);
});

const hardwareSource = { purpose: 'schedule', deviceId: 'board', sourceCaptureId: 'capture-editor', recordingId: 'source-editor',
  audioChecksumSha256: `sha256:${'a'.repeat(64)}`, recordedAtMs: Date.parse('2026-10-28T02:00:00Z'), timeZone: 'Asia/Shanghai' };
async function receivedInput(f, parsed = {}) {
  const inputs = f.load('src/data/repositories/scheduleInputRepository.ts');
  const queued = await inputs.enqueueScheduleInput(hardwareSource);
  await inputs.updateScheduleInput(queued.id, { raw_text: '明晚七点二十三分去医院复查', title: '医院复查',
    start_date: '2026-10-29', end_date: null, start_time: '19:23', end_time: null, time_period: null,
    event_type: 'once', category: '健康', needs_clarification: false, ...parsed });
  return { inputs, job: (await inputs.listScheduleInputs('display'))[0] };
}

test('received hardware input opens one durable editor and repeated delivery never overwrites manual edits', async t => {
  const f = databaseFixture(t); seedV3(f);
  const { job } = await receivedInput(f);
  const initial = await f.repo.openScheduleInputEditorDraft(job);
  assert.equal(initial.sourceKind, 'hardware_voice'); assert.equal(initial.sourceInputJobId, job.id);
  assert.equal(initial.startDate, '2026-10-29'); assert.equal(initial.time.startTime, '19:23');
  assert.equal(initial.latestInputText, job.draft.raw_text);
  const manual = editor.editScheduleFields(initial, { title: '用户改过的事项', location: '社区医院' });
  assert.equal(await f.repo.persistScheduleEditorDraft(manual, initial.stateRevision), true);
  await f.database.closeScheduleDatabaseForTests();
  const reopened = await f.repo.openScheduleInputEditorDraft(job);
  assert.equal(reopened.id, initial.id); assert.equal(reopened.saveRequestId, initial.saveRequestId);
  assert.equal(reopened.title, manual.title); assert.equal(reopened.location, manual.location);
  const db = await f.database.openScheduleDatabase();
  assert.equal((await db.getFirstAsync('SELECT count(*) AS n FROM schedule_editor_drafts')).n, 1);
  assert.equal((await db.getFirstAsync('SELECT count(*) AS n FROM local_schedule_events')).n, 3);
});

test('dismissal retires the linked unsaved editor and a stale ready snapshot cannot resurrect it', async t => {
  const f = databaseFixture(t); seedV3(f);
  const { inputs, job } = await receivedInput(f);
  const initial = await f.repo.openScheduleInputEditorDraft(job);
  const unrelated = draft(); await f.repo.createStoredScheduleEditorDraft(unrelated);
  await inputs.finishScheduleInput(job.id, 'dismissed');
  assert.equal(await f.repo.loadStoredScheduleEditorDraft(initial.id), null);
  await assert.rejects(f.repo.openScheduleInputEditorDraft(job));
  assert.equal(await f.repo.loadStoredScheduleEditorDraft(initial.id), null);
  assert.equal((await f.repo.loadStoredScheduleEditorDraft(unrelated.id)).id, unrelated.id);
  const db = await f.database.openScheduleDatabase();
  const receipt = await db.getFirstAsync('SELECT * FROM schedule_input_jobs WHERE id=?', job.id);
  assert.equal(receipt.state, 'dismissed'); assert.equal(receipt.source_json, '{}'); assert.equal(receipt.draft_json, null);
  assert.equal((await db.getFirstAsync('SELECT count(*) AS n FROM local_schedule_events')).n, 3);
});

test('dismissal cannot downgrade saving/saved input and explicit retry preserves the original identity', async t => {
  const f = databaseFixture(t);
  const { inputs, job } = await receivedInput(f);
  const initial = await f.repo.openScheduleInputEditorDraft(job);
  const saving = { ...initial, phase: 'saving', stateRevision: initial.stateRevision + 1 };
  await f.repo.persistScheduleEditorDraft(saving, initial.stateRevision);
  await assert.rejects(inputs.finishScheduleInput(job.id, 'dismissed'), /正在保存/);
  const local = f.load('src/data/repositories/localScheduleRepository.ts');
  const ref = { sourceEventId: 'hardware-event', occurrenceDate: saving.startDate };
  const event = { ...editor.scheduleEditorEventValue(saving), id: ref.sourceEventId, color: '#000000', clientRequestId: saving.saveRequestId };
  const request = { draftId: saving.id, saveRequestId: saving.saveRequestId, stateRevision: saving.stateRevision };
  await local.replaceLocalScheduleEvents([event], transaction => f.repo.completeScheduleEditorSaveInTransaction(transaction, request, ref, event));
  await inputs.finishScheduleInput(job.id, 'dismissed');
  const db = await f.database.openScheduleDatabase();
  assert.equal((await db.getFirstAsync('SELECT state FROM schedule_input_jobs')).state, 'saved');
  assert.equal((await f.repo.openScheduleInputEditorDraft(job)).phase, 'saved');
  assert.equal((await db.getFirstAsync('SELECT count(*) AS n FROM local_schedule_events')).n, 1);
  const failed = await inputs.enqueueScheduleInput({ ...hardwareSource, sourceCaptureId: 'failed' });
  for (let n = 0; n < 5; n++) await inputs.deferScheduleInput(failed.id);
  await inputs.retryScheduleInput(failed.id);
  const retried = await db.getFirstAsync('SELECT * FROM schedule_input_jobs WHERE id=?', failed.id);
  assert.equal(retried.id, failed.id); assert.equal(retried.state, 'pending'); assert.equal(retried.attempts, 0);
  assert.equal(retried.retry_at_ms, 0); assert.deepEqual(JSON.parse(retried.source_json), { ...hardwareSource, sourceCaptureId: 'failed' });
  await inputs.retryScheduleInput(job.id);
  assert.equal((await db.getFirstAsync('SELECT state FROM schedule_input_jobs WHERE id=?', job.id)).state, 'saved');
});

test('SQLite migration backs up the live WAL with the backup API, keeps all original JSON and only copies once', async t => {
  const f = databaseFixture(t); seedV3(f);
  assert.ok(fs.statSync(path.join(f.directory, 'laoji-schedule.db-wal')).size > 0);
  const db = await f.database.openScheduleDatabase();
  assert.equal((await db.getFirstAsync('PRAGMA user_version')).user_version, 4);
  const rows = await db.getAllAsync('SELECT id,event_json FROM local_schedule_events ORDER BY id');
  const snapshot = new DatabaseSync(path.join(f.directory, f.database.SCHEDULE_PRE_EDITOR_BACKUP_NAME));
  assert.deepEqual(snapshot.prepare('SELECT id,event_json FROM local_schedule_events ORDER BY id').all(), rows);
  assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(snapshot.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); snapshot.close();
  assert.equal((await db.getFirstAsync('SELECT * FROM schedule_database_migrations')).event_count, 3);
  await f.database.closeScheduleDatabaseForTests(); await f.database.openScheduleDatabase();
  assert.equal(f.copies(), 1);
});

test('failed backup/DDL never upgrades or wipes the source database', async t => {
  for (const failure of ['failBackup', 'failDDL']) {
    const f = databaseFixture(t, { [failure]: true }); seedV3(f);
    await assert.rejects(f.database.openScheduleDatabase(), /injected/);
    const original = new DatabaseSync(path.join(f.directory, 'laoji-schedule.db'));
    assert.equal(original.prepare('PRAGMA user_version').get().user_version, 3);
    assert.equal(original.prepare('SELECT count(*) AS n FROM local_schedule_events').get().n, 3);
    assert.equal(original.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='schedule_editor_drafts'").get().n, 0);
    original.close();
  }
});

test('actual SQLite draft CAS orders phase writes and binds one hardware input to one draft', async t => {
  const f = databaseFixture(t);
  const initial = draft({ sourceInputJobId: 'hardware-job' });
  await f.repo.createStoredScheduleEditorDraft(initial);
  const duplicate = await f.repo.createStoredScheduleEditorDraft(draft({ id: 'duplicate', saveRequestId: 'other', sourceInputJobId: 'hardware-job' }));
  assert.equal(duplicate.id, initial.id);
  const pending = begin(initial);
  assert.equal(await f.repo.persistScheduleEditorDraft(pending, initial.stateRevision), true);
  const manual = editor.editScheduleFields(pending, { title: '手改' });
  assert.equal(await f.repo.persistScheduleEditorDraft(manual, pending.stateRevision), true);
  assert.equal(await f.repo.persistScheduleEditorDraft({ ...pending, stateRevision: 99 }, initial.stateRevision), false);
  const recovered = await f.repo.loadStoredScheduleEditorDraft(initial.id);
  assert.equal(recovered.title, '手改'); assert.equal(recovered.phase, 'editing');
  assert.equal(recovered.latestInputText, '本次输入');
  assert.equal(await f.repo.discardStoredScheduleEditorDraft(initial.id, pending.stateRevision), false);
  assert.equal(await f.repo.discardStoredScheduleEditorDraft(initial.id, recovered.stateRevision), true);
  assert.equal((await f.repo.listUnfinishedScheduleEditorDrafts()).length, 0);
});

test('SQLite close/reopen retains manual ownership and undo cannot overwrite a returned value', async t => {
  const f = databaseFixture(t);
  const initial = draft({ content: { title: '原来的标题', location: '原来的地点' } });
  await f.repo.createStoredScheduleEditorDraft(initial);
  const generated = apply(begin(initial), { title: '讨论需求', location: '语音地点' }).draft;
  const manual = editor.editScheduleFields(editor.editScheduleFields(generated, { title: '讨论排期' }), { title: '讨论需求' });
  assert.equal(await f.repo.persistScheduleEditorDraft(manual, initial.stateRevision), true);
  await f.database.closeScheduleDatabaseForTests();
  const reopened = await f.repo.loadStoredScheduleEditorDraft(initial.id);
  assert.equal(reopened.fieldOrigins.title, 'manual');
  assert.equal(reopened.title, '讨论需求');
  const undone = editor.undoScheduleEditorInput(reopened);
  assert.equal(undone.title, '讨论需求');
  assert.equal(undone.location, '原来的地点');
  assert.equal(await f.repo.persistScheduleEditorDraft(undone, reopened.stateRevision), true);
  await f.database.closeScheduleDatabaseForTests();
  const persisted = await f.repo.loadStoredScheduleEditorDraft(initial.id);
  assert.equal(persisted.title, '讨论需求');
  assert.equal(persisted.fieldOrigins.title, 'manual');
  assert.equal(persisted.location, '原来的地点');
  assert.equal(persisted.lastUndo, null);
});

test('SQLite replacement recovery keeps old content, and committed replacement retains one reversible draft', async t => {
  const f = databaseFixture(t);
  const seed = draft({ eventRef: { sourceEventId: 'original', occurrenceDate: '2026-10-28' }, eventRevision: 3,
    content: { title: '旧事项', location: '旧地点', repeat: 'weekly', recurrenceWeekdays: [1, 3] } });
  await f.repo.createStoredScheduleEditorDraft(seed);
  const pending = begin(seed, 'replace');
  assert.equal(await f.repo.persistScheduleEditorDraft(pending, seed.stateRevision), true);
  await f.database.closeScheduleDatabaseForTests();
  const recovered = await f.repo.loadStoredScheduleEditorDraft(seed.id);
  assert.equal(recovered.title, '旧事项'); assert.equal(recovered.location, '旧地点');
  assert.equal(recovered.phase, 'editing'); assert.equal(recovered.pendingInput, null);
  const next = apply(begin(recovered, 'replace', 'replacement-2'), editor.initialScheduleEditorChanges({
    title: '新事项', start_date: '2026-10-29', date_resolution: 'resolved', event_type: 'once', category: '生活' })).draft;
  assert.equal(await f.repo.persistScheduleEditorDraft(next, recovered.stateRevision), true);
  await f.database.closeScheduleDatabaseForTests();
  const reopened = await f.repo.loadStoredScheduleEditorDraft(seed.id);
  assert.equal(reopened.title, '新事项'); assert.equal(reopened.location, '');
  assert.equal(reopened.repeat, 'once'); assert.deepEqual(reopened.eventRef, seed.eventRef);
  const undone = editor.undoScheduleEditorInput(reopened);
  assert.equal(undone.title, '旧事项'); assert.equal(undone.location, '旧地点');
  assert.equal(undone.repeat, 'weekly'); assert.deepEqual(undone.recurrenceWeekdays, [1, 3]);
  const db = await f.database.openScheduleDatabase();
  assert.equal((await db.getFirstAsync('SELECT count(*) AS n FROM schedule_editor_drafts')).n, 1);
  assert.equal((await db.getFirstAsync('SELECT count(*) AS n FROM local_schedule_events')).n, 0);
});

test('event, saved draft and hardware receipt commit atomically and replay one existing event', async t => {
  const f = databaseFixture(t);
  const local = f.load('src/data/repositories/localScheduleRepository.ts');
  const db = await f.database.openScheduleDatabase();
  await db.runAsync(`INSERT INTO schedule_input_jobs (id,source_sha256,source_json,state,created_at_ms,updated_at_ms)
    VALUES ('hardware-job','hash','{}','ready',1,1)`);
  const initial = draft({ sourceInputJobId: 'hardware-job', content: { title: '已确认事项', time: exact('09:23') } });
  await f.repo.createStoredScheduleEditorDraft(initial);
  const saving = { ...initial, phase: 'saving', stateRevision: 2 };
  await f.repo.persistScheduleEditorDraft(saving, 1);
  const request = { draftId: initial.id, saveRequestId: initial.saveRequestId, stateRevision: 2 };
  const ref = { sourceEventId: 'created-event', occurrenceDate: initial.startDate };
  const event = { ...editor.scheduleEditorEventValue(saving), id: ref.sourceEventId, color: '#000000', clientRequestId: initial.saveRequestId };
  let receipt;
  await local.replaceLocalScheduleEvents([event], async transaction => {
    receipt = await f.repo.completeScheduleEditorSaveInTransaction(transaction, request, ref, event);
  });
  assert.equal(receipt.stateRevision, 3);
  const restored = await f.repo.loadStoredScheduleEditorDraft(initial.id);
  assert.equal(restored.phase, 'saved'); assert.deepEqual(restored.savedEventRef, ref);
  assert.equal((await db.getFirstAsync('SELECT state FROM schedule_input_jobs')).state, 'saved');
  assert.deepEqual(await f.repo.completeStoredScheduleEditorSave(request, ref, event), receipt);
  assert.equal((await db.getFirstAsync('SELECT count(*) AS n FROM local_schedule_events')).n, 1);
  await assert.rejects(f.repo.completeStoredScheduleEditorSave(request, ref, { ...event, title: '同请求不同内容' }));
  await local.replaceLocalScheduleEvents([{ ...event, title: '保存后另一次手动修改' }]);
  assert.deepEqual(await f.repo.findCommittedScheduleEditorSave(request, event), receipt);
  const afterReplay = await local.loadLocalScheduleEvents();
  assert.equal(afterReplay[0].title, '保存后另一次手动修改');
  await assert.rejects(f.repo.findCommittedScheduleEditorSave(request, { ...event, title: '同请求不同内容' }));
});

test('a rejected save rolls back replacement event rows as well as draft/job completion', async t => {
  const f = databaseFixture(t); seedV3(f);
  const db = await f.database.openScheduleDatabase();
  const local = f.load('src/data/repositories/localScheduleRepository.ts');
  const initial = draft({ sourceInputJobId: 'missing-job', content: { title: '测试提交' } });
  await f.repo.createStoredScheduleEditorDraft(initial);
  const saving = { ...initial, phase: 'saving', stateRevision: 2 };
  await f.repo.persistScheduleEditorDraft(saving, 1);
  const request = { draftId: initial.id, saveRequestId: initial.saveRequestId, stateRevision: 2 };
  const ref = { sourceEventId: 'new-event', occurrenceDate: initial.startDate };
  const event = { ...editor.scheduleEditorEventValue(saving), id: ref.sourceEventId, color: '#000000', clientRequestId: initial.saveRequestId };
  await assert.rejects(local.replaceLocalScheduleEvents([event], transaction =>
    f.repo.completeScheduleEditorSaveInTransaction(transaction, request, ref, event)), /尚未准备/);
  assert.equal((await db.getFirstAsync('SELECT count(*) AS n FROM local_schedule_events')).n, 3);
  assert.equal((await db.getFirstAsync('SELECT state FROM schedule_editor_drafts')).state, 'saving');
  const retryable = await f.repo.loadStoredScheduleEditorDraft(initial.id);
  assert.equal(retryable.phase, 'editing'); assert.equal(retryable.saveRequestId, initial.saveRequestId);
  assert.equal(retryable.title, initial.title);
});

test('edit mutation keeps source identity and returns the resulting occurrence across scopes', () => {
  const mutate = simple('src/services/guestRecurrenceEdit.ts').applyGuestRecurrenceEdit;
  const recurrence = simple('src/utils/eventRecurrence.ts');
  for (const [repeat, scope, nextRepeat = repeat] of [['once','series'], ['daily','series'], ['daily','series','once'],
    ['daily','occurrence'], ['daily','following'], ['weekly','series'], ['monthly','series'], ['yearly','series']]) {
    const base = { id: 'stable', sourceEventId: 'stable', occurrenceDate: '2026-10-28', startDate: '2026-10-28',
      title: '旧安排', repeat, timePrecision: 'unspecified', color: '#000000', eventRevision: 4 };
    const ref = { sourceEventId: 'stable', occurrenceDate: repeat === 'daily' ? '2026-10-29' : '2026-10-28' };
    const target = recurrence.resolveEventReference([base], ref);
    const validated = { title: '新安排', startDate: '2026-11-04', endDate: '2026-11-06', repeat: nextRepeat,
      timePrecision: 'exact', startTime: '14:03', color: '#000000', eventRevision: 5 };
    const result = mutate({ events: [base], target, ref, scope, validated, segmentId: 'new-segment' });
    const expectedRef = { sourceEventId: 'stable', occurrenceDate: scope === 'series' ? '2026-11-04' : ref.occurrenceDate };
    assert.deepEqual(result.eventRef, expectedRef, `${repeat}/${scope}`);
    const changed = recurrence.resolveEventReference(result.events, result.eventRef);
    assert.ok(changed, `${repeat}/${scope} result must resolve`);
    assert.equal(changed.startDate, '2026-11-04'); assert.equal(changed.endDate, '2026-11-06');
    assert.equal(changed.title, '新安排'); assert.equal(changed.startTime, '14:03');
    assert.equal(changed.sourceEventId, 'stable');
    if (repeat === 'once') { assert.equal(result.events.length, 1); assert.equal(result.events[0].id, 'stable'); }
  }
});

test('editing a spanning event respects the new end date and explicit removal', () => {
  const mutate = simple('src/services/guestRecurrenceEdit.ts').applyGuestRecurrenceEdit;
  const original = { id: 'stable', sourceEventId: 'stable', occurrenceDate: '2026-10-28', startDate: '2026-10-28',
    endDate: '2026-10-30', spanning: true, title: '旧安排', repeat: 'once', color: '#000000' };
  const ref = { sourceEventId: 'stable', occurrenceDate: '2026-10-28' };
  for (const endDate of [undefined, '2026-11-08']) {
    const result = mutate({ events: [original], target: original, ref, scope: 'series', segmentId: 'unused',
      validated: { ...original, startDate: '2026-11-04', endDate } });
    assert.equal(result.events[0].endDate, endDate);
    assert.equal(result.events[0].spanning, endDate !== undefined);
  }
});

test('edited save receipt retains old target fence but restores and replays the committed new occurrence', async t => {
  const f = databaseFixture(t);
  const local = f.load('src/data/repositories/localScheduleRepository.ts');
  const recurrence = f.load('src/utils/eventRecurrence.ts');
  const mutate = f.load('src/services/guestRecurrenceEdit.ts').applyGuestRecurrenceEdit;
  const oldRef = { sourceEventId: 'stable-event', occurrenceDate: '2026-10-28' };
  const initial = draft({ eventRef: oldRef, eventRevision: 4, content: { title: '旧安排', location: '旧地点' } });
  await f.repo.createStoredScheduleEditorDraft(initial);
  const replaced = apply(begin(initial, 'replace'), editor.initialScheduleEditorChanges({
    title: '新安排', start_date: '2026-11-04', start_time: '14:03', date_resolution: 'resolved', event_type: 'once', category: '生活' })).draft;
  const saving = { ...replaced, phase: 'saving', stateRevision: replaced.stateRevision + 1 };
  await f.repo.persistScheduleEditorDraft(saving, initial.stateRevision);
  const request = { draftId: initial.id, saveRequestId: initial.saveRequestId, stateRevision: saving.stateRevision };
  const original = { ...editor.scheduleEditorEventValue(initial), id: oldRef.sourceEventId,
    sourceEventId: oldRef.sourceEventId, occurrenceDate: oldRef.occurrenceDate, color: '#000000', eventRevision: 4 };
  const changed = { ...editor.scheduleEditorEventValue(saving), color: '#000000', eventRevision: 5 };
  const result = mutate({ events: [original], target: original, ref: oldRef, scope: 'series', validated: changed, segmentId: 'unused' });
  await local.replaceLocalScheduleEvents([original]);
  for (const [previousRevision, outcome] of [[5, result.eventRef], [4, { ...result.eventRef, sourceEventId: 'another-event' }],
    [4, { ...result.eventRef, occurrenceDate: '2026-11-05' }]]) {
    await assert.rejects(local.replaceLocalScheduleEvents(result.events, transaction =>
      f.repo.completeScheduleEditorSaveInTransaction(transaction, request, oldRef, changed, previousRevision, outcome)));
    const unchanged = await local.loadLocalScheduleEvents();
    assert.equal(unchanged.length, 1); assert.equal(unchanged[0].title, '旧安排'); assert.equal(unchanged[0].startDate, original.startDate);
  }
  let receipt;
  await local.replaceLocalScheduleEvents(result.events, transaction =>
    f.repo.completeScheduleEditorSaveInTransaction(transaction, request, oldRef, changed, 4, result.eventRef).then(value => { receipt = value; }));
  assert.deepEqual(receipt.eventRef, { sourceEventId: oldRef.sourceEventId, occurrenceDate: '2026-11-04' });
  await f.database.closeScheduleDatabaseForTests();
  const restored = await f.repo.loadStoredScheduleEditorDraft(initial.id);
  assert.equal(restored.phase, 'saved'); assert.deepEqual(restored.eventRef, oldRef);
  assert.deepEqual(restored.savedEventRef, receipt.eventRef);
  assert.deepEqual(await f.repo.findCommittedScheduleEditorSave(request, changed), receipt);
  const events = await local.loadLocalScheduleEvents();
  assert.equal(events.length, 1); assert.equal(events[0].id, oldRef.sourceEventId);
  assert.equal(recurrence.resolveEventReference(events, oldRef), null);
  assert.equal(recurrence.resolveEventReference(events, receipt.eventRef).title, '新安排');
  // Another legitimate later write is not reverted by replaying this receipt.
  await local.replaceLocalScheduleEvents([{ ...events[0], title: '后续手改' }]);
  assert.deepEqual(await f.repo.findCommittedScheduleEditorSave(request, changed), receipt);
  assert.equal((await local.loadLocalScheduleEvents())[0].title, '后续手改');
});
