const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// Execute the production callback, not a duplicate model of its if/switch.
function routeCallback(name, dependencies) {
  const file = path.resolve(__dirname, '../../src/screens/TranscriptionScreen.android.tsx');
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) {
      callback = node.initializer?.arguments?.[0];
    }
    if (name === 'localHydration' && ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect') {
      const effect = node.arguments[0];
      const statement = effect?.body?.statements?.[0];
      if (statement && ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)
        && statement.expression.expression.getText(source) === 'setDeferInactiveDetailPayload') callback = effect;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(callback && ts.isArrowFunction(callback), 'actual route callback must exist');
  const code = ts.transpileModule(`const callback = ${callback.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(...Object.keys(dependencies), `${code};return callback;`)(...Object.values(dependencies));
}

function handler(dependencies) { return routeCallback('handleAction', dependencies); }

test('local source hydration follows a route frame and is cancelled on route replacement, not global interaction idleness', () => {
  const calls = [];
  const frames = new Map();
  let sequence = 0;
  const effect = routeCallback('localHydration', {
    setDeferInactiveDetailPayload: value => calls.push(value),
    requestAnimationFrame: callback => { frames.set(++sequence, callback); return sequence; },
    cancelAnimationFrame: id => frames.delete(id),
    InteractionManager: { runAfterInteractions() { throw Error('unrelated animation must not own this route hydration'); } },
  });
  const cleanup = effect();
  assert.deepEqual(calls, [true]);
  const callback = frames.get(1); frames.delete(1); callback();
  assert.deepEqual(calls, [true, false]);
  cleanup();
  const abandoned = effect();
  assert.deepEqual(calls, [true, false, true]);
  abandoned();
  assert.equal(frames.size, 0, 'an exited route cannot wake hydration in the next route');
});

test('regeneration belongs to the meeting while first generation stays on the empty page', () => {
  const calls = [];
  const template = { id: 'general' };
  function menu(input = {}) {
    return routeCallback('moreItems', {
      meeting: { id: 'current' }, activeTab: 'summary',
      snapshotBody: { detail: { canGenerateSummary: true, summary: [{ id: 'lead' }], actions: [], summaryGenerating: false } },
      loadingSummary: false, displayedActionCandidates: [], meetingScopeKey: 'device', meetingQuestionsEnabled: false,
      summaryDocument: null, meetingAttachments: [], confirmDelete() {},
      prepareSummaryGeneration: value => calls.push(value), summaryTemplate: template,
      ...input,
    })();
  }
  const action = menu().filter(item => item.key === 'regenerate-summary');
  assert.equal(action.length, 1);
  assert.equal(action[0].label, '重新整理');
  assert.equal(action[0].disabled, false);
  action[0].onPress();
  assert.deepEqual(calls, [template]);
  assert.equal(menu({ activeTab: 'notes' }).some(item => item.key === 'regenerate-summary'), true,
    'a meeting operation must not depend on React or native selected-tab mirrors');
  assert.equal(menu({ activeTab: 'transcript' }).some(item => item.key === 'regenerate-summary'), true);
  assert.equal(menu({ snapshotBody: { detail: { canGenerateSummary: false, summary: [{ id: 'lead' }] } } })
    .find(item => item.key === 'regenerate-summary').disabled, true, 'source readiness disables the same action instead of hiding it');
  assert.equal(menu({ snapshotBody: { detail: { canGenerateSummary: true, summary: [], actions: [] } } })
    .some(item => item.key === 'regenerate-summary'), false);
  assert.equal(menu({ snapshotBody: { detail: { canGenerateSummary: true, summary: [{ id: 'lead' }], summaryGenerating: true } } })
    .find(item => item.key === 'regenerate-summary').disabled, true);
  assert.equal(menu({ loadingSummary: true }).find(item => item.key === 'regenerate-summary').disabled, true);
});

test('detail back is immediate while a content projection is pending, without waiting for autosave', () => {
  const calls = [];
  const invoke = handler({
    manualNote: { flush: () => { calls.push('flush'); return new Promise(() => {}); } },
    navigation: { goBack: () => calls.push('back') },
    fenceNativeProjectionAction: () => { throw Error('navigation must not wait for content authentication'); },
  });
  invoke({ type: 'back' });
  assert.deepEqual(calls, ['flush', 'back']);
});

test('business actions still fail closed on a pending/stale projection', () => {
  const calls = [];
  const invoke = handler({
    currentProjectionRef: { current: null },
    fenceNativeProjectionAction: () => ({ accepted: false, reason: 'projection_pending' }),
    diagnosticAudit: (...args) => calls.push(args),
    updateMeetingTitle: () => { throw Error('stale mutation must not execute'); },
  });
  invoke({ type: 'saveTitle', meetingId: 'meeting', title: '修改标题' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].reason, 'projection_pending');
});

test('native tab preference follows its own meeting/generation owner while projection is pending', () => {
  const calls = [];
  const activeTabRef = { current: 'notes' };
  const invoke = handler({
    route: { params: { meetingId: 'current' } },
    tabOwnerRef: { current: { current: () => ({ generation: 3 }), accept: value => { calls.push(value); return true; } } },
    activeTabRef, recordingStorageScope: 'device',
    rememberMeetingDetailActiveTab: (...args) => calls.push(args),
    setDeferInactiveDetailPayload: value => calls.push(value),
    fenceNativeProjectionAction: () => { throw Error('local selection is not a data mutation'); },
  });
  invoke({ type: 'selectDetailTab', meetingId: 'other', selectionGeneration: 4, tab: 'transcript' });
  invoke({ type: 'selectDetailTab', meetingId: 'current', selectionGeneration: 2, tab: 'transcript' });
  assert.equal(calls.length, 0);
  invoke({ type: 'selectDetailTab', meetingId: 'current', selectionGeneration: 4, tab: 'transcript' });
  assert.equal(activeTabRef.current, 'transcript');
  assert.deepEqual(calls[1], ['device', 'current', 'transcript']);
  assert.equal(calls[2], false);
});
