const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const React = require('react');
const Renderer = require('react-test-renderer');
global.IS_REACT_ACT_ENVIRONMENT = true;
const { act } = Renderer;
const gate = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };

// Native navigation and storage are explicit seams here; SQLite integration is
// exercised in schedule-editor.test.cjs, not inferred from these hook tests.
function fixture(receiveHardwareInputs = true, adopted = null) {
  const calls = [], navigations = [], dialogs = [], reads = [], lists = [], resumes = [];
  let hook, tree, appListener;
  let jobs = [], enabled = true;
  const refresh = () => calls.push('refresh');
  const app = { currentState: 'active', addEventListener: (_name, listener) => {
    appListener = listener; return { remove() { appListener = undefined; } };
  } };
  const navigation = { navigate: (...args) => navigations.push(args) };
  const modules = {
    react: React, 'react-native': { AppState: app },
    '../components/ScheduleInputProvider': { useScheduleInputs: () => ({ jobs, refresh }) },
    '../components/AppDialog': { useAppDialog: () => ({ showDialog: value => dialogs.push(value) }) },
    '../data/repositories/scheduleEditorRepository': {
      findScheduleEditorFollowup: async () => adopted,
      listUnfinishedScheduleEditorDrafts: () => { const read = gate(); lists.push(read); return read.promise; },
      loadStoredScheduleEditorDraft: id => { calls.push(['resume', id]); const read = gate(); resumes.push(read); return read.promise; },
      openScheduleInputEditorDraft: job => {
      calls.push(['open', job.id]); const read = gate(); reads.push(read); return read.promise;
    } },
    '../domain/scheduleEditor': { isScheduleEditorResumeCandidate: (draft, entry) => draft.eligible === true },
    '../data/repositories/scheduleInputRepository': { retryScheduleInput: async id => calls.push(['retry', id]) },
    '../services/diagnostics': { diagnosticWarn() {} },
  };
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync('src/hooks/useScheduleEditorEntry.ts', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    if (!(name in modules)) throw Error(`unexpected seam ${name}`); return modules[name];
  }, module, module.exports);
  function Harness() { hook = module.exports.useScheduleEditorEntry(navigation, enabled, receiveHardwareInputs); return null; }
  const render = () => tree.update(React.createElement(Harness));
  return { calls, reads, lists, resumes, navigations, dialogs, get hook() { return hook; },
    async mount(initialJobs = []) { jobs = initialJobs; await act(async () => { tree = Renderer.create(React.createElement(Harness)); }); },
    async update(nextJobs = jobs, nextEnabled = enabled) { jobs = nextJobs; enabled = nextEnabled; await act(async () => { render(); }); },
    async complete(index, value) { await act(async () => { reads[index].resolve(value); }); },
    async run(fn) { await act(async () => { fn(); }); },
    async state(value) { await act(async () => { app.currentState = value; appListener?.(value); }); },
    async unmount() { await act(async () => { tree.unmount(); }); },
  };
}
const ready = id => ({ id, state: 'ready', draft: {}, source: {}, attempts: 0 });
const editing = id => ({ id, phase: 'editing' });

test('one ready input navigates to its durable editor once; explicit reopen remains possible', async () => {
  const f = fixture(), job = ready('one'); await f.mount([job]);
  try {
    await f.update([{ ...job }]); assert.equal(f.reads.length, 1);
    await f.complete(0, editing('draft-one'));
    assert.deepEqual(f.navigations, [['AddEvent', { editorDraftId: 'draft-one' }]]);
    await f.update([{ ...job }]); assert.equal(f.reads.length, 1);
    await f.run(() => { void f.hook.open(job); });
    await f.complete(1, editing('draft-one')); assert.equal(f.navigations.length, 2);
  } finally { await f.unmount(); }
});

test('leaving then returning before a database read resolves cannot activate an old handoff', async () => {
  const f = fixture(), job = ready('focus'); await f.mount([job]);
  try {
    await f.update([job], false); await f.update([job], true);
    await f.complete(0, editing('old-draft')); assert.equal(f.navigations.length, 0);
    await f.update([{ ...job }]); await f.complete(1, editing('current-draft'));
    assert.deepEqual(f.navigations, [['AddEvent', { editorDraftId: 'current-draft' }]]);
  } finally { await f.unmount(); }
});

test('background then foreground invalidates the old asynchronous navigation even when focus stays enabled', async () => {
  const f = fixture(), job = ready('background'); await f.mount([job]);
  try {
    await f.state('background'); await f.state('active');
    await f.complete(0, editing('old-draft')); assert.equal(f.navigations.length, 0);
    await f.update([{ ...job }]); await f.complete(1, editing('current-draft'));
    assert.equal(f.navigations[0][1].editorDraftId, 'current-draft');
  } finally { await f.unmount(); }
});

test('unmount, failed retry and saved receipt keep their existing owners without a wizard', async () => {
  const f = fixture(), job = ready('unmounted'); await f.mount([job]);
  await f.unmount(); await f.complete(0, editing('old-draft')); assert.equal(f.navigations.length, 0);
  const retry = fixture(); await retry.mount();
  try {
    await retry.run(() => { void retry.hook.open({ ...ready('failed'), state: 'failed' }); });
    assert.deepEqual(retry.calls, [['retry', 'failed'], 'refresh']); assert.equal(retry.reads.length, 0);
    await retry.update([ready('saved')]);
    const eventRef = { sourceEventId: 'saved-event', occurrenceDate: '2026-10-28' };
    await retry.complete(0, { id: 'saved-draft', phase: 'saved', savedEventRef: eventRef });
    assert.deepEqual(retry.navigations, [['EventDetail', { eventRef }]]);
  } finally { await retry.unmount(); }
});

test('a failed read is not reopened by polling; only the explicit retry reopens it', async () => {
  const f = fixture(), job = ready('read-failed'); await f.mount([job]);
  try {
    await f.run(() => { f.reads[0].reject(Error('injected read failure')); });
    assert.equal(f.dialogs.length, 1); assert.equal(f.navigations.length, 0);
    await f.update([{ ...job }]); assert.equal(f.reads.length, 1);
    await f.run(() => f.dialogs[0].actions.find(action => action.text === '重试').onPress());
    await f.complete(1, editing('recovered')); assert.equal(f.navigations[0][1].editorDraftId, 'recovered');
  } finally { await f.unmount(); }
});

test('fresh create has no resume UI; selecting an existing draft reuses its ID without reseeding fields', async () => {
  const f = fixture(); await f.mount();
  try {
    await f.run(() => { void f.hook.create({ date: '2026-10-29' }); });
    await f.run(() => f.lists[0].resolve([]));
    assert.equal(f.hook.resume, null);
    assert.deepEqual(f.navigations, [['AddEvent', { date: '2026-10-29' }]]);
    await f.run(() => { void f.hook.create({}); });
    await f.run(() => f.lists[1].resolve([{ ...editing('retained'), eligible: true }, { ...editing('empty'), eligible: false }]));
    const choice = f.hook.resume;
    assert.deepEqual(choice.drafts.map(draft => draft.id), ['retained']);
    await f.run(() => f.hook.dismissResume()); // AppActionSheet closes before invoking its selected action.
    await f.run(() => { void f.hook.chooseResume(choice, 'retained'); });
    await f.run(() => f.resumes[0].resolve(editing('retained')));
    assert.deepEqual(f.navigations[1], ['AddEvent', { editorDraftId: 'retained' }]);
    await f.run(() => { void f.hook.chooseResume(choice, 'retained'); });
    assert.equal(f.navigations.length, 2); assert.equal(f.resumes.length, 1);
  } finally { await f.unmount(); }
});

test('meeting adoption resumes the same save identity, never forks a second draft or captures unrelated hardware', async () => {
  const f = fixture(false); await f.mount([ready('unrelated-hardware-input')]);
  try {
    assert.equal(f.reads.length, 0);
    const entry = { draft: { title: '发送修订稿', startDate: '2026-10-30' },
      followup: { meetingId: 'meeting-1', canonicalMeetingId: 'canonical-1', actionId: 'action-1', clientRequestId: 'action-followup:action-1' } };
    await f.run(() => { void f.hook.create(entry); });
    await f.run(() => f.lists[0].resolve([{ ...editing('adopted-draft'), eligible: true }]));
    const choice = f.hook.resume;
    await f.run(() => { void f.hook.chooseResume(choice, null); });
    assert.equal(f.navigations.length, 0);
    await f.run(() => f.hook.dismissResume());
    await f.run(() => { void f.hook.chooseResume(choice, 'adopted-draft'); });
    await f.run(() => f.resumes[0].resolve(editing('adopted-draft')));
    assert.deepEqual(f.navigations, [['AddEvent', { ...entry, editorDraftId: 'adopted-draft' }]]);
    assert.deepEqual(f.calls, [['resume', 'adopted-draft']]);
  } finally { await f.unmount(); }
});

test('already committed meeting adoption opens its event without a new editor or save request', async () => {
  const eventRef = { sourceEventId: 'committed-action', occurrenceDate: '2026-10-29' };
  const f = fixture(false, { id: 'saved-action', phase: 'saved', savedEventRef: eventRef }); await f.mount();
  try {
    await f.run(() => { void f.hook.create({ followup: { clientRequestId: 'same-action' } }); });
    assert.deepEqual(f.navigations, [['EventDetail', { eventRef }]]);
    assert.equal(f.lists.length, 0); assert.equal(f.reads.length, 0); assert.equal(f.dialogs.length, 0);
  } finally { await f.unmount(); }
});

test('new-from-resume retains explicit calendar context and never discards the previous draft', async () => {
  const f = fixture(); await f.mount();
  try {
    const entry = { date: '2026-10-29', startTime: '09:23', endTime: '10:07' };
    await f.run(() => { void f.hook.create(entry); });
    await f.run(() => f.lists[0].resolve([{ ...editing('retained'), eligible: true }]));
    const choice = f.hook.resume;
    await f.run(() => f.hook.dismissResume());
    await f.run(() => { void f.hook.chooseResume(choice, null); });
    assert.deepEqual(f.navigations, [['AddEvent', entry]]); assert.deepEqual(f.calls, []);
  } finally { await f.unmount(); }
});

test('creation lookup and a previously shown recovery action cannot navigate after leaving', async () => {
  const f = fixture(); await f.mount();
  try {
    await f.run(() => { void f.hook.create(); });
    await f.update([], false); await f.update([], true);
    await f.run(() => f.lists[0].resolve([{ ...editing('retained'), eligible: true }]));
    assert.equal(f.hook.resume, null); assert.equal(f.navigations.length, 0);
    await f.run(() => { void f.hook.create(); });
    await f.run(() => f.lists[1].resolve([{ ...editing('retained'), eligible: true }]));
    const choice = f.hook.resume;
    await f.state('background'); assert.equal(f.hook.resume, null);
    await f.state('active');
    await f.run(() => { void f.hook.chooseResume(choice, 'retained'); });
    assert.equal(f.resumes.length, 0); assert.equal(f.navigations.length, 0);
  } finally { await f.unmount(); }
});
