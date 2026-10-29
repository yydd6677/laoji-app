const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const source = fs.readFileSync(path.resolve(__dirname, '../../src/screens/ScheduleScreen.android.tsx'), 'utf8');
const file = ts.createSourceFile('ScheduleScreen.android.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const compile = node => ts.transpileModule(`const callback = ${node.getText(file)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText + '\nreturn callback;';
const nodes = [];
function walk(node) { nodes.push(node); ts.forEachChild(node, walk); }
walk(file);

test('opening a calendar search result retains the query; only explicit close clears it', () => {
  const owner = nodes.find(node => ts.isVariableDeclaration(node) && node.name.getText(file) === 'handleSearchAction');
  assert.ok(owner && ts.isCallExpression(owner.initializer));
  let query = '读书', visible = true;
  const navigations = [];
  const action = new Function('setSearchQuery', 'setSearchVisible', 'navigation', compile(owner.initializer.arguments[0]))(
    value => { query = value; }, value => { visible = value; }, { navigate: (...args) => navigations.push(args) });
  action({ type: 'openEvent', sourceEventId: 'local-event', occurrenceDate: '2026-10-28' });
  assert.equal(query, '读书');
  assert.equal(visible, true);
  assert.deepEqual(navigations, [['EventDetail', { eventRef: { sourceEventId: 'local-event', occurrenceDate: '2026-10-28' } }]]);
  action({ type: 'close' });
  assert.equal(query, '');
  assert.equal(visible, false);
});

test('the existing overlay suspends on route/tab blur and resumes the same search on return', () => {
  const effect = nodes.find(node => ts.isCallExpression(node) && node.expression.getText(file) === 'useEffect'
    && node.arguments[0]?.getText(file).includes("presentNativeWindowOverlay(searchOwnerId, 'calendar-search'"));
  assert.ok(effect);
  for (const active of [false, true]) for (const isFocused of [false, true]) for (const visible of [false, true]) {
    const calls = [];
    const snapshot = { query: '读书', results: [{ id: 'event' }] };
    new Function('presentNativeWindowOverlay', 'dismissNativeWindowOverlay', 'searchOwnerId',
      'searchSnapshot', 'searchVisible', 'active', 'isFocused', compile(effect.arguments[0]))(
      (...args) => { calls.push(['present', ...args]); return Promise.resolve(); },
      (...args) => { calls.push(['dismiss', ...args]); return Promise.resolve(); },
      'same-owner', snapshot, visible, active, isFocused)();
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], visible && active && isFocused ? 'present' : 'dismiss');
    if (calls[0][0] === 'present') assert.equal(calls[0][3], snapshot);
  }
});
