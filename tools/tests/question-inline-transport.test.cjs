const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const { createHash } = require('node:crypto');

function provider({ remote = null, existing = false, inline = true, state = 'running', gzip = false } = {}) {
  const calls = [];
  const registrations = [];
  const remoteHandles = new Map([['operation', remote]]);
  const binding = { deviceEpochId: 'epoch', bindingId: 'binding', bindingGeneration: 'c'.repeat(32), bindingRevision: 1, cancelRevision: 0 };
  const request = { operationId: 'operation', snapshotId: 'snapshot', sourceFingerprint: 'sha256:'+'a'.repeat(64),
    activationFence: { meetingId: 'meeting', sourceFingerprint: 'sha256:'+'a'.repeat(64),
      deviceEpochId: 'epoch', bindingId: 'binding', bindingGeneration: 'c'.repeat(32), bindingRevision: 1, bindingCancelRevision: 0 },
    meetingId: 'meeting', providerRevision: 'q2-reader-v2', question: '谁负责？', sources: [{
      sourceType: 'transcript', sourceId: 'segment', sourceRevisionId: 'revision', contentSha256: 'sha256:'+'b'.repeat(64), text: '张敏负责。' }] };
  const response = { schema_version: 2, contract_revision: 'question.reader.v2', provider_revision: request.providerRevision,
    answer_kind: 'not_stated', answer: '未说明。', clauses: [] };
  const deps = {
    './deviceV2Api': {
      DeviceV2ApiError: class extends Error { constructor(message, status, code) { super(message); this.status=status; this.code=code; } },
      loadDeviceV2Capabilities: async () => ({ questionReaderV2: true, sourceStreamV2: true, questionInlineSourcesV1: inline, questionInlineGzipV1: gzip }),
      deviceV2Request: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return response; },
    },
    './deviceAuthority': { ensureRemoteMeetingServiceBinding: async () => { registrations.push({ ...binding }); return binding; } },
    '../data/repositories/vnext/questionQ2Repository': { Q2ActivationFenceError: class extends Error {} },
    '../data/repositories/vnext/deviceOperationsRepository': {
      getDeviceOperation: async id => ({ capability: 'question_reader_v2', remoteTaskId: remoteHandles.get(id) ?? null, operationRevision: 1, remoteState: state }),
      updateDeviceOperation: async value => { remoteHandles.set(value.operationId, value.remoteTaskId); return { remoteTaskId: value.remoteTaskId }; },
    },
    './deviceV2SourceStream': { getDeviceV2Task: async id => {
      calls.push({ task: id });
      assert.ok(existing, 'a new operation must not poll a nonexistent Task');
      return { task: { state: 'success', capability: 'question', input_sha256: request.sourceFingerprint, result: response } };
    } },
    'expo-crypto': { CryptoDigestAlgorithm: { SHA256: 'SHA256' }, digestStringAsync: async (_, s) => createHash('sha256').update(s).digest('hex') },
  };
  const codec = {exports:{}};
  const codecCode = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../src/services/questionSourcePayload.ts'), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'module', 'exports', codecCode)(require, codec, codec.exports);
  deps['./questionSourcePayload'] = codec.exports;
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../src/services/questionQ2DeviceProvider.ts'), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'module', 'exports', code)(name => deps[name] ?? {}, module, module.exports);
  return { ...module.exports, calls, registrations, binding, request };
}

test('normal meeting submits one durable inline POST and binds the local handle first', async () => {
  const p = provider();
  const result = await new p.DeviceQ2Provider().read(p.request);
  assert.equal(result.answer, '未说明。');
  assert.equal(p.calls.length, 1);
  assert.equal(p.registrations.length, 1);
  assert.equal(p.calls[0].body.prepare_sources, true);
  assert.equal(p.calls[0].body.source_entity_id, 'meeting');
  assert.match(p.calls[0].body.task_id, /^q2-task:[a-f0-9]{64}$/);
  assert.equal(p.calls[0].body.sources[0].text, '张敏负责。');
});

test('completed persisted task is still queried and replayed without source reupload', async () => {
  const p = provider({ remote: 'persisted', existing: true });
  await new p.DeviceQ2Provider().read(p.request);
  assert.equal(p.calls.length, 1);
  assert.ok(p.calls[0].task);
  assert.equal(p.registrations.length, 0);
});

test('negotiated compression keeps the same intent, fence and one durable POST', async () => {
  const p = provider({gzip:true});
  p.request.sources[0].text = ' \n保留原文😀。'.repeat(300);
  await new p.DeviceQ2Provider().read(p.request);
  assert.equal(p.calls.length,1);
  const body = p.calls[0].body;
  assert.equal(body.sources,undefined);
  assert.equal(body.source_fingerprint,p.request.sourceFingerprint);
  assert.equal(body.binding_generation,p.binding.bindingGeneration);
  const rows = JSON.parse(require('node:zlib').gunzipSync(Buffer.from(body.compressed_sources.data,'base64')));
  assert.equal(rows[0].text,p.request.sources[0].text);
  assert.equal(rows[0].content_sha256,p.request.sources[0].contentSha256);
});

test('cancelled local operation never prepares or submits raw sources', async () => {
  const p = provider({ state: 'cancelled' });
  await assert.rejects(new p.DeviceQ2Provider().read(p.request), /会议问答任务已结束/);
  assert.equal(p.calls.length, 0);
  assert.equal(p.registrations.length, 0);
});

for (const [field, value] of [['deviceEpochId', 'new-epoch'], ['bindingId', 'new-binding'],
  ['bindingGeneration', 'd'.repeat(32)], ['bindingRevision', 2], ['cancelRevision', 1]]) {
  test(`a changed ${field} is rejected before transmitting any source`, async () => {
    const p = provider();
    p.binding[field] = value;
    await assert.rejects(new p.DeviceQ2Provider().read(p.request));
    assert.equal(p.registrations.length, 1);
    assert.equal(p.calls.length, 0);
  });
}

test('each new question verifies server authority rather than reusing a settled registration', async () => {
  const p = provider();
  await new p.DeviceQ2Provider().read(p.request);
  await new p.DeviceQ2Provider().read({ ...p.request, operationId: 'next' });
  assert.equal(p.registrations.length, 2);
});

test('inline limits match Unicode character and UTF-8 wire budgets, not file size', () => {
  const p = provider();
  assert.equal(p.canInlineQuestionSources(p.request), true);
  assert.equal(p.canInlineQuestionSources({ ...p.request, sources: [] }), false);
  assert.equal(p.canInlineQuestionSources({ ...p.request, sources: [{ ...p.request.sources[0], text: '字'.repeat(8001) }] }), false);
  assert.equal(p.canInlineQuestionSources({ ...p.request, sources: Array(20).fill({ ...p.request.sources[0], text: '字'.repeat(8000) }) }), false);
  assert.equal(p.canInlineQuestionSources({ ...p.request, sources: [{ ...p.request.sources[0], text: '😀'.repeat(8000) }] }), true);
});
