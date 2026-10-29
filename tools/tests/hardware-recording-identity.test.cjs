const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const target = { exports: {} };
const compiled = ts.transpileModule(fs.readFileSync(require('node:path').resolve(__dirname,
  '../../src/services/hardwareRecordingIdentity.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
new Function('require', 'module', 'exports', compiled)(() => ({}), target, target.exports);
const match = target.exports.hasReceivedHardwareRecording;
const source = { recordingId: '讨论.wav', generation: 'gen-new' };
const local = { deviceId: 'board@address', sourceDeviceRecordingId: '讨论.wav',
  sourceGeneration: 'gen-new', sessionId: '讨论.wav' };
test('same board, filename and generation is already received', () => {
  assert.equal(match([local], local.deviceId, source), true);
});
test('reused filename with a new generation can be received', () => {
  assert.equal(match([{ ...local, sourceGeneration: 'gen-old' }], local.deviceId, source), false);
});
test('another board or legacy session name does not block a source', () => {
  assert.equal(match([local], 'other-board', source), false);
  assert.equal(match([{ ...local, sourceGeneration: null, sourceDeviceRecordingId: null }], local.deviceId, source), false);
  assert.equal(match([local], null, source), false);
});
test('a name-only preview is not proof of an already received generation', () => {
  assert.equal(match([{ ...local, sourceGeneration: null }], local.deviceId, { ...source, generation: null }), false);
});
test('adopted canonical media stays received after pending cleanup and page restart', () => {
  const item = { ...source, localRecordingId: 'stable-asset' };
  const storedIds = new Set(['stable-asset']);
  assert.equal(match([local], local.deviceId, item, storedIds), true);
  assert.equal(match([], local.deviceId, item, storedIds), true);
  assert.equal(match([], local.deviceId, JSON.parse(JSON.stringify(item)), new Set(storedIds)), true);
});
test('missing/deleted canonical media and a different generation do not invent a receipt', () => {
  assert.equal(match([], local.deviceId, { ...source, localRecordingId: 'old' }, new Set()), false);
  assert.equal(match([], local.deviceId, { ...source, localRecordingId: 'new' }, new Set(['old'])), false);
  assert.equal(match([], null, { ...source, localRecordingId: 'old' }, new Set(['old'])), false);
  assert.equal(match([], local.deviceId, { ...source, generation: null, localRecordingId: 'old' }, new Set(['old'])), false);
});
