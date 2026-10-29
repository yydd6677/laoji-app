const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const compiled = ts.transpileModule(fs.readFileSync(path.resolve(__dirname,
  '../../src/services/deviceAuthority.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const deferred = () => {
  let resolve; const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  let binding = { meetingId: 'meeting', deviceEpochId: 'epoch', bindingId: 'binding',
    bindingGeneration: 'a'.repeat(32), bindingEpochSeq: 4, bindingRevision: 1,
    state: 'active', cancelRevision: 0, createdAtMs: 1, updatedAtMs: 1 };
  let failure = null, mismatch = false, gap = false;
  const gate = deferred(), entered = deferred(), calls = [], armed = [];
  class ApiError extends Error {
    constructor(code, status) { super(code); this.code = code; this.status = status; }
  }
  const target = { exports: {} };
  const dependencies = {
    'expo-crypto': {}, './deviceIdentity': {},
    '../data/db/openDatabase': { openMeetingDatabase: async () => ({
      getFirstAsync: async () => ({ id: 'meeting' }),
    }) },
    '../data/repositories/vnext/deviceAuthorityRepository': {
      getMeetingServiceBinding: async () => ({ ...binding }),
      listActiveMeetingServiceBindingsThrough: async () => [
        { ...binding, bindingId: 'prefix', bindingEpochSeq: 3 }, { ...binding },
      ],
    },
    'laoji-native-platform': {
      preparePurgeCapability: async () => ({ capabilityId: 'purge', secretSha256: 'secret-hash', registrationRequestId: 'request' }),
      markPurgeCapabilityArmed: id => { armed.push(id); },
    },
    './diagnostics': { diagnosticAudit() {} },
    './deviceV2Api': {
      DeviceV2ApiError: ApiError,
      deviceV2Request: async (route, options = {}) => {
        const payload = options.body && JSON.parse(options.body);
        calls.push({ route, method: options.method ?? 'GET', payload });
        entered.resolve(); await gate.promise;
        if (failure) { const error = failure; failure = null; throw error; }
        if (gap) { gap = false; throw new ApiError('BINDING_SEQUENCE_GAP', 409); }
        if (route === '/bindings/cursor') return { schema_version: 2, cursor: { binding_epoch_seq: 2 } };
        return { schema_version: 2, binding: {
          binding_id: mismatch ? 'different' : route.split('/').pop(),
          binding_generation: payload.binding_generation, binding_epoch_seq: payload.binding_epoch_seq,
          binding_revision: payload.binding_revision, cancel_revision: payload.cancel_revision, state: 'active',
        } };
      },
    },
  };
  new Function('require', 'module', 'exports', compiled)(name => {
    if (!(name in dependencies)) throw Error(`Unexpected dependency ${name}`);
    return dependencies[name];
  }, target, target.exports);
  return {
    call: () => target.exports.ensureRemoteMeetingServiceBinding('meeting'),
    set: next => { binding = { ...binding, ...next }; },
    fail: error => { failure = error; }, mismatch: () => { mismatch = true; }, gap: () => { gap = true; },
    gate, entered, calls, armed,
  };
}

test('concurrent callers for one immutable binding fence share exactly one registration', async () => {
  const f = fixture();
  const pending = Array.from({ length: 20 }, () => f.call());
  await f.entered.promise; await settle(); f.gate.resolve();
  const values = await Promise.all(pending);
  assert.equal(f.calls.length, 1); assert.equal(f.armed.length, 1);
  assert.ok(values.every(value => value.bindingId === 'binding'));
});
test('settled registrations are not cached and subsequent calls still verify the server fence', async () => {
  const f = fixture(); f.gate.resolve(); await f.call(); await f.call();
  assert.equal(f.calls.length, 2); assert.equal(f.armed.length, 2);
});
for (const [field, value] of [['deviceEpochId', 'new-epoch'], ['bindingGeneration', 'b'.repeat(32)],
  ['bindingRevision', 2], ['cancelRevision', 1]]) {
  test(`a different ${field} never shares the previous in-flight request`, async () => {
    const f = fixture(); const first = f.call(); await f.entered.promise;
    f.set({ [field]: value }); const second = f.call(); await settle(); f.gate.resolve();
    const values = await Promise.all([first, second]);
    assert.equal(f.calls.length, 2); assert.notEqual(values[0][field], values[1][field]);
  });
}
test('a rejected shared request propagates to everyone and does not poison retry or the queue', async () => {
  const f = fixture(); f.fail(Error('network unavailable'));
  const pending = [f.call(), f.call(), f.call()];
  const outcomes = Promise.allSettled(pending);
  await f.entered.promise; await settle(); f.gate.resolve();
  assert.ok((await outcomes).every(value => value.status === 'rejected'));
  assert.equal(f.calls.length, 1); assert.equal(f.armed.length, 0);
  await f.call(); assert.equal(f.calls.length, 2); assert.equal(f.armed.length, 1);
});
test('the existing contiguous sequence recovery remains authoritative for every shared caller', async () => {
  const f = fixture(); f.gap(); const pending = [f.call(), f.call()];
  await f.entered.promise; await settle(); f.gate.resolve(); await Promise.all(pending);
  assert.deepEqual(f.calls.map(call => [call.route, call.method]), [
    ['/meetings/binding', 'PUT'], ['/bindings/cursor', 'GET'], ['/meetings/prefix', 'PUT'], ['/meetings/binding', 'PUT'],
  ]);
  assert.equal(f.armed.length, 2);
});
test('a purging local binding cannot reuse an active in-flight result', async () => {
  const f = fixture(); const first = f.call(); await f.entered.promise;
  f.set({ state: 'purging' }); await assert.rejects(f.call(), /正在清理/);
  f.gate.resolve(); await first; assert.equal(f.calls.length, 1);
});
test('a mismatched server acknowledgement never arms the purge capability', async () => {
  const f = fixture(); f.mismatch(); f.gate.resolve();
  await assert.rejects(f.call(), /确认不一致/); assert.equal(f.armed.length, 0);
});
