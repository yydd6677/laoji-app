const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
function load(native) {
  const target = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname,
    '../../src/services/meetingCaptureOwnership.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', code)(() => native, target, target.exports);
  return target.exports;
}
test('active, paused, interrupted and finishing board sessions never belong to microphone recovery', async () => {
  const ids = await load({ hasNativeHardwareSupport: () => true,
    listHardwareRealtimeSessions: async () => ['recording', 'paused', 'interrupted', 'finished']
      .map(capturePhase => ({ meetingId: `board-${capturePhase}`, capturePhase })),
  }).loadExternalCaptureMeetingIds();
  assert.deepEqual([...ids], ['board-recording', 'board-paused', 'board-interrupted', 'board-finished']);
});
test('an unavailable hardware owner is unknown, while unsupported hardware leaves phone recovery available', async () => {
  assert.equal(await load({ hasNativeHardwareSupport: () => true,
    listHardwareRealtimeSessions: async () => { throw Error('bridge unavailable'); },
  }).loadExternalCaptureMeetingIds(), null);
  assert.equal((await load({ hasNativeHardwareSupport: () => false }).loadExternalCaptureMeetingIds()).size, 0);
});
test('meeting list checks the actual external owner before querying microphone state', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/screens/MeetingListScreen.android.tsx'), 'utf8');
  const guard = source.indexOf('if (externalIds === null || externalIds.has(meeting.id))');
  const microphone = source.indexOf('await getNativeRecorderState(meeting.id)', guard);
  assert.ok(guard > 0 && microphone > guard);
  assert.match(source.slice(guard, microphone), /return \{ meetingId: meeting.id, kind: 'unknown'/);
});
