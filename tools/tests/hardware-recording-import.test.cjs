const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
function load(file, deps = () => ({})) {
  const m = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', code)(deps, m, m.exports);
  return m.exports;
}
const hashes = load('src/data/repositories/meetingNoteRepository.ts');
const titles = load('src/services/meetingMediaImport.ts');
const { planHardwareRecordingImport: plan } = load('src/services/hardwareRecordingImport.ts', name =>
  name.endsWith('/meetingNoteRepository') ? hashes : name.endsWith('/meetingMediaImport') ? titles : {});
const hash = 'a'.repeat(64);
const source = { recordingId: 'stable-source', localUri: 'file:///received.wav', title: '产品讨论',
  sourceDeviceRecordingId: '设备录音.wav', recordedAtMs: 1000, checksumSha256: `sha256:${hash}`, byteSize: 100 };
const repo = (assetOwner = null, root = null) => ({
  findByRecordingAssetId: async (id, scope) => { assert.equal(id, source.recordingId); assert.equal(scope, 'guest'); return assetOwner; },
  findByNativeSessionId: async (id, scope) => { assert.ok(id); assert.equal(scope, 'guest'); return root; },
});
const root = { note: { id: 'canonical', legacySourceId: 'live-session', title: '我的会议', lifecycle: 'ended' }, recordingAssets: [] };
test('offline receive uses stable source identity and useful defaults without another decision', async () => {
  assert.deepEqual(await plan(source, repo(), 2000), { kind: 'import', meetingId: 'stable-source',
    title: '产品讨论', recordedAtMs: 1000, targetMeetingId: null });
});
test('live receive reuses its ended root, custom title and UI identity', async () => {
  assert.deepEqual(await plan({ ...source, captureMeetingId: 'live-session' }, repo(null, root), 2000), {
    kind: 'import', meetingId: 'live-session', title: '我的会议', recordedAtMs: 1000, targetMeetingId: 'live-session' });
});
test('retry after shell creation attaches to the same root', async () => {
  const shell = { ...root, note: { ...root.note, legacySourceId: source.recordingId } };
  assert.equal((await plan(source, repo(null, shell))).targetMeetingId, source.recordingId);
});
test('late capture projection waits, never creates a second live meeting', async () => {
  for (const owner of [null, { ...root, note: { ...root.note, lifecycle: 'active' } }]) {
    assert.deepEqual(await plan({ ...source, captureMeetingId: 'live-session' }, repo(null, owner)), { kind: 'deferred' });
  }
});
test('delayed receive cannot resurrect a deleted meeting', async () => {
  assert.deepEqual(await plan(source, repo(null, { ...root, note: { ...root.note, lifecycle: 'deleted' } })), { kind: 'deferred' });
});
test('canonical commit followed by cleanup failure is adopted, not imported twice', async () => {
  for (const checksumSha256 of [hash, `sha256:${hash}`]) {
    const owned = { ...root, recordingAssets: [{ id: source.recordingId, localState: 'local_ready',
      localUri: 'file:///canonical.wav', byteSize: 100, checksumSha256 }] };
    assert.deepEqual(await plan(source, repo(owned)), { kind: 'adopted' });
  }
});
test('an existing conflicting asset never allocates a duplicate root or discards its source', async () => {
  const base = { id: source.recordingId, localState: 'local_ready', localUri: 'file:///canonical.wav', byteSize: 100, checksumSha256: hash };
  for (const asset of [{ ...base, checksumSha256: 'b'.repeat(64) }, { ...base, byteSize: 101 },
    { ...base, localState: 'missing' }, { ...base, localUri: null }, null]) {
    await assert.rejects(plan(source, repo({ ...root, recordingAssets: asset ? [asset] : [] })),
      error => error.code === 'ERR_MEDIA_IMPORT_IDENTITY_CONFLICT');
  }
});
test('missing title uses filename, future/invalid dates use current time', async () => {
  for (const recordedAtMs of [0, NaN, Infinity, -1, 1.5, 70_001]) {
    const value = await plan({ ...source, title: ' ', recordedAtMs }, repo(), 2000);
    assert.equal(value.recordedAtMs, 2000); assert.equal(value.title, '设备录音');
  }
  const value = await plan({ ...source, title: '', sourceDeviceRecordingId: null }, repo(), 2000);
  assert.ok(value.title.startsWith('外接录音 '));
});
