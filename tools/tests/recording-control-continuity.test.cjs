const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function callback(file, name, dependencies) {
  const source = ts.createSourceFile(file, fs.readFileSync(path.resolve(__dirname, '../..', file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let fn;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) {
      fn = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(fn && ts.isArrowFunction(fn), `production callback ${name}`);
  const code = ts.transpileModule(`const result = ${fn.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(dependencies), `${code}; return result;`)(...Object.values(dependencies));
}
const liveFile = 'src/screens/MeetingLiveScreen.android.tsx';
const fenceModule = { exports: {} };
new Function('exports', ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../src/native/projectionActionFence.ts'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(fenceModule.exports);
const { fenceNativeRecordingControl } = fenceModule.exports;
const control = { surfaceId: 'live-page', sessionStartedAtMs: 1000 };

test('a committed recording shell survives its own list invalidation without a full read barrier', async () => {
  const statusModule = { exports: {} };
  new Function('require', 'module', 'exports', ts.transpileModule(fs.readFileSync(path.resolve(__dirname,
    '../../src/services/meetingListProjection.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText)(() => ({ Colors: {} }), statusModule, statusModule.exports);
  const mediaModule = { exports: {} };
  new Function('exports', ts.transpileModule(fs.readFileSync(path.resolve(__dirname,
    '../../src/utils/meetingMedia.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText)(mediaModule.exports);
  const existing = { id: 'existing' };
  const initial = { meetings: [existing], transcripts: {}, summaries: {}, canonicalIdByLegacyId: { existing: 'existing' } };
  for (const invalidate of [true, false]) {
    const canonicalReadProjectionRef = { current: initial };
    const meetingsRef = { current: [existing] };
    const generationRef = { current: 1 };
    let writes = 0, displayed;
    const note = { id: 'own-recording', recordedAtMs: 1000, createdAtMs: 1000, updatedAtMs: 1000,
      title: '', participants: [], mode: 'realtime', lifecycle: 'draft' };
    const invoke = callback('src/store/MeetingsStore.tsx', 'createCanonicalGuestMeeting', {
      generationRef, activeScopeRef: { current: 'guest' }, scope: 'guest', canonicalReadProjectionRef,
      ensureCanonicalProjectionReady: () => assert.fail('initial projection already available'),
      canonicalStoreMutationDepthRef: { current: 0 }, secureClientIdFactory: { create: () => note.id },
      createCanonicalMeetingNote: { execute: async () => {
        writes++;
        if (invalidate) canonicalReadProjectionRef.current = null;
        return { created: true, canonicalRevision: 7, aggregate: { note, processingStages: [{ stage: 'capture', status: 'not_started' }] } };
      } },
      loadCanonicalOwnedScope: () => assert.fail('refresh failure cannot negate a committed create'),
      statusTag: () => ({ label: '准备', color: 'blue' }), C: { teal: 'teal' },
      compatibilityStatus: statusModule.exports.compatibilityStatus,
      adoptCanonicalOwnedProjection: owned => {
        canonicalReadProjectionRef.current = owned.projection;
        displayed = owned.projection.meetings;
        return true;
      }, meetingsRef, setMeetings: value => { displayed = value; },
    });
    const result = await invoke('', { fastLocalResult: true }, 1);
    assert.equal(result.id, note.id);
    assert.equal(result.status, 'created');
    assert.equal(mediaModule.exports.canResumeMeetingRecording(result), true);
    assert.equal(mediaModule.exports.canResumeMeetingRecording({ ...result, audioAvailable: true }), false);
    assert.equal(mediaModule.exports.canResumeMeetingRecording({ ...result, audioLocalUri: 'file:///existing.wav' }), false);
    assert.equal(statusModule.exports.compatibilityStatus({ lifecycle: 'draft', stages: [{ stage: 'capture', status: 'preparing' }] }), 'processing');
    assert.equal(writes, 1);
    assert.deepEqual(displayed.map(item => item.id), ['own-recording', 'existing']);
    if (invalidate) assert.equal(canonicalReadProjectionRef.current, null, 'observer still owes a full refresh');
  }
});

function live(overrides = {}) {
  const calls = [];
  const active = { meetingId: 'meeting', sessionId: 'meeting', startedAtMs: 1000 };
  const deps = {
    mountedRef: { current: true }, navigation: { isFocused: () => true, goBack: () => calls.push('back') },
    manualNote: { flush: () => new Promise(() => {}) }, recordingSurfaceId: control.surfaceId,
    recordingControllerRef: { current: { current: () => active } },
    activeMeetingIdRef: { current: 'meeting' }, recorderSnapshotRef: { current: { startedAtMs: 1000 } },
    fenceNativeRecordingControl,
    fenceNativeProjectionAction: () => { throw Error('capture control cannot wait for a content projection'); },
    confirmStop: () => calls.push('stop'), togglePause: resume => calls.push(resume ? 'resume' : 'pause'),
    startRecording: () => calls.push('start'), retryTranscriptCache: () => calls.push('retry'), phase: 'recording',
    diagnosticAudit: (name, value) => calls.push({ name, ...value }), ...overrides,
  };
  const invoke = callback(liveFile, 'handleAction', deps);
  const send = (type, extra = {}) => invoke({ type, surface: 'recording', meetingId: 'meeting', recordingControl: control, ...extra });
  return { calls, send, active, deps };
}

test('back, start, retry, pause, resume and stop use their own owner while body hash is pending', () => {
  const f = live();
  for (let i = 0; i < 100; i++) {
    f.send('toggleRecordingPause', { resume: false });
    f.send('toggleRecordingPause', { resume: true });
  }
  f.send('stopRecording'); f.send('retryRecording'); f.send('startRecording'); f.send('back');
  assert.deepEqual(f.calls.slice(-4), ['stop', 'retry', 'start', 'back']);
  assert.equal(f.calls.filter(value => value === 'pause').length, 100);
  assert.equal(f.calls.filter(value => value === 'resume').length, 100);
});

test('old surface, same-meeting old capture, cross-meeting and inactive controls fail closed', () => {
  const f = live();
  f.send('stopRecording', { recordingControl: { ...control, surfaceId: 'previous-page' } });
  f.send('stopRecording', { recordingControl: { ...control, sessionStartedAtMs: 999 } });
  f.send('stopRecording', { meetingId: 'other' });
  f.send('stopRecording', { recordingControl: null });
  assert.ok(f.calls.every(item => item.name === 'native_recording_control_rejected'));
  assert.deepEqual(f.calls.map(item => item.reason), ['recording_surface_stale', 'recording_capture_stale', 'recording_meeting_stale', 'recording_surface_stale']);
  const inactive = live({ recordingControllerRef: { current: { current: () => null } } });
  inactive.send('stopRecording');
  assert.equal(inactive.calls[0].reason, 'recording_capture_inactive');
  for (const value of [NaN, -1, 1.5]) {
    assert.equal(fenceNativeRecordingControl({ ...control, meetingId: 'meeting', active: true },
      { meetingId: 'meeting', recordingControl: { ...control, sessionStartedAtMs: value } }, true).accepted, false);
  }
  const unfocused = live({ navigation: { isFocused: () => false } });
  unfocused.send('stopRecording'); unfocused.send('back'); assert.equal(unfocused.calls.length, 0);
});

test('idle capture can start before a body checkpoint, but note mutations still require the exact projection', () => {
  const idle = live({ recordingControllerRef: { current: { current: () => null } }, recorderSnapshotRef: { current: null } });
  idle.send('startRecording', { recordingControl: { ...control, sessionStartedAtMs: 0 } });
  assert.deepEqual(idle.calls, ['start']);
  const guarded = live({ currentProjectionRef: { current: null }, fenceNativeProjectionAction: () => ({ accepted: false, reason: 'projection_pending' }) });
  guarded.send('saveTitle', { title: 'new title' });
  assert.equal(guarded.calls[0].reason, 'projection_pending');
});

test('pause/resume expresses a target state and never reverses a delayed duplicate', async () => {
  let state = 'recording'; const calls = [];
  const active = { sessionId: 'meeting', meetingId: 'meeting', startedAtMs: 1000 };
  const snapshot = { current: { startedAtMs: 1000, state } };
  const invoke = callback(liveFile, 'togglePause', {
    recordingControllerRef: { current: { current: () => active, isFinalizing: () => false } }, recorderSnapshotRef: snapshot,
    setError() {}, pauseNativeRecorder: async id => { calls.push(['pause', id]); return { startedAtMs: 1000, state: 'paused' }; },
    resumeNativeRecorder: async id => { calls.push(['resume', id]); return { startedAtMs: 1000, state: 'recording' }; },
    applyRecorderSnapshot: value => { snapshot.current = value; }, updateMeetingStatus: async () => {},
  });
  await invoke(false); await invoke(false); await invoke(true); await invoke(true);
  assert.deepEqual(calls, [['pause', 'meeting'], ['resume', 'meeting']]);
});

test('an old stop confirmation cannot end a replacement capture', async () => {
  const first = { meetingId: 'meeting', sessionId: 'meeting', startedAtMs: 1000 };
  let active = first, dialog, finalizations = 0;
  const pending = new Promise(() => {});
  const deps = { recordingControllerRef: { current: { current: () => active, isFinalizing: () => false } },
    manualNote: { flush: () => Promise.resolve() }, diagnosticWarn() {},
    finalizeActiveRecording: () => { finalizations++; return pending; } };
  const stopRecording = callback(liveFile, 'stopRecording', deps);
  callback(liveFile, 'confirmStop', { ...deps, stopRecording, showDialog: value => { dialog = value; } })();
  active = { ...first, startedAtMs: 2000 };
  await dialog.actions[0].onPress(); assert.equal(finalizations, 0);
  assert.equal(await stopRecording(true, first), false);
});

test('duplicate stop commands share the existing controller finalization', async () => {
  const m = { exports: {} };
  new Function('exports', ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../src/application/meeting/recordingSessionController.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText)(m.exports);
  const owner = new m.exports.RecordingSessionController();
  let finish, writes = 0;
  const session = { meetingId: 'meeting', sessionId: 'meeting', finalize: () => { writes++; return new Promise(resolve => { finish = resolve; }); } };
  assert.equal(owner.completeStart(owner.beginStart(), session), true);
  const first = owner.finalizeActive(false), duplicate = owner.finalizeActive(true);
  assert.ok(first === duplicate);
  await Promise.resolve(); assert.equal(writes, 1);
  finish('saved'); const result = await first;
  assert.equal(result.navigateAfter, true); assert.equal(owner.current(), null);
});

test('recycle restoration is one direct action and duplicate taps do not start a second write', async () => {
  const calls = []; let finish;
  const invoke = callback('src/screens/MeetingListScreen.android.tsx', 'restoreMeeting', {
    recycleBinEntries: [{ meetingId: 'own-test' }], retentionDays: 30, restoringMeetingIdRef: { current: null },
    setRestoringMeetingId: value => calls.push(['state', value]),
    restoreDeletedMeeting: (...args) => { calls.push(['restore', ...args]); return new Promise(resolve => { finish = resolve; }); },
    refreshRecycleBin: async () => calls.push(['refresh']), showDialog: () => { throw Error('no redundant confirmation'); },
  });
  const first = invoke('own-test'); await invoke('own-test'); await invoke('other');
  assert.deepEqual(calls, [['state', 'own-test'], ['restore', 'own-test', 30]]);
  finish(); await first;
  assert.deepEqual(calls.slice(-2), [['refresh'], ['state', null]]);
});
