const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const React = require('react');
const Renderer = require('react-test-renderer');
global.IS_REACT_ACT_ENVIRONMENT = true;
const { act } = Renderer;
const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };

function fixture() {
  const listeners = {}, calls = [], deleted = [], persisted = [];
  const parseGate = deferred(); const startGate = deferred(); const recoveryAuthGate = deferred();
  let appListener, owner, hook, rendered, manualStart = false, parseResult;
  let recoveryRequired = false, authCalls = 0, nativeAvailable = true;
  const cache = new Map();
  const record = { sessionId: 'session-1', captureStartedAtMs: Date.now(), purpose: 'schedule' };
  const native = {
    hasNativeRecorder: () => nativeAvailable,
    addNativeRecorderTranscriptListener: fn => { listeners.transcript = fn; return { remove() {} }; },
    addNativeRecorderLevelListener: fn => { listeners.level = fn; return { remove() {} }; },
    addNativeRecorderErrorListener: fn => { listeners.error = fn; return { remove() {} }; },
    startNativeRecorder: async input => { calls.push(['start', input]); return manualStart ? startGate.promise : record; },
    stopNativeRecorder: async id => { calls.push(['stop', id]); return { localSaved: true, localUri: 'file:///input.wav',
      snapshot: { transcriptRecoveryRequired: recoveryRequired }, transcriptSegments: [] }; },
    transcribeNativeAudioFile: async () => { calls.push(['recovery']); return ''; },
  };
  const modules = {
    react: React,
    'react-native': { AppState: { currentState: 'active', addEventListener: (_name, fn) => { appListener = fn; return { remove() {} }; } },
      PermissionsAndroid: { PERMISSIONS: { RECORD_AUDIO: 'mic' }, RESULTS: { GRANTED: 'granted' }, check: async () => true } },
    'expo-file-system/legacy': { deleteAsync: async uri => { deleted.push(uri); } },
    'laoji-native-platform': native,
    [path.resolve('src/theme/colors.ts')]: {},
    [path.resolve('src/services/clientRequestId.ts')]: { createClientRequestState: () => ({ id: `input-${calls.length}-${persisted.length}` }) },
    [path.resolve('src/services/deviceApi.ts')]: { getLocalDeviceRealtimeAuth: async () => {
      calls.push(['local-auth']); authCalls++;
      if (recoveryRequired && authCalls === 2) return recoveryAuthGate.promise;
      return { deviceToken: 'local', dataEpoch: 'epoch' };
    } },
    [path.resolve('src/services/config.ts')]: { getApiConfig: () => ({ isProduction: true, realtimeAsrBase: 'wss://service' }) },
    [path.resolve('src/services/realtimeAsr.ts')]: { createRealtimeMeetingId: () => 'session-1', buildRealtimeAsrUrl: () => 'wss://service/schedule' },
    [path.resolve('src/services/diagnostics.ts')]: { diagnosticAudit() {}, diagnosticWarn() {} },
    [path.resolve('src/services/errors.ts')]: { readableErrorMessage: (e, fallback) => e?.message || fallback },
    [path.resolve('src/services/scheduleParsing.ts')]: { parseText: async (text, context) => { calls.push(['parse', text, context]); return parseResult ?? parseGate.promise; } },
    [path.resolve('src/services/scheduleEditV1.ts')]: { editScheduleDraftV1: async (draft, op, signal) => { calls.push(['edit', draft, op, signal]); return parseGate.promise; } },
  };
  function load(file) {
    file = path.resolve(file);
    if (Object.hasOwn(modules, file)) return modules[file];
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
    }).outputText;
    new Function('require', 'module', 'exports', code)(name => {
      if (Object.hasOwn(modules, name)) return modules[name];
      if (!name.startsWith('.')) throw new Error(`unexpected dependency ${name}`);
      return load(path.resolve(path.dirname(file), `${name}.ts`));
    }, module, module.exports);
    return module.exports;
  }
  const domain = load('src/domain/scheduleEditor.ts');
  const parsing = load('src/services/scheduleEditorParsing.ts');
  const { useScheduleEditorInput } = load('src/hooks/useScheduleEditorInput.ts');
  function Harness({ seed }) {
    const current = React.useRef(seed); const [, render] = React.useReducer(n => n + 1, 0);
    const change = React.useCallback(fn => { current.current = fn(current.current); render(); return current.current; }, []);
    const flush = React.useCallback(async () => { persisted.push(structuredClone(current.current)); }, []);
    owner = { current, change, flush };
    hook = useScheduleEditorInput(owner);
    return null;
  }
  return { domain, parsing, calls, deleted, persisted, listeners, parseGate, startGate,
    get owner() { return owner; }, get hook() { return hook; },
    startBlocked() { manualStart = true; },
    blockRecoveryAuth() { recoveryRequired = true; },
    withoutNativeCapture() {
      nativeAvailable = false;
      for (const name of ['addNativeRecorderTranscriptListener', 'addNativeRecorderLevelListener', 'addNativeRecorderErrorListener']) {
        native[name] = () => { throw Error('unsupported native listener acquired'); };
      }
    },
    releaseRecoveryAuth() { recoveryAuthGate.resolve({ deviceToken: 'local', dataEpoch: 'epoch' }); },
    async mount(content = {}, seed = {}) { await act(async () => { rendered = Renderer.create(React.createElement(Harness, {
      seed: domain.createScheduleEditorDraft({ id: 'draft-1', saveRequestId: 'save-1', startDate: '2026-10-28', content, ...seed }),
    })); }); },
    async unmount() { await act(async () => { rendered.unmount(); }); },
    async run(fn) { await act(async () => { fn(); await Promise.resolve(); }); },
    background() { appListener('background'); },
    result(value) { parseResult = value; },
  };
}

function parsed() { return { title: '归还图书', start_date: '2026-10-29', end_date: null,
  start_time: '09:23', end_time: null, time_period: null, event_type: 'once', description: null,
  category: '生活', needs_clarification: false, is_all_day: false }; }

test('without native capture the editor mounts and keeps text usable, no native listener or phantom recording', async () => {
  const f = fixture(); f.withoutNativeCapture(); await f.mount();
  try {
    await f.run(() => f.hook.setText('明天归还图书'));
    assert.equal(f.owner.current.current.latestInputText, '明天归还图书');
    await f.run(() => f.hook.start());
    assert.equal(f.owner.current.current.phase, 'editing');
    assert.match(f.hook.error, /可输入文字/);
    assert.equal(f.calls.some(([kind]) => kind === 'start'), false);
    assert.equal(f.owner.current.current.pendingInput, null);
  } finally { await f.unmount(); }
});

for (const row of [
  { origin: 'default', resolution: 'omitted', expected: 'input-day' },
  { origin: 'context', resolution: 'omitted', expected: '2026-09-03' },
  { origin: 'context', resolution: 'unresolved', expected: null },
  { origin: 'context', resolution: 'resolved', expected: '2026-11-04' },
  { origin: 'default', resolution: undefined, expected: null },
]) test(`normal hook initial date policy: ${row.origin}/${row.resolution}`, async () => {
  const f = fixture();
  await f.mount({}, { startDate: '2026-09-03', dateOrigin: row.origin });
  try {
    await f.run(() => f.hook.submit('去取快递'));
    const operation = structuredClone(f.owner.current.current.pendingInput);
    assert.equal(operation.mode, 'initial');
    await f.run(() => f.parseGate.resolve({ ...parsed(), title: '取快递', start_date: row.resolution === 'resolved' ? '2026-11-04' : '',
      date_resolution: row.resolution }));
    const expected = row.expected === 'input-day'
      ? f.domain.initialScheduleEditorDate({ ...parsed(), start_date: '', date_resolution: 'omitted' }, operation).date : row.expected;
    assert.equal(f.owner.current.current.startDate, expected);
    assert.equal(f.owner.current.current.phase, 'editing');
    assert.equal(f.calls.filter(([kind]) => kind === 'parse').length, 1);
    assert.equal(f.calls.filter(([kind]) => kind === 'edit').length, 0);
    assert.equal(f.owner.current.current.id, 'draft-1');
    if (row.resolution === 'omitted') assert.equal(f.owner.current.current.fieldOrigins.startDate, row.origin);
  } finally { await f.unmount(); }
});

for (const interruption of ['cancel', 'background']) {
  test(`${interruption} during recovery auth cannot start a stale file upload or disturb a newer capture`, async () => {
    const f = fixture(); f.blockRecoveryAuth(); await f.mount();
    try {
      await f.run(() => f.hook.start());
      await f.run(() => f.hook.stop());
      assert.equal(f.owner.current.current.phase, 'parsing');
      assert.equal(f.calls.filter(([type]) => type === 'local-auth').length, 2);
      assert.equal(f.calls.filter(([type]) => type === 'recovery').length, 0);
      await f.run(() => interruption === 'cancel' ? f.hook.cancel() : f.background());
      assert.equal(f.owner.current.current.phase, 'editing');
      assert.equal(f.owner.current.current.pendingInput, null);
      await f.run(() => f.hook.start());
      const nextId = f.owner.current.current.pendingInput.id;
      await f.run(() => f.releaseRecoveryAuth());
      assert.equal(f.calls.filter(([type]) => type === 'recovery').length, 0);
      assert.equal(f.owner.current.current.pendingInput.id, nextId);
      assert.equal(f.owner.current.current.phase, 'recording');
      assert.equal(f.deleted.length, 1);
      await f.run(() => f.hook.cancel());
    } finally { await f.unmount(); }
  });
}

test('opening and typing do not register, capture or parse; text is durable without advancing content revision', async () => {
  const f = fixture(); await f.mount();
  assert.deepEqual(f.calls, []);
  await f.run(() => f.hook.setText('明天还书'));
  assert.equal(f.owner.current.current.latestInputText, '明天还书');
  assert.equal(f.owner.current.current.revision, 1);
  await f.run(() => f.owner.flush());
  assert.equal(f.persisted.at(-1).latestInputText, '明天还书');
  assert.deepEqual(f.calls, []);
  await f.unmount();
});

test('initial text fills the same draft; a manual change fences a late result while retaining input', async () => {
  const f = fixture(); await f.mount();
  await f.run(() => f.hook.submit('明天还书'));
  assert.equal(f.owner.current.current.phase, 'parsing');
  await f.run(() => f.owner.change(d => f.domain.editScheduleFields(d, { title: '手动内容' })));
  await f.run(() => f.parseGate.resolve(parsed()));
  assert.equal(f.owner.current.current.title, '手动内容');
  assert.equal(f.owner.current.current.latestInputText, '明天还书');
  assert.equal(f.owner.current.current.phase, 'editing');
  assert.match(f.hook.error, /重新应用/);
  await f.unmount();
});

test('successful initial input stays inline, preserves exact minutes, and offers one undo', async () => {
  const f = fixture(); f.result(parsed()); await f.mount();
  await f.run(() => f.hook.submit('明天九点二十三还书'));
  assert.equal(f.owner.current.current.id, 'draft-1');
  assert.equal(f.owner.current.current.phase, 'editing');
  assert.equal(f.owner.current.current.time.startTime, '09:23');
  assert.equal(f.owner.current.current.time.endTime, null);
  assert.ok(f.owner.current.current.lastUndo);
  await f.run(() => f.hook.undo());
  assert.equal(f.owner.current.current.title, '');
  assert.equal(f.owner.current.current.latestInputText, '明天九点二十三还书');
  await f.unmount();
});

test('replacement uses only the fresh input and its fixed clock, never sends the old draft to edit', async () => {
  const f = fixture();
  const seed = f.domain.createScheduleEditorDraft({ id: 'same-draft', saveRequestId: 'same-save', startDate: '2026-09-03',
    dateOrigin: 'manual', eventRef: { sourceEventId: 'original', occurrenceDate: '2026-09-03' }, eventRevision: 4,
    content: { title: '旧事项', location: '旧地点', notes: '旧备注' } });
  const pending = f.domain.beginScheduleEditorInput(seed, { id: 'fresh', mode: 'replace', text: '去取快递',
    referenceDatetime: '2026-10-28T16:00:01.000Z', timezone: 'Asia/Shanghai' });
  f.result({ ...parsed(), title: '取快递', start_date: '', start_time: null, date_resolution: 'omitted' });
  f.parseGate.resolve({ ...parsed(), title: '取快递', start_date: '', start_time: null, date_resolution: 'omitted' });
  const observation = await f.parsing.observeScheduleEditorInput(pending);
  assert.deepEqual(f.calls, [['parse', '去取快递', { reference_datetime: '2026-10-28T16:00:01.000Z', timezone: 'Asia/Shanghai' }]]);
  const changed = f.domain.applyScheduleEditorInput(pending, { id: 'fresh', sequence: 1, baseRevision: 1 },
    observation.changes, observation.origins).draft;
  assert.equal(changed.startDate, '2026-10-29');
  assert.equal(changed.fieldOrigins.startDate, 'default');
  assert.equal(changed.location, ''); assert.equal(changed.notes, '');
  assert.equal(changed.mode, 'edit'); assert.deepEqual(changed.eventRef, seed.eventRef);
  assert.equal(changed.saveRequestId, seed.saveRequestId);
});

test('replacement voice fills the same draft once and preserves explicit unresolved date', async () => {
  const f = fixture();
  await f.mount({ title: '旧事项', location: '旧地点', repeat: 'weekly', recurrenceWeekdays: [1, 3],
    time: { precision: 'exact', period: null, startTime: '09:23', endTime: null }, reminderMinutes: 10 });
  try {
    await f.run(() => f.hook.start('replace'));
    assert.equal(f.owner.current.current.title, '旧事项', 'recording must not clear visible content');
    await f.run(() => f.listeners.transcript({ sessionId: 'session-1', segmentId: 's1', text: '改天去取快递', isFinal: true, receivedAtMs: 1 }));
    await f.run(() => f.hook.stop());
    assert.equal(f.owner.current.current.phase, 'parsing');
    assert.equal(f.owner.current.current.location, '旧地点', 'awaiting interpretation must not clear content');
    await f.run(() => f.parseGate.resolve({ ...parsed(), title: '取快递', start_date: '', start_time: null, date_resolution: 'unresolved' }));
    assert.equal(f.owner.current.current.id, 'draft-1');
    assert.equal(f.owner.current.current.phase, 'editing');
    assert.equal(f.owner.current.current.startDate, null);
    assert.equal(f.owner.current.current.title, '取快递');
    assert.equal(f.owner.current.current.location, '');
    assert.equal(f.owner.current.current.repeat, 'once');
    assert.equal(f.owner.current.current.reminderMinutes, null);
    assert.equal(f.calls.filter(([kind]) => kind === 'parse').length, 1);
    assert.equal(f.calls.filter(([kind]) => kind === 'edit').length, 0);
    assert.equal(f.persisted.at(-1).title, '取快递');
    await f.run(() => f.hook.undo());
    assert.equal(f.owner.current.current.title, '旧事项');
    assert.equal(f.owner.current.current.location, '旧地点');
    assert.equal(f.owner.current.current.time.startTime, '09:23');
    assert.equal(f.owner.current.current.latestInputText, '改天去取快递');
  } finally { await f.unmount(); }
});

for (const boundary of ['failure', 'cancel', 'manual']) test(`replacement ${boundary} preserves the previous draft atomically`, async () => {
  const f = fixture(); await f.mount({ title: '旧事项', location: '旧地点', notes: '旧备注' });
  try {
    await f.run(() => f.hook.start('replace'));
    await f.run(() => f.listeners.transcript({ sessionId: 'session-1', segmentId: 's1', text: '明天还书', isFinal: true, receivedAtMs: 1 }));
    await f.run(() => f.hook.stop());
    if (boundary === 'failure') await f.run(() => f.parseGate.reject(new Error('临时不可用')));
    else {
      await f.run(() => boundary === 'cancel' ? f.hook.cancel() : f.owner.change(d => f.domain.editScheduleFields(d, { location: '手动新地点' })));
      await f.run(() => f.parseGate.resolve(parsed()));
    }
    assert.equal(f.owner.current.current.phase, 'editing');
    assert.equal(f.owner.current.current.title, '旧事项');
    assert.equal(f.owner.current.current.location, boundary === 'manual' ? '手动新地点' : '旧地点');
    assert.equal(f.owner.current.current.notes, '旧备注');
    assert.equal(f.owner.current.current.latestInputText, '明天还书');
    assert.equal(f.owner.current.current.lastUndo, null);
    assert.equal(f.calls.filter(([kind]) => kind === 'parse').length, 1);
    assert.equal(f.calls.filter(([kind]) => kind === 'edit').length, 0);
  } finally { await f.unmount(); }
});

test('release while native capture is still starting queues one stop, not a second start or save', async () => {
  const f = fixture(); f.result(parsed()); f.startBlocked(); await f.mount();
  await f.run(() => f.hook.start());
  await f.run(() => f.hook.stop());
  assert.equal(f.owner.current.current.phase, 'recording');
  await f.run(() => f.listeners.transcript({ sessionId: 'session-1', segmentId: 's1', text: '明天还书', isFinal: true, receivedAtMs: 1 }));
  assert.equal(f.owner.current.current.phase, 'recording', 'partial text cannot advance phase');
  await f.run(() => f.startGate.resolve({ captureStartedAtMs: Date.now() }));
  assert.equal(f.calls.filter(c => c[0] === 'start').length, 1);
  assert.equal(f.calls.filter(c => c[0] === 'stop').length, 1);
  assert.equal(f.owner.current.current.phase, 'editing');
  assert.equal(f.owner.current.current.title, '归还图书');
  assert.deepEqual(f.deleted, ['file:///input.wav']);
  await f.unmount();
});

test('cancel/background fences current requests, preserves fields/text and never falls back to old clarification', async () => {
  const f = fixture(); await f.mount({ title: '已编辑内容', location: '原地点' });
  await f.run(() => f.hook.submit('换到社区图书馆'));
  assert.equal(f.calls[0][0], 'edit');
  await f.run(() => f.background());
  assert.equal(f.calls[0][3].aborted, true);
  await f.run(() => f.parseGate.resolve({ status: 'patch', changes: { location: '社区图书馆' } }));
  assert.equal(f.owner.current.current.title, '已编辑内容');
  assert.equal(f.owner.current.current.location, '原地点');
  assert.equal(f.owner.current.current.latestInputText, '换到社区图书馆');
  assert.equal(f.owner.current.current.phase, 'editing');
  assert.equal(f.calls.filter(c => c[0] === 'parse').length, 0);
  await f.unmount();
});

test('failed initial input stays an initial retry, but real manual fields require current-draft editing', async () => {
  const f = fixture(); await f.mount();
  await f.run(() => f.hook.submit('晚上吃饭'));
  await f.run(() => f.parseGate.reject(new Error('临时不可用')));
  assert.equal(f.parsing.defaultScheduleEditorInputMode(f.owner.current.current), 'initial');
  await f.run(() => f.owner.change(d => f.domain.editScheduleFields(d, { time: { precision: 'period', period: 'night', startTime: null, endTime: null } })));
  assert.equal(f.parsing.defaultScheduleEditorInputMode(f.owner.current.current), 'patch');
  await f.unmount();
});
