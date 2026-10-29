const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const { createHash } = require('node:crypto');

function fixture(epoch = 'epoch') {
  const calls = [], execution = [];
  const binding = { deviceEpochId: epoch, bindingId: 'binding', bindingGeneration: 'generation',
    bindingRevision: 1, cancelRevision: 0 };
  const evidence = { meetingId: 'meeting', sourceFingerprint: 'source', transcriptRevisionId: 'transcript',
    includeManualNote: false, hasManualNote: false, manualNoteRevision: null,
    attachmentSelectionSha256: 'attachments', transcript: [], attachments: [] };
  const thread = { threadId: 'thread', snapshotId: 'snapshot', meetingId: 'meeting', turns: [] };
  const deps = {
    'expo-crypto': { CryptoDigestAlgorithm: { SHA256: 'SHA256' },
      digestStringAsync: async (_, s) => createHash('sha256').update(s).digest('hex') },
    '../domain/meeting': { secureClientIdFactory: { create: () => 'operation' } },
    './deviceV2Api': { loadDeviceV2Capabilities: async () => ({ questionReaderV2: true }),
      ensureDeviceV2Session: async () => ({ epochId: 'epoch' }) },
    './deviceAuthority': {
      ensureLocalMeetingServiceBinding: async () => { calls.push('local'); return binding; },
      ensureRemoteMeetingServiceBinding: async () => { throw Error('remote owner invoked before transport'); },
    },
    '../data/repositories/vnext/questionQ2Repository': { getQ2Thread: async () => thread,
      Q2ActivationFenceError: class extends Error {} },
    '../data/repositories/vnext/deviceOperationsRepository': {
      createDeviceOperation: async value => { calls.push('persist'); return { ...value, remoteState: 'queued', operationRevision: 1 }; },
      getDeviceOperation: async () => ({ remoteState: 'running', operationRevision: 1 }),
      updateDeviceOperation: async value => ({ ...value, remoteState: value.state, operationRevision: 2 }),
    },
    './questionQ2Execution': { executeQ2: async value => { calls.push('transport'); execution.push(value); } },
    './questionQ2DeviceProvider': { createDeviceQ2Provider: () => ({ read() {} }) },
    './diagnostics': { diagnosticAudit() {}, diagnosticWarn() {} },
  };
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../src/services/meetingQuestionsQ2.ts'), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'module', 'exports', code)(name => deps[name] ?? {}, module, module.exports);
  return { calls, execution, run: () => module.exports.askQ2MeetingQuestion({
    evidence, session: { evidence, thread: { id: 'thread', inputFingerprint: 'source' } }, question: '谁跟进？' }) };
}

test('question owner persists local intent before transport without duplicating registration', async () => {
  const f = fixture();
  await f.run();
  assert.deepEqual(f.calls, ['local', 'persist', 'transport']);
  assert.equal(f.execution[0].activationFence.bindingId, 'binding');
  assert.equal(f.execution[0].activationFence.bindingCancelRevision, 0);
});

test('epoch mismatch cannot create or submit a question operation', async () => {
  const f = fixture('changed');
  await assert.rejects(f.run(), /epoch/);
  assert.deepEqual(f.calls, ['local']);
});
