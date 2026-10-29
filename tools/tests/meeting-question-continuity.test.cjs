const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const React = require('react');
const { act, create } = require('react-test-renderer');
global.IS_REACT_ACT_ENVIRONMENT = true;
global.requestAnimationFrame = callback => { queueMicrotask(callback); return 1; };

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

const session = (id = 'thread') => ({
  thread: { id, turns: [], includeManualNote: true },
  evidence: { meetingId: 'meeting', attachments: [], summary: [], transcript: [], includeManualNote: true },
  readOnly: false,
});

function fixture() {
  let fontFamily = 'LaojiThemeNeutral';
  const reads = [], answers = [];
  const host = name => React.forwardRef((props, ref) => React.createElement(name, { ...props, ref }));
  class Value { setValue() {} stopAnimation() {} interpolate() { return 0; } }
  const rn = {
    ActivityIndicator: host('spinner'), View: host('view'), Text: host('text'),
    TextInput: host('input'), Pressable: host('button'), Modal: host('modal'),
    KeyboardAvoidingView: host('keyboard-frame'), Keyboard: { dismiss() {} },
    Animated: { Value, View: host('animated-view'), timing: () => ({ start: callback => callback?.({ finished: true }) }) },
    StyleSheet: { create: value => value, hairlineWidth: 1 }, useWindowDimensions: () => ({ width: 400 }),
    FlatList: React.forwardRef((props, ref) => {
      React.useImperativeHandle(ref, () => ({ scrollToEnd() {} }));
      return React.createElement('list', {}, props.data.length
        ? props.data.map(item => React.createElement(React.Fragment, { key: props.keyExtractor(item) }, props.renderItem({ item })))
        : props.ListEmptyComponent, props.ListFooterComponent);
    }),
  };
  const services = {
    prepareMeetingQuestionSession: () => { const read = deferred(); reads.push(read); return read.promise; },
    askMeetingQuestion: () => { const answer = deferred(); answers.push(answer); return answer.promise; },
    listMeetingQuestionHistory: async () => [{ threadId: 'history', title: '历史记录', updatedAtMs: 1, turnCount: 1 }],
    openMeetingQuestionHistory: async () => session('history'),
    MeetingQuestionEvidenceChangedError: class extends Error {},
  };
  const source = fs.readFileSync(process.env.LAOJI_QUESTION_COMPONENT_FIXTURE
    || path.resolve(__dirname, '../../src/components/MeetingQuestionSheet.tsx'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.React, esModuleInterop: true,
  } }).outputText;
  const m = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(name => {
    if (name === 'react') return React;
    if (name === 'react-native') return rn;
    if (name === 'react-native-safe-area-context') return { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) };
    if (name === '@expo/vector-icons/Ionicons') return host('icon');
    if (name.endsWith('/meetingQuestions')) return services;
    if (name.endsWith('/meetingQuestionsQ2')) return { subscribeQ2MeetingChanges: () => () => {}, Q2EvidenceChangedError: class extends Error {} };
    if (name.endsWith('/uiTokens')) return { getUiTokens: () => ({ colors: {} }) };
    if (name.endsWith('/colors')) return { Appearance: { fontFamily: 'LaojiThemeNeutral' } };
    if (name.endsWith('/ThemeProvider')) return { useTheme: () => ({ tokens: { colors: {} }, appearance: { fontFamily } }) };
    if (name.endsWith('/errors')) return { readableErrorMessage: (_error, fallback) => fallback };
    if (name.endsWith('/meetingAttachments')) return { loadMeetingAttachments: async () => [] };
    if (name.endsWith('/MeetingSummaryAttachmentSheet')) return { MeetingSummaryAttachmentSheet: host('source-sheet') };
    if (name.endsWith('/KeyboardFrame')) return { KeyboardFrame: host('keyboard-frame') };
    return {};
  }, m, m.exports);
  let root;
  const props = { visible: true, meetingId: 'meeting', meetingTitle: '项目讨论', scopeKey: 'device', onClose() {}, onOpenCitation() {} };
  const update = async patch => {
    Object.assign(props, patch);
    await act(async () => {
      const element = React.createElement(m.exports.MeetingQuestionSheet, props);
      if (root) root.update(element);
      else root = create(element, { createNodeMock: element => element.type === 'input' ? { nativeInput: true } : {} });
    });
  };
  const find = id => root.root.findAll(node => node.type === 'input' && node.props.testID === id)[0]
    || root.root.findAll(node => node.type === 'button' && node.props.testID === id)[0];
  const input = () => find('meeting-question-input');
  const type = text => act(async () => input().props.onChangeText(text));
  const press = id => act(async () => find(id).props.onPress());
  return { reads, answers, update, input, type, press, find,
    setFont: async value => { fontFamily = value; await update({}); },
    placeholder: () => root.root.findAll(node => node.type === 'view'
      && node.props.testID === 'meeting-question-new-thread-placeholder')[0],
    sourceSheet: () => root.root.findByType('source-sheet'),
    tree: () => root.toJSON(), dispose: () => act(async () => root.unmount()) };
}

test('the real composer accepts text before sources finish; completion does not remount or erase it', async () => {
  const f = fixture();
  try {
    await f.update({});
    const nativeInput = f.input();
    assert.equal(f.input().props.editable, true);
    assert.equal(f.find('meeting-question-send').props.disabled, true);
    await f.type('项目下一步要做什么？');
    await act(async () => f.reads[0].resolve(session()));
    assert.equal(f.input(), nativeInput);
    assert.equal(f.input().props.value, '项目下一步要做什么？');
    assert.equal(f.find('meeting-question-send').props.disabled, false);
  } finally { await f.dispose(); }
});

test('theme typography changes on the existing composer without replacing its draft or instance', async () => {
  const f = fixture();
  try {
    await f.update({});
    await f.type('同一份草稿');
    const input = f.input();
    await f.setFont('LaojiThemePaper');
    assert.equal(f.input(), input);
    assert.equal(f.input().props.value, '同一份草稿');
    const style = Object.assign({}, ...f.input().props.style.flat(Infinity).filter(Boolean));
    assert.equal(style.fontFamily, 'LaojiThemePaper');
  } finally { await f.dispose(); }
});

test('sources remain discoverable without a permanent inventory row or a forced new conversation', async () => {
  const f = fixture();
  try {
    await f.update({});
    const value = session(); value.evidence.transcript = [{ text: '来源' }];
    value.evidence.manualNote = '补充';
    await act(async () => f.reads[0].resolve(value));
    const input = f.input();
    await f.type('未发出的问题');
    await f.press('meeting-question-attachments');
    assert.equal(f.sourceSheet().props.visible, true);
    assert.deepEqual(f.sourceSheet().props.includedSources, ['文字记录', '我的笔记']);
    await act(async () => f.sourceSheet().props.onSkip());
    assert.equal(f.reads.length, 1, 'unchanged source selection must not create a new thread');
    assert.equal(f.input(), input);
    assert.equal(f.input().props.value, '未发出的问题');
  } finally { await f.dispose(); }
});

test('sending, failure and history retain the editable component instance', async () => {
  const f = fixture();
  try {
    await f.update({});
    await act(async () => f.reads[0].resolve(session()));
    const nativeInput = f.input();
    await f.type('后续安排是什么？');
    await f.press('meeting-question-send');
    assert.equal(f.input(), nativeInput);
    assert.equal(f.input().props.editable, true);
    assert.equal(f.find('meeting-question-send').props.disabled, true);
    // One running owner in the message list; no second spinner in the action.
    const tree = JSON.stringify(f.tree());
    assert.equal((tree.match(/正在回答/g) || []).length, 1);
    await f.type('下一条草稿');
    await act(async () => f.answers[0].reject(Error('network')));
    assert.equal(f.input().props.value, '下一条草稿');
    await f.press('meeting-question-history');
    assert.equal(f.input(), nativeInput);
    await f.press('meeting-question-history');
    assert.equal(f.input(), nativeInput);
  } finally { await f.dispose(); }
});

test('reopening preserves this meeting draft; changing meeting or scope clears it and rejects stale reads', async () => {
  const f = fixture();
  try {
    await f.update({});
    await f.type('保留的草稿');
    await f.update({ visible: false });
    await f.update({ visible: true });
    assert.equal(f.input().props.value, '保留的草稿');
    await f.update({ meetingId: 'other' });
    assert.equal(f.input().props.value, '');
    await act(async () => f.reads[0].resolve(session('obsolete')));
    assert.equal(f.find('meeting-question-send').props.disabled, true);
    await f.type('第二条草稿');
    await f.update({ scopeKey: 'other-device' });
    assert.equal(f.input().props.value, '');
  } finally { await f.dispose(); }
});

test('a successful answer and a new-thread source read do not replace the composer', async () => {
  const f = fixture();
  try {
    await f.update({});
    await act(async () => f.reads[0].resolve(session()));
    const input = f.input();
    const reservedWidth = f.placeholder().props.style.width;
    await f.type('下一步是什么？');
    await f.press('meeting-question-send');
    const answered = session();
    answered.thread.turns = [{ id: 'answer', question: '下一步是什么？', answer: '核对范围。', citations: [] }];
    await act(async () => f.answers[0].resolve(answered));
    assert.equal(f.input(), input);
    const actionStyle = f.find('meeting-question-new-thread').props.style({ pressed: false });
    assert.equal(actionStyle[0].width, reservedWidth, 'the first answer must not move the title/history lane');
    await f.type('保留新草稿');
    await f.press('meeting-question-new-thread');
    assert.equal(f.input(), input);
    assert.equal(f.input().props.value, '保留新草稿');
    assert.equal(f.find('meeting-question-send').props.disabled, true);
    await act(async () => f.reads[1].resolve(session('new-thread')));
    assert.equal(f.input(), input);
    assert.equal(f.find('meeting-question-send').props.disabled, false);
  } finally { await f.dispose(); }
});
