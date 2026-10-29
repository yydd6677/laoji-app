const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { DatabaseSync } = require('node:sqlite');
function load(file, requireModule = () => ({})) {
  const m = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', code)(requireModule, m, m.exports);
  return m.exports;
}
const { recoverMeetingMediaImportBatch: recover } = load('src/services/meetingMediaImportRecovery.ts');
test('one failed restore does not block later media, and a later pass retries it', async () => {
  const pending = new Map([['first', { meetingId: 'first' }], ['second', { meetingId: 'second' }]]);
  const report = [];
  let failed = true;
  const deps = { list: async () => [...pending.values()], active: () => true,
    report: (...args) => report.push(args), restore: async item => {
      if (item.meetingId === 'first' && failed) throw Object.assign(new Error(), { code: 'busy' });
      pending.delete(item.meetingId);
    } };
  assert.equal(await recover(deps), false);
  assert.deepEqual([...pending.keys()], ['first']);
  assert.equal(report[0][0], 'restore');
  failed = false;
  assert.equal(await recover(deps), true);
  assert.equal(pending.size, 0);
});
test('scan failure retains retry ownership and does not run a partial restore', async () => {
  const events = [];
  assert.equal(await recover({ list: async () => { throw new Error('temporary'); }, active: () => true,
    report: phase => events.push(phase), restore: async () => assert.fail('must not restore') }), false);
  assert.deepEqual(events, ['scan']);
});
test('revocation between items stops writes without deleting remaining work', async () => {
  let active = true;
  const restored = [];
  assert.equal(await recover({ list: async () => [{ meetingId: 'one' }, { meetingId: 'two' }],
    active: () => active, report: () => assert.fail('not an error'),
    restore: async item => { restored.push(item.meetingId); active = false; } }), false);
  assert.deepEqual(restored, ['one']);
});
test('durable receipt read follows media ownership, scope, missing state and physical removal', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE meeting_notes(id TEXT PRIMARY KEY, scope_key TEXT, lifecycle TEXT);
    CREATE TABLE recording_assets(id TEXT PRIMARY KEY, meeting_id TEXT, local_state TEXT, local_uri TEXT);
    INSERT INTO meeting_notes VALUES ('own','guest','ended'),('trash','guest','deleted'),('other','user:one','ended');
    INSERT INTO recording_assets VALUES ('received','own','local_ready','file:///saved.wav'),
      ('recoverable','trash','local_ready','file:///trash.wav'),('missing','own','missing','file:///missing.wav'),
      ('empty','own','local_ready',' '),('remote','own','remote_only',NULL),('other','other','local_ready','file:///other.wav');`);
  const database = { getAllAsync: async (sql, ...args) => db.prepare(sql).all(...args) };
  const { SqliteMeetingNoteRepository } = load('src/data/repositories/sqliteMeetingNoteRepository.ts', name => {
    if (name.endsWith('/openDatabase')) return { openMeetingDatabase: async () => database };
    if (name.endsWith('/meeting')) return { assertScopeKey: value => {
      if (!['guest', 'user:one'].includes(value)) throw new Error('scope');
    } };
    return {};
  });
  const repo = new SqliteMeetingNoteRepository();
  assert.deepEqual(new Set(await repo.listLocalRecordingAssetIds('guest')), new Set(['received', 'recoverable']));
  db.exec("DELETE FROM recording_assets WHERE id = 'received'");
  assert.deepEqual(await repo.listLocalRecordingAssetIds('guest'), ['recoverable']);
  await assert.rejects(repo.listLocalRecordingAssetIds('invalid'), /scope/);
});
test('source owner lookup is canonical and scope isolated, including trash', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE meeting_notes(id TEXT PRIMARY KEY, scope_key TEXT, lifecycle TEXT);
    CREATE TABLE recording_assets(id TEXT PRIMARY KEY, meeting_id TEXT);
    INSERT INTO meeting_notes VALUES ('own','guest','ended'),('trash','guest','deleted'),('other','user:one','ended');
    INSERT INTO recording_assets VALUES ('received','own'),('trashed','trash'),('private','other');`);
  const database = { getFirstAsync: async (sql, ...args) => db.prepare(sql).get(...args) };
  const { SqliteMeetingNoteRepository } = load('src/data/repositories/sqliteMeetingNoteRepository.ts', name => {
    if (name.endsWith('/openDatabase')) return { openMeetingDatabase: async () => database };
    if (name.endsWith('/meeting')) return { assertScopeKey: value => { if (value !== 'guest') throw new Error('scope'); } };
    return {};
  });
  const repo = new SqliteMeetingNoteRepository();
  repo.aggregateFromRow = async (_, row) => row;
  assert.equal((await repo.findByRecordingAssetId('received', 'guest')).id, 'own');
  assert.equal((await repo.findByRecordingAssetId('trashed', 'guest')).lifecycle, 'deleted');
  assert.equal(await repo.findByRecordingAssetId('private', 'guest'), null);
  assert.equal(await repo.findByRecordingAssetId('missing', 'guest'), null);
  await assert.rejects(repo.findByRecordingAssetId('received', 'invalid'), /scope/);
});
