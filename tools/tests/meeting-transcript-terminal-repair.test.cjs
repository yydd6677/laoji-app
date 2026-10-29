const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

async function runRepair(canonical) {
  const compiled = ts.transpileModule(fs.readFileSync(path.resolve(__dirname,
    '../../src/components/DeviceMeetingCompletionProvider.tsx'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const target = { exports: {} };
  const calls = [];
  let effect;
  const requireMock = name => {
    if (name === 'react') return { useRef: current => ({ current }), useEffect: callback => { effect = callback; } };
    if (name === 'react-native') return { AppState: { addEventListener: () => ({ remove() {} }) } };
    if (name.endsWith('MeetingsStore')) return { useMeetings: () => ({
      meetings: [{ id: 'meeting', hasTranscript: true }], loading: false,
      refreshMeetings: async () => calls.push('refresh'),
    }) };
    if (name.endsWith('deviceTranscriptTasks')) return {
      listPendingDeviceTranscriptTasks: async () => [], getDeviceTranscriptTask: async () => null,
      subscribeDeviceTranscriptTaskChanged: () => () => {},
    };
    if (name.endsWith('meetingTranscriptState')) return { loadActiveMeetingTranscriptState: async () => canonical };
    if (name.endsWith('meetingStageMirror')) return {
      mirrorDeviceTranscriptTaskTerminal: async () => { calls.push('repair'); return true; },
    };
    if (name.endsWith('diagnostics')) return { diagnosticWarn: () => calls.push('warning') };
    return {};
  };
  new Function('require', 'module', 'exports', 'setTimeout', 'clearTimeout', compiled)(
    requireMock, target, target.exports, () => 1, () => {});
  target.exports.DeviceMeetingCompletionProvider();
  const cleanup = effect();
  await new Promise(resolve => setImmediate(resolve));
  cleanup();
  return calls;
}

for (const [label, state] of [
  ['missing local content', null],
  ['durable realtime draft', { kind: 'realtime_draft', completing: false }],
  ['final still owned by completion', { kind: 'final', completing: true }],
]) {
  test(`opportunistic stage repair leaves ${label} to its writer`, async () => {
    assert.deepEqual(await runRepair(state), []);
  });
}
test('opportunistic repair closes a readable canonical final only', async () => {
  assert.deepEqual(await runRepair({ kind: 'final', completing: false }), ['repair', 'refresh']);
});
