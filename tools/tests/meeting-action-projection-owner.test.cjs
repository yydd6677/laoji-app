const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const compiled = ts.transpileModule(fs.readFileSync(path.resolve(__dirname,
  '../../src/services/meetingActions.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const target = { exports: {} };
new Function('require', 'module', 'exports', compiled)(() => ({}), target, target.exports);
const { mergeCanonicalMeetingActions: merge } = target.exports;
const action = { id: 'local', canonicalId: 'local', content: '发送接口资料', status: 'completed',
  followupEventSourceId: 'calendar-event', updatedAtMs: 42, dueAtMs: null, citations: [] };
const projection = { id: 'provider', content: action.content, status: 'pending',
  followupEventSourceId: null, dueText: '周五前', citations: [{ id: 'evidence' }] };

test('summary refresh cannot reset completion, identity, revision or calendar link', () => {
  const [next] = merge([action], [projection]);
  assert.equal(next.id, 'local'); assert.equal(next.canonicalId, 'local');
  assert.equal(next.status, 'completed'); assert.equal(next.updatedAtMs, 42);
  assert.equal(next.followupEventSourceId, 'calendar-event');
  assert.equal(next.dueText, '周五前'); assert.deepEqual(next.citations, projection.citations);
});
test('a generated projection cannot resurrect a removed candidate', () => {
  assert.deepEqual(merge([], [projection]), []);
  assert.equal(merge([{ ...action, status: 'dismissed' }], [projection])[0].status, 'dismissed');
});
test('a user edit never acquires stale generated wording or deadline', () => {
  const edited = { ...action, content: '发送修订后的设计稿', dueAtMs: 1000 };
  assert.equal(merge([edited], [projection])[0], edited);
  assert.equal(merge([{ ...action, dueAtMs: 1000 }], [projection])[0].dueText, null);
});
test('ambiguous same-text candidates do not attach arbitrary evidence', () => {
  assert.equal(merge([action], [projection, { ...projection, id: 'other' }])[0], action);
});
