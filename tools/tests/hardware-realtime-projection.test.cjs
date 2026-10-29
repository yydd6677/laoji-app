const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const target = { exports: {} };
new Function('require', 'module', 'exports', ts.transpileModule(fs.readFileSync(path.resolve(__dirname,
  '../../src/services/hardwareRealtimeProjection.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(() => { throw Error('unexpected runtime dependency'); }, target, target.exports);
const project = target.exports.projectHardwareRealtimeDraft;
const capture = target.exports.projectHardwareCapture;
const projectionKey = target.exports.hardwareRealtimeProjectionKey;
const order = target.exports.orderHardwareRealtimeSessions;
const first = { sequence: 1, id: 'one', text: '讨论进展', startMs: 1200, endMs: 3400, speaker: null };
const session = { meetingId: 'meeting-one', sessionId: 'hwrt-one', preview: '尚未稳定的预览', events: [first] };
test('partial-only preview changes never invalidate the durable projection', () => {
  assert.equal(projectionKey(session), projectionKey({ ...session, preview: '又一个尚未稳定的预览' }));
});
test('source event corrections, capture state and transport outcomes invalidate projection', () => {
  const key = projectionKey(session);
  for (const next of [{ ...session, events: [{ ...first, text: '更正的稳定内容' }] },
    { ...session, events: [] }, { ...session, capturePhase: 'paused' },
    { ...session, asrPhase: 'unavailable' }, { ...session, inputEnded: true },
    { ...session, audioReady: true }, { ...session, hasGap: true }]) {
    assert.notEqual(key, projectionKey(next));
  }
});
test('preview optimization keeps periodic/local-state repair and failed retries alive', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/components/HardwareRealtimeCoordinator.tsx'), 'utf8');
  assert.match(source, /if \(!force && !attachDue && projected\.get\(id\) === projectionKey\) continue/);
  assert.match(source, /setInterval\(\(\) => \{ void run\(true\); \}, 3_000\)/);
  assert.match(source, /forceRerun = forceRerun \|\| force/);
});
test('live sources precede pending stable events and history without mutating the native list', () => {
  const original = [
    { ...session, meetingId: 'history', inputEnded: true, events: [], recordedAtMs: 900 },
    { ...session, meetingId: 'pending', inputEnded: true, recordedAtMs: 800 },
    { ...session, meetingId: 'older-live', inputEnded: false, recordedAtMs: 1 },
    { ...session, meetingId: 'current-live', inputEnded: false, recordedAtMs: 2 },
  ];
  assert.deepEqual(order(original).map(s => s.meetingId), ['current-live', 'older-live', 'pending', 'history']);
  assert.equal(original[0].meetingId, 'history');
});
test('ASR preparation starts after durable meeting creation but before a broad refresh', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/components/HardwareRealtimeCoordinator.tsx'), 'utf8');
  const durable = source.indexOf('if (!aggregate) continue;');
  const start = source.indexOf('void prepareDeviceV2RealtimeRecording(', durable);
  const refresh = source.indexOf('await current.current.refreshMeetings()', durable);
  assert.ok(durable > 0 && start > durable && refresh > start);
});
test('hardware owner repairs an erroneous failure even when its native phase did not change', () => {
  const live = { ...session, capturePhase: 'recording', audioReady: false };
  assert.equal(capture(live, 'failed_recoverable', false).status, 'recording');
  assert.equal(capture(live, 'recording', false), null);
  assert.equal(capture({ ...live, capturePhase: 'paused' }, 'failed_recoverable', false).status, 'paused');
});
test('only a verified file can complete hardware capture; a final asset wins over late live state', () => {
  const finished = { ...session, capturePhase: 'finished', audioReady: false };
  assert.equal(capture(finished, 'recording', false).status, 'finalizing');
  assert.equal(capture({ ...finished, audioReady: true }, 'finalizing', false).status, 'local_ready');
  assert.equal(capture({ ...finished, capturePhase: 'interrupted' }, 'recording', false).status, 'failed_recoverable');
  assert.equal(capture({ ...finished, capturePhase: 'recording' }, 'local_ready', true), null);
});
test('converts native milliseconds to transcript seconds and scopes meeting identity', () => {
  const { lines } = project(session, [], false);
  assert.equal(lines[0].meeting_id, session.meetingId);
  assert.equal(lines[0].start_time, 1.2); assert.equal(lines[0].end_time, 3.4);
});
test('successive batches never assign an immutable remote document ID to canonical-live', () => {
  assert.equal(project(session, [], false).remoteRevisionId, null);
  assert.equal(project({ ...session, events: [{ ...first, sequence: 2 }] }, [], false).remoteRevisionId, null);
});
test('replay replaces the stable key rather than duplicating text', () => {
  const previous = project(session, [], false).lines;
  const draft = project(session, previous, false);
  assert.equal(draft.lines.length, 1); assert.equal(draft.throughSequence, 1);
});
test('retains previous stable text and sorts subsequent source ranges', () => {
  const previous = project(session, [], false).lines;
  const draft = project({ ...session, events: [{ ...first, sequence: 2, id: 'zero', startMs: 0, endMs: 1000 }] }, previous, false);
  assert.deepEqual(draft.lines.map(l => l.id), ['zero', 'one']); assert.equal(draft.throughSequence, 2);
});
test('late live text cannot downgrade an already active final transcript', () => {
  assert.equal(project(session, [{ id: 'final', text: '完整文字' }], true), null);
});
test('preview-only messages never become canonical transcript content', () => {
  assert.equal(project({ ...session, events: [] }, [], false), null);
  assert.equal(project(session, [], false).lines.some(l => l.text === session.preview), false);
});
test('erase invalidates old callbacks even after a new installation workflow resumes', () => {
  const state = { exports: {} };
  new Function('require', 'module', 'exports', ts.transpileModule(fs.readFileSync(path.resolve(__dirname,
    '../../src/services/localDataEraseState.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText)(() => ({}), state, state.exports);
  const m = state.exports;
  const old = m.localDataEraseRevision();
  m.beginLocalDataErase(); assert.equal(m.isLocalDataErasing(), true);
  m.finishLocalDataErase(); assert.equal(m.isLocalDataErasing(), false);
  assert.notEqual(m.localDataEraseRevision(), old);
});
