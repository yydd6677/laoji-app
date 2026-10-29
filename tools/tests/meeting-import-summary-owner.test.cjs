const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const moduleRef = { exports: {} };
const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname,
  '../../src/application/meeting/attachImportedMeetingMedia.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
new Function('require', 'module', 'exports', code)(name => name.endsWith('meetingNoteRepository')
  ? { canonicalRecordingSourceSha256: value => value }
  : { assertScopeKey: value => assert.equal(value, 'guest'), createSecureAssetGeneration: () => 'a'.repeat(32),
      transitionProcessingStage: (old, patch, updatedAtMs) => ({ ...old, ...patch, updatedAtMs }) },
moduleRef, moduleRef.exports);

test('media acceptance/replay cannot invalidate an existing summary or read its state', async () => {
  const stages = new Map([
    ['capture', { status: 'preparing', updatedAtMs: 5 }],
    ['upload', { status: 'not_required', updatedAtMs: 5 }],
  ]);
  let saved = null; const written = [];
  const transaction = {
    getMeeting: async () => ({ id: 'meeting', lifecycle: 'ended', updatedAtMs: 5 }),
    getStage: async (_id, _scope, stage) => { assert.notEqual(stage, 'summary'); return stages.get(stage); },
    getRecordingAsset: async () => saved, getPrimaryRecording: async () => saved,
    saveRecordingAsset: async row => { saved = row; },
    upsertStage: async row => { written.push(row.stage); stages.set(row.stage, row); },
    markCurrentSummaryStale: async () => assert.fail('media bytes are not summary evidence'),
    updateMeeting: async () => {}, advanceCanonicalWrite: async () => 2,
  };
  const repository = { transaction: callback => callback(transaction),
    get: async () => ({ note: { lifecycle: 'ended' } }) };
  const useCase = new moduleRef.exports.AttachImportedMeetingMediaUseCase({ repository, now: () => 10 });
  const input = { targetMeetingId: 'meeting', scopeKey: 'guest', media: { assetId: 'asset',
    origin: 'file_import', localUri: 'file:///private/recording.m4a', mimeType: 'audio/mp4',
    fileName: '录音.m4a', byteSize: 1000, durationMs: 2000, checksumSha256: 'b'.repeat(64) } };
  assert.equal((await useCase.execute(input)).attached, true);
  assert.equal((await useCase.execute(input)).attached, false);
  assert.deepEqual(written, ['capture', 'upload']);
});
