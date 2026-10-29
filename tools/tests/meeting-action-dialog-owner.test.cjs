const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function owner() {
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/screens/TranscriptionScreen.android.tsx'), 'utf8');
  const tree = ts.createSourceFile('screen.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'requestMeetingActionStatusChange') callback = node.initializer.arguments[0].getText(tree);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.ok(callback);
  const code = ts.transpileModule(`const callback = ${callback}; exports.run = callback;`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const events = [], timers = [];
  let dialog;
  const state = { current: 'meeting' };
  const target = { id: 'action', mode: 'edit' };
  const m = { exports: {} };
  new Function('exports', 'editingAction', 'actionEditorSaving', 'meeting', 'setMeetingActionsVisible',
    'setEditingAction', 'setActionEditorError', 'setTimeout', 'mountedRef', 'routeMeetingIdRef',
    'showDialog', 'changeMeetingActionStatus', code)(m.exports, target, false, { id: 'meeting' },
    value => events.push(['collection', value]), value => events.push(['editor', value]), () => {},
    fn => timers.push(fn), { current: true }, state, value => { dialog = value; events.push(['dialog']); },
    async (status, action) => events.push(['commit', status, action.id]));
  return { run: m.exports.run, events, timers, state, get dialog() { return dialog; }, target };
}

test('deletion releases every covering Modal before the page confirmation', async () => {
  const o = owner(); o.run('dismissed');
  assert.deepEqual(o.events, [['collection', false], ['editor', null]]);
  assert.equal(o.dialog, undefined);
  o.timers[0]();
  assert.equal(o.dialog.title, '删除待办事项');
  o.dialog.actions[0].onPress();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(o.events.slice(-2), [['commit', 'dismissed', 'action'], ['collection', true]]);
});

test('cancel restores the original collection and editor without deleting', () => {
  const o = owner(); o.run('dismissed'); o.timers[0](); o.dialog.actions[1].onPress();
  assert.deepEqual(o.events.slice(-2), [['collection', true], ['editor', o.target]]);
  assert.ok(!o.events.some(row => row[0] === 'commit'));
});

test('navigation away never presents a stale deletion decision', () => {
  const o = owner(); o.run('dismissed'); o.state.current = 'other'; o.timers[0]();
  assert.equal(o.dialog, undefined);
});

test('action editing uses the measured keyboard owner and keeps commit outside scrolling fields', async () => {
  const React = require('react');
  const { create, act } = require('react-test-renderer');
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const native = { ActivityIndicator: 'spinner', KeyboardAvoidingView: 'unmeasured-keyboard-frame', Modal: 'modal',
    Platform: { OS: 'android' }, Pressable: 'button', ScrollView: 'scroll', Text: 'text', TextInput: 'input', View: 'view',
    StyleSheet: { create: value => value, absoluteFill: {}, absoluteFillObject: {} },
    useWindowDimensions: () => ({ height: 800, width: 400 }),
    Animated: { Value: class { stopAnimation() {} setValue() {} interpolate() { return 0; } }, View: 'animated',
      timing: () => ({ start: fn => fn?.({ finished: true }) }) }, Easing: { inOut: x => x, ease: 0 },
  };
  const modules = { react: React, 'react-native': native, '@react-native-community/datetimepicker': 'date-picker',
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 24, bottom: 16 }) },
    '../theme/uiTokens': { UI_MOTION: {} },
    '../theme/ThemeProvider': { useTheme: () => ({ appearance: { fontFamily: 'system' }, tokens: { colors: {} } }) },
    '../services/notifications': { meetingActionReminderAtForDue: value => value },
    './KeyboardFrame': { KeyboardFrame: 'keyboard-frame' },
  };
  const m = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../src/components/MeetingActionEditorSheet.tsx'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    if (!(name in modules)) throw Error(name); return modules[name];
  }, m, m.exports);
  let tree, saved;
  await act(async () => { tree = create(React.createElement(m.exports.MeetingActionEditorSheet, { visible: true,
    action: { mode: 'create', id: 'owned-action', content: '发送议程', status: 'pending', dueAtMs: null, reminderAtMs: null },
    saving: false, error: '', onClose() {}, onStatusChange() {}, onSave: value => { saved = value; } })); });
  try {
    assert.equal(tree.root.findAllByType('keyboard-frame').length, 1);
    const commit = tree.root.findByProps({ accessibilityLabel: '创建待办事项' });
    for (let parent = commit.parent; parent; parent = parent.parent) assert.notEqual(parent.type, 'scroll');
    await act(async () => { commit.props.onPress(); }); assert.equal(saved.content, '发送议程');
  } finally { await act(async () => { tree.unmount(); }); }
});
