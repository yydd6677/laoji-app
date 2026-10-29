const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const React = require('react');
const Renderer = require('react-test-renderer');
global.IS_REACT_ACT_ENVIRONMENT = true;
const { act } = Renderer;

// RN hosts, navigation overlays and theme are explicit seams, not claims of
// physical input/IME/scroll validation. Real component state/actions run here.
function fixture() {
  const calls = [], cache = new Map();
  const C = { body: '#fff', text: '#101010', sub: '#666', faint: '#888', primary: '#2766c9', red: '#b22', divider: '#ddd' };
  const modules = {
    react: React,
    'react-native': { View: 'view', Text: 'text', TextInput: 'input', ScrollView: 'scroll', ActivityIndicator: 'spinner',
      KeyboardAvoidingView: 'keyboard', Platform: { OS: 'web' }, StyleSheet: { create: x => x, hairlineWidth: 1 },
      FlatList: React.forwardRef((props, ref) => { React.useImperativeHandle(ref, () => ({ scrollToIndex() {} })); return React.createElement('list', props); }) },
    '@expo/vector-icons/Ionicons': { default: 'icon', __esModule: true },
  };
  function load(relative) {
    const file = path.resolve(relative);
    if (cache.has(file)) return cache.get(file).exports;
    const mod = { exports: {} }; cache.set(file, mod);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true,
    } }).outputText;
    new Function('require', 'module', 'exports', code)(name => {
      if (name in modules) return modules[name];
      if (name.includes('ThemeProvider')) return { useTheme: () => ({ colors: C }) };
      if (name.endsWith('MotionPressable')) return { MotionPressable: 'press' };
      if (name.endsWith('CalendarTitleBar')) return { CalendarEditTitleBar: 'titlebar', CalendarTextTitleBar: 'subbar' };
      if (name.endsWith('CalendarSlidePage')) return { CalendarSlidePage: props => props.visible ? React.createElement('slide', props) : null };
      if (name.endsWith('notifications')) return { labelForReminder: value => value == null ? '不提醒' : `提前${value}分钟` };
      if (name.endsWith('eventDraftValidation')) return { isValidEventDate: value => /^\d{4}-\d{2}-\d{2}$/.test(value) };
      if (name.endsWith('scheduleEventTime')) return { eventTimeLabel: value => value.timePrecision === 'period' ? value.timePeriod : value.startTime ?? '未设置' };
      if (!name.startsWith('.')) throw Error(`unexpected import ${name}`);
      const target = path.resolve(path.dirname(file), name);
      return load(fs.existsSync(target + '.tsx') ? target + '.tsx' : target + '.ts');
    }, mod, mod.exports);
    return mod.exports;
  }
  const Surface = load('src/components/ScheduleEditorSurface.tsx').ScheduleEditorSurface;
  let snapshot = { schemaVersion: 1, state: 'ready', editing: false, recurring: false, recurrenceException: false,
    recurrenceScope: null, saving: false, dirty: false, locating: false,
    draft: { title: '还书', startDate: '2026-10-28', endDate: '2026-10-28', startTime: '09:23', endTime: null,
      timePrecision: 'exact', timePeriod: null, isAllDay: false, location: '图书馆', notes: '带读者证',
      repeat: 'once', recurrenceUntilDate: null, reminderMinutes: 10 },
    input: { phase: 'editing', text: '', error: '', canUndo: false, level: 0, durationMs: 0 } };
  let tree;
  const render = () => React.createElement(Surface, { snapshot, onAction: action => {
    calls.push(action);
    if (action.type === 'draftChange') snapshot = { ...snapshot, draft: action.draft };
    tree.update(render());
  } });
  return { calls, get tree() { return tree; }, get snapshot() { return snapshot; },
    async mount() { await act(async () => { tree = Renderer.create(render()); }); },
    async run(fn) { await act(async () => { fn(); }); },
    async update(value) { await act(async () => { snapshot = { ...snapshot, ...value }; tree.update(render()); }); },
    press(label) { const found = tree.root.findAllByType('press').filter(x => x.props.accessibilityLabel === label); assert.equal(found.length, 1, label); found[0].props.onPress(); },
    input(id) { return tree.root.findByProps({ testID: id, accessibilityLabel: id === 'event-editor-title' ? '主题' : id === 'event-editor-location' ? '地点' : '日程输入' }); },
    done() { tree.root.findByType('subbar').props.onRight(); },
    cancel() { tree.root.findByType('subbar').props.onLeft(); },
    async close() { await act(async () => { tree.unmount(); }); },
  };
}

test('portable editor uses the same action contract, retains title input and keeps save single', async () => {
  const f = fixture(); await f.mount();
  try {
    const title = f.input('event-editor-title');
    await f.run(() => title.props.onChangeText('还书并续借'));
    await f.update({ input: { ...f.snapshot.input, phase: 'parsing', text: '改到下午' } });
    assert.equal(f.input('event-editor-title'), title);
    assert.equal(f.tree.root.findByType('titlebar').props.saveEnabled, false);
    assert.equal(f.tree.root.findAllByType('spinner').length, 1);
    await f.update({ input: { ...f.snapshot.input, phase: 'editing' } });
    await f.run(() => f.tree.root.findByType('titlebar').props.onSave());
    assert.equal(f.calls.filter(x => x.type === 'save').length, 1);
    assert.equal(f.calls.at(-1).draft.title, '还书并续借');
  } finally { await f.close(); }
});

test('time picker preserves minute 23, no end placeholder, opening and cancel never commit', async () => {
  const f = fixture(); await f.mount();
  try {
    await f.run(() => f.press('时间'));
    const wheel = f.tree.root.findByProps({ accessibilityLabel: '分钟', accessibilityRole: 'adjustable' });
    assert.equal(wheel.props.accessibilityValue.now, 23);
    assert.equal(f.tree.root.findAllByType('press').filter(x => /^结束 /.test(x.props.accessibilityLabel ?? '')).length, 0);
    assert.equal(f.calls.length, 0);
    await f.run(() => f.cancel()); assert.equal(f.calls.length, 0);
    await f.run(() => f.press('时间')); await f.run(() => f.done());
    assert.equal(f.snapshot.draft.startTime, '09:23'); assert.equal(f.snapshot.draft.endTime, null);
  } finally { await f.close(); }
});

test('period and unset commit coherent groups without changing newer notes or title', async () => {
  const f = fixture(); await f.mount();
  try {
    await f.run(() => f.press('时间')); await f.run(() => f.press('时段')); await f.run(() => f.press('下午'));
    await f.update({ draft: { ...f.snapshot.draft, title: '手改标题', notes: '稍后加的备注' } });
    await f.run(() => f.done());
    assert.equal(f.snapshot.draft.title, '手改标题'); assert.equal(f.snapshot.draft.notes, '稍后加的备注');
    assert.equal(f.snapshot.draft.timePeriod, 'afternoon'); assert.equal(f.snapshot.draft.startTime, null);
    await f.run(() => f.press('时间')); await f.run(() => f.press('未设置')); await f.run(() => f.done());
    assert.equal(f.snapshot.draft.timePrecision, 'unspecified'); assert.equal(f.snapshot.draft.timePeriod, null);
  } finally { await f.close(); }
});

test('end before start is refused, not silently pushed into next day', async () => {
  const f = fixture(); await f.mount();
  try {
    await f.update({ draft: { ...f.snapshot.draft, startTime: '23:40' } });
    await f.run(() => f.press('时间')); await f.run(() => f.press('添加结束时间')); await f.run(() => f.done());
    assert.equal(f.calls.at(-1).type, 'feedback'); assert.equal(f.snapshot.draft.endTime, null);
    const day = f.tree.root.findByProps({ accessibilityLabel: '日', accessibilityRole: 'adjustable' });
    await f.run(() => day.props.onAccessibilityAction({ nativeEvent: { actionName: 'increment' } }));
    await f.run(() => f.done()); assert.equal(f.snapshot.draft.endDate, '2026-10-29'); assert.equal(f.snapshot.draft.endTime, '11:00');
  } finally { await f.close(); }
});

test('all platforms import one editor owner; no retired wizard or radial implementation remains', () => {
  assert.equal(fs.existsSync('src/screens/AddEventScreen.android.tsx'), false);
  assert.equal(fs.existsSync('src/components/VoiceInputModal.tsx'), false);
  const owner = fs.readFileSync('src/screens/AddEventScreen.tsx', 'utf8');
  assert.match(owner, /useScheduleEditorDraft/); assert.match(owner, /useScheduleEditorInput/);
  const surface = fs.readFileSync('src/components/ScheduleEditorSurface.tsx', 'utf8');
  assert.doesNotMatch(surface, /\b(addEvent|parseText|clarifyText|useEvents)\b/);
  const button = fs.readFileSync('src/components/ScheduleCreateButton.tsx', 'utf8');
  assert.doesNotMatch(button, /onLongPress|onVoice|onManual|radial|CreateTarget/);
});

test('native calendar registration never runs on web/iOS, Android still registers the real view', () => {
  const code = ts.transpileModule(fs.readFileSync('modules/laoji-native-platform/src/calendar.ts', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  for (const os of ['android', 'ios', 'web']) {
    const calls = [], native = () => {}, fallback = () => {}, module = { exports: {} };
    new Function('require', 'module', 'exports', code)(name => {
      if (name === 'react-native') return { Platform: { OS: os }, View: fallback };
      if (name === 'expo-modules-core') return { requireNativeViewManager: id => {
        calls.push(id); if (os !== 'android') throw Error('unsupported native registration'); return native;
      } };
      throw Error(`unexpected import ${name}`);
    }, module, module.exports);
    assert.deepEqual(calls, os === 'android' ? ['LaojiCalendar'] : []);
    assert.equal(module.exports.LaojiCalendarView, os === 'android' ? native : fallback);
  }
});
