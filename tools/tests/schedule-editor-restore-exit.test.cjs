const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const React = require('react');
const Renderer = require('react-test-renderer');
global.IS_REACT_ACT_ENVIRONMENT = true;
const { act } = Renderer;

function compile(file, modules) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true,
  } }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    if (!Object.hasOwn(modules, name)) throw Error(`unexpected dependency ${name}`);
    return modules[name];
  }, module, module.exports);
  return module.exports;
}

function routeFixture({ restore = true, restoring = false, error = true, editEvent = null, params = null, savedRef = null,
  storedFollowup = null } = {}) {
  const calls = [], dialogs = [], handlers = {};
  let events = editEvent ? [editEvent] : [], mounts = 0;
  const blank = { title: '', startDate: '2026-10-28', endDate: '2026-10-28', startTime: null, endTime: null,
    isAllDay: false, timePrecision: 'unspecified', timePeriod: null, repeat: 'once', recurrenceUntilDate: null,
    reminderMinutes: null, location: '', notes: '' };
  const flat = value => ({ ...blank, ...value, endDate: value.endDate ?? value.startDate,
    startTime: value.time?.startTime ?? null, endTime: value.time?.endTime ?? null });
  const navigation = { addListener: (name, handler) => { handlers[name] = handler; return () => {}; },
    setParams() {}, goBack: () => calls.push('back'), dispatch: action => calls.push(['dispatch', action]),
    popTo: (...args) => calls.push(['popTo', ...args]),
    replace: (...args) => calls.push(['replace', ...args]) };
  const input = { cancel: () => calls.push('cancel-input') };
  const modules = {
    react: React, 'react-native': { View: 'view', StyleSheet: { create: x => x } },
    '../components/ScheduleEditorSurface': { ScheduleEditorSurface: 'surface' },
    '../components/ScreenContainer': { ScreenContainer: 'screen' },
    '../components/AppActionSheet': { AppActionSheet: 'sheet' }, '../components/AppToast': { AppToast: 'toast' },
    '../components/AppDialog': { useAppDialog: () => ({ showDialog: value => dialogs.push(value) }) },
    '../store/EventsStore': { useEvents: () => ({ events, searchableEvents: [], loading: false }) },
    '../services/notifications': { REMINDER_OPTIONS: [], defaultReminderForEvent: () => null,
      loadNotificationPrefs: async () => ({ defaultReminderMinutes: null }) },
    '../utils/eventColors': { normalizeEventCategory: value => value ?? '其他' },
    '../services/clientRequestId': { createClientRequestState: prefix => ({ id: prefix + '-owned-test' }) },
    '../utils/eventIdentity': {}, '../utils/eventRecurrence': { resolveEventReference: (values, ref) =>
      values.find(value => value.id === ref.sourceEventId && value.startDate === ref.occurrenceDate) }, '../utils/eventDraftValidation': {},
    '../services/recurrenceActions': { canEditRecurrenceRule: () => true, canStopRecurringSeries: () => true,
      resolveRecurrenceEditScope: (_event, scope) => scope ?? 'series' }, '../services/currentAddress': {}, '../services/meetingActionFollowup': {},
    '../services/errors': { readableErrorMessage: (_reason, fallback) => fallback },
    '../native/nativeCalendarPages': { nativeCalendarEditDraft: value => ({ ...blank, ...value }),
      nativeDraftFromScheduleEditor: flat, scheduleEditorChangesFromNative: x => x, buildNativeCalendarEditSnapshot: x => x },
    '../utils/scheduleEventTime': { scheduleTimeForEvent: () => ({ precision: 'unspecified', period: null, startTime: null, endTime: null }) },
    '../domain/scheduleEditor': { createScheduleEditorDraft: value => ({ ...blank, ...value, ...value.content,
      latestInputText: restore ? '保留中的原话' : '', phase: 'editing', fieldOrigins: {}, lastUndo: null, stateRevision: 1 }),
      editScheduleFields: (previous, value) => ({ ...previous, ...value }) },
    '../hooks/useScheduleEditorDraft': { useScheduleEditorDraft: seed => {
      const current = React.useRef(seed);
      const instance = React.useRef(null); if (instance.current === null) { instance.current = ++mounts; }
      const [, render] = React.useReducer(value => value + 1, 0);
      const change = React.useCallback(fn => { current.current = fn(current.current); render(); return current.current; }, []);
      // The route seed is blank; a successful storage seam supplies the
      // persisted raw input after initialization, exactly as the real hook.
      if (restore && !restoring && !error) current.current.latestInputText = '保留中的原话';
      if (savedRef) Object.assign(current.current, { phase: 'saved', savedEventRef: savedRef });
      if (storedFollowup) current.current.followup = { params: storedFollowup, state: 'pending', attempts: 0, retryAtMs: 0 };
      return { draft: current.current, current, restoring, restoreError: error,
        change,
        flush: async () => { calls.push('flush'); if (error) throw Error('injected storage failure'); },
        discard: async () => { calls.push('discard'); if (error) throw Error('injected storage failure'); } };
    } },
    '../hooks/useScheduleEditorInput': { useScheduleEditorInput: () => input },
    '../theme/ThemeProvider': { useTheme: () => ({ colors: { primary: '#2675cc', body: '#fff' } }) },
  };
  const Screen = compile('src/screens/AddEventScreen.tsx', modules).AddEventScreen;
  let tree;
  const renderScreen = () => React.createElement(Screen, { navigation, route: { key: 'owned-editor', params: params ?? (editEvent
    ? { eventRef: { sourceEventId: editEvent.id, occurrenceDate: editEvent.startDate }, recurrenceScope: 'series' }
    : restore ? { editorDraftId: 'unread-draft' } : {}) } });
  return { calls, dialogs, handlers, mounts: () => mounts,
    surface: () => tree.root.findByType('surface').props,
    async publishEvents(values) { events = values; await act(async () => { tree.update(renderScreen()); }); },
    async actions(values) { await act(async () => { for (const value of values) tree.root.findByType('surface').props.onAction(value); }); },
    async mount() { await act(async () => { tree = Renderer.create(renderScreen()); }); },
    async cancel() { await act(async () => { tree.root.findByType('surface').props.onAction({ type: 'cancel' }); }); },
    async back() { const event = { data: { action: { type: 'GO_BACK' } }, preventDefault: () => this.calls.push('prevent-default') };
      await act(async () => { this.handlers.beforeRemove(event); }); },
    async close() { await act(async () => { tree.unmount(); }); },
  };
}

test('publishing the current edit at a new date keeps the same active editor baseline mounted', async () => {
  const event = { id: 'same-source', title: '旧安排', startDate: '2026-10-28', eventRevision: 4, repeat: 'once' };
  const f = routeFixture({ restore: false, error: false, editEvent: event }); await f.mount();
  try {
    assert.equal(f.surface().snapshot.draft.title, '旧安排'); assert.equal(f.mounts(), 1);
    await f.publishEvents([{ ...event, title: '新安排', startDate: '2026-11-04', eventRevision: 5 }]);
    assert.equal(f.mounts(), 1); assert.equal(f.surface().snapshot.state, 'ready');
    assert.equal(f.surface().snapshot.draft.title, '旧安排');
    assert.equal(f.surface().snapshot.message, undefined);
  } finally { await f.close(); }
});

test('reopening a saved moved edit resolves its durable receipt even though the old target no longer exists', async () => {
  const savedRef = { sourceEventId: 'same-source', occurrenceDate: '2026-11-04' };
  const f = routeFixture({ error: false, savedRef, params: { editorDraftId: 'saved-edit',
    eventRef: { sourceEventId: 'same-source', occurrenceDate: '2026-10-28' }, recurrenceScope: 'series' } });
  await f.mount();
  try { assert.deepEqual(f.calls, [['popTo', 'EventDetail', { eventRef: savedRef }]]); }
  finally { await f.close(); }
});

test('a receipt discovered while creating a route also exits instead of showing an unsaveable saved form', async () => {
  const savedRef = { sourceEventId: 'existing', occurrenceDate: '2026-11-04' };
  const f = routeFixture({ restore: false, error: false, savedRef }); await f.mount();
  try { assert.deepEqual(f.calls, [['popTo', 'EventDetail', { eventRef: savedRef }]]); }
  finally { await f.close(); }
});

test('saved adoption recovers its meeting destination from durable metadata without route followup', async () => {
  const followup = { meetingId: 'route-meeting', canonicalMeetingId: 'canonical-meeting', actionId: 'action', clientRequestId: 'save-action' };
  const f = routeFixture({ error: false, savedRef: { sourceEventId: 'already-created', occurrenceDate: '2026-11-04' },
    params: { editorDraftId: 'saved-action' }, storedFollowup: followup }); await f.mount();
  try {
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0][0], 'popTo'); assert.equal(f.calls[0][1], 'Transcription');
    assert.equal(f.calls[0][2].meetingId, 'route-meeting'); assert.equal(f.calls[0][2].actionId, 'action');
    assert.equal(f.dialogs.length, 0);
  } finally { await f.close(); }
});

test('editor echoes the latest native edit token with its draft, including batched and equal writes', async () => {
  const f = routeFixture({ restore: false, error: false }); await f.mount();
  try {
    const original = f.surface().snapshot.draft;
    await f.actions([
      { type: 'draftChange', draft: { ...original, title: '甲' }, nativeEditToken: 'view:1' },
      { type: 'draftChange', draft: { ...original, title: '甲乙' }, nativeEditToken: 'view:2' },
    ]);
    assert.equal(f.surface().snapshot.nativeEditAck, 'view:2');
    assert.equal(f.surface().snapshot.draft.title, '甲乙');
    await f.actions([{ type: 'draftChange', draft: { ...original, title: '甲乙' }, nativeEditToken: 'view:3' }]);
    assert.equal(f.surface().snapshot.nativeEditAck, 'view:3');
    await f.actions([{ type: 'draftChange', draft: { ...original, title: '可移植输入' } }]);
    assert.equal(f.surface().snapshot.draft.title, '可移植输入');
    assert.equal(f.surface().snapshot.nativeEditAck, 'view:3');
  } finally { await f.close(); }
});

for (const state of [{ restoring: true, error: false }, { restoring: true, error: true }, { restoring: false, error: true }]) {
  test(`unread stored draft leaves without writing/discarding: ${JSON.stringify(state)}`, async () => {
    const f = routeFixture(state); await f.mount();
    try { await f.cancel(); assert.deepEqual(f.calls, ['back']); assert.equal(f.dialogs.length, 0); }
    finally { await f.close(); }
  });
}
test('system back uses the same unread-draft exit; fresh or loaded edits retain persistence protection', async () => {
  const unread = routeFixture(); await unread.mount();
  try { await unread.back(); assert.deepEqual(unread.calls, ['prevent-default', ['dispatch', { type: 'GO_BACK' }]]); }
  finally { await unread.close(); }
  const fresh = routeFixture({ restore: false }); await fresh.mount();
  try { await fresh.cancel(); assert.equal(fresh.calls.includes('back'), false); assert.equal(fresh.dialogs.length, 1);
    assert.equal(fresh.calls.includes('discard'), true); }
  finally { await fresh.close(); }
  const loaded = routeFixture({ error: false }); await loaded.mount();
  try { await loaded.cancel(); assert.deepEqual(loaded.calls, ['cancel-input', 'flush', 'back']); }
  finally { await loaded.close(); }
});

test('the real draft hook does not restart unread restore on background or unmount', async () => {
  let hook, listener, reads = 0, writes = 0;
  const modules = { react: React, 'react-native': { AppState: { addEventListener: (_name, fn) => {
    listener = fn; return { remove() {} };
  } } }, '../domain/scheduleEditor': { assertScheduleEditorDraft() {} },
    '../services/diagnostics': { diagnosticWarn() {} },
    '../data/repositories/scheduleEditorRepository': {
      loadStoredScheduleEditorDraft: async () => { reads++; throw Error('injected unavailable storage'); },
      createStoredScheduleEditorDraft: async () => { throw Error('unread restore cannot create'); },
      persistScheduleEditorDraft: async () => { writes++; return true; },
    } };
  const useDraft = compile('src/hooks/useScheduleEditorDraft.ts', modules).useScheduleEditorDraft;
  const seed = { id: 'existing-draft', stateRevision: 1 };
  function Harness() { hook = useDraft(seed, true); return null; }
  let tree; await act(async () => { tree = Renderer.create(React.createElement(Harness)); });
  assert.equal(hook.restoreError, true); assert.equal(reads, 1);
  await act(async () => { listener('background'); }); assert.equal(reads, 1);
  await act(async () => { tree.unmount(); }); assert.equal(reads, 1); assert.equal(writes, 0);
});
