const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const source = fs.readFileSync(path.resolve(__dirname, '../../src/application/meeting/deleteMeetingNote.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleObject = { exports: {} };
new Function('require', 'module', 'exports', compiled)(
  name => {
    assert.equal(name, '../../domain/meeting');
    return { assertScopeKey: scope => assert.equal(scope, 'guest') };
  }, moduleObject, moduleObject.exports,
);
const { DeleteMeetingNoteUseCase } = moduleObject.exports;

async function attempt(status, idle, age = 120_000) {
  const now = 1_000_000;
  const meeting = { id: 'target', lifecycle: 'active', updatedAtMs: now - age };
  const transaction = {
    getMeeting: async id => { assert.equal(id, 'target'); return meeting; },
    getStage: async () => ({ status, updatedAtMs: now - age }),
    advanceCanonicalWrite: async () => 2,
    updateMeeting: async (id, scope, patch) => {
      assert.equal(id, 'target'); assert.equal(scope, 'guest'); Object.assign(meeting, patch);
    },
  };
  const useCase = new DeleteMeetingNoteUseCase({
    repository: { transaction: fn => fn(transaction), get: async () => ({ note: meeting }) },
    now: () => now,
    captureOwnersIdle: idle,
  });
  return useCase.execute({ meetingId: 'target', scopeKey: 'guest', canonicalWrite: true, preserveForRestore: true });
}

test('orphan preparation is deleted with a recoverable tombstone', async () => {
  const result = await attempt('preparing', async () => true);
  assert.equal(result.deleted, true);
  assert.equal(result.canonicalRevision, 2);
  assert.equal(result.aggregate.note.lifecycle, 'deleted');
  assert.equal(result.aggregate.note.deletedFromLifecycle, 'active');
});
for (const status of ['recording', 'paused', 'finalizing']) {
  test(`live ${status} remains protected even with an idle probe`, async () => {
    await assert.rejects(attempt(status, async () => true), /请先结束/);
  });
}
test('recent preparation remains protected', async () => {
  await assert.rejects(attempt('preparing', async () => true, 500), /请先结束/);
});
test('busy capture owner remains protected', async () => {
  await assert.rejects(attempt('preparing', async () => false), /请先结束/);
});
test('missing or failed runtime probe fails closed', async () => {
  await assert.rejects(attempt('preparing', undefined), /请先结束/);
  await assert.rejects(attempt('preparing', async () => { throw new Error('unavailable'); }), /请先结束/);
});
test('completed capture does not need a runtime probe', async () => {
  assert.equal((await attempt('completed', undefined)).deleted, true);
});
