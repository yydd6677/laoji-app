const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { DatabaseSync } = require('node:sqlite');
const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname,
  '../../src/data/repositories/sqliteMeetingNoteRepository.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture() {
  const db = new DatabaseSync(':memory:');
  // Deliberately no manual_notes/snapshots/summary/calendar tables: a focused
  // transcript read must not depend on unrelated aggregates being available.
  db.exec(`
    CREATE TABLE meeting_notes(id TEXT PRIMARY KEY, scope_key TEXT, legacy_source_id TEXT, lifecycle TEXT);
    CREATE TABLE recording_assets(meeting_id TEXT, native_session_id TEXT);
    CREATE TABLE processing_stages(meeting_id TEXT, stage TEXT, status TEXT);
    CREATE TABLE transcript_revisions(id TEXT PRIMARY KEY, meeting_id TEXT, remote_id TEXT,
      kind TEXT, status TEXT, source_provider TEXT, source_model TEXT, source_manifest_sha256 TEXT,
      is_active INTEGER, created_at_ms INTEGER, finalized_at_ms INTEGER, text_final_at_ms INTEGER);
    CREATE TABLE transcript_segments(id TEXT PRIMARY KEY, revision_id TEXT, meeting_id TEXT,
      source_segment_id TEXT, source_recording_asset_id TEXT, source_recording_asset_remote_id TEXT,
      source_transcription_job_id TEXT, stable_segment_key TEXT, segment_revision INTEGER,
      text_state TEXT, ordinal INTEGER, start_ms INTEGER, end_ms INTEGER, speaker_cluster_id TEXT,
      speaker_profile_id TEXT, speaker_label TEXT, speaker_label_override TEXT, text TEXT,
      normalized_text TEXT, confidence REAL, is_final INTEGER, created_at_ms INTEGER);
  `);
  let reads = 0;
  const database = {
    getFirstAsync: async (sql, ...args) => { reads++; return db.prepare(sql).get(...args) ?? null; },
    getAllAsync: async (sql, ...args) => { reads++; return db.prepare(sql).all(...args); },
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => {
    if (name.endsWith('/openDatabase')) return { openMeetingDatabase: async () => database };
    if (name.endsWith('/meeting')) return { assertScopeKey: value => {
      if (value !== 'guest' && !/^user:/.test(value)) throw Error('invalid scope');
    } };
    return {};
  }, module, module.exports);
  const repository = new module.exports.SqliteMeetingNoteRepository();
  function add(id, { scope = 'guest', legacy = `legacy-${id}`, session = `session-${id}`,
    lifecycle = 'ended', kind = 'final', status = 'ready', stage = 'ready', active = 1, text = '讨论进展' } = {}) {
    db.prepare('INSERT INTO meeting_notes VALUES(?,?,?,?)').run(id, scope, legacy, lifecycle);
    db.prepare('INSERT INTO recording_assets VALUES(?,?)').run(id, session);
    db.prepare('INSERT INTO processing_stages VALUES(?,?,?)').run(id, 'transcript', stage);
    db.prepare('INSERT INTO transcript_revisions VALUES(?,?,NULL,?,?,NULL,NULL,NULL,?,1,NULL,NULL)')
      .run(`revision-${id}`, id, kind, status, active);
    if (text !== null) db.prepare(`INSERT INTO transcript_segments
      (id,revision_id,meeting_id,source_segment_id,stable_segment_key,segment_revision,text_state,
      ordinal,start_ms,end_ms,text,normalized_text,is_final,created_at_ms)
      VALUES(?,?,?,?,?,1,'final',0,500,1000,?,?,1,1)`)
      .run(`segment-${id}`, `revision-${id}`, id, `source-${id}`, `source-${id}`, text, text);
  }
  return { db, add, read: (id, scope = 'guest') => repository.getActiveTranscriptStateByNativeSessionId(id, scope),
    reads: () => reads, reset: () => { reads = 0; } };
}

test('canonical, compatibility and native identities preserve source fields in exactly two reads', async t => {
  const f = fixture(); t.after(() => f.db.close()); f.add('one');
  for (const id of ['one', 'legacy-one', ' session-one ']) {
    f.reset(); const result = await f.read(id);
    assert.equal(f.reads(), 2); assert.equal(result.transcript.revision.meetingId, 'one');
    assert.equal(result.transcript.revision.kind, 'final'); assert.equal(result.completing, false);
    assert.equal(result.transcript.segments[0].sourceId, 'source-one');
    assert.equal(result.transcript.segments[0].startMs, 500);
    assert.equal(result.transcript.segments[0].text, '讨论进展');
  }
});
test('native binding wins over a colliding compatibility identity, including a deleted native root', async t => {
  const f = fixture(); t.after(() => f.db.close());
  f.add('fallback', { legacy: 'shared' }); f.add('bound', { session: 'shared' });
  assert.equal((await f.read('shared')).transcript.revision.meetingId, 'bound');
  f.db.prepare("UPDATE meeting_notes SET lifecycle='deleted' WHERE id='bound'").run();
  assert.equal(await f.read('shared'), null);
});
test('scope isolation, missing/inactive/deleted content never falls back to another transcript', async t => {
  const f = fixture(); t.after(() => f.db.close());
  f.add('other', { scope: 'user:other', session: 'same' }); f.add('local', { session: 'same', active: 0 });
  assert.equal(await f.read('same'), null); assert.equal(await f.read('missing'), null);
  assert.equal((await f.read('same', 'user:other')).transcript.revision.meetingId, 'other');
  f.reset(); assert.equal(await f.read('   '), null); assert.equal(f.reads(), 0);
  await assert.rejects(f.read('same', 'invalid'), /invalid scope/);
});
test('draft, empty final, and both finalizing owners retain their distinct semantics', async t => {
  const f = fixture(); t.after(() => f.db.close());
  f.add('draft', { kind: 'realtime_draft', status: 'realtime_draft' });
  f.add('empty', { text: null }); f.add('stage', { stage: 'finalizing' });
  f.add('revision', { status: 'finalizing' });
  assert.equal((await f.read('draft')).transcript.revision.kind, 'realtime_draft');
  assert.deepEqual((await f.read('empty')).transcript.segments, []);
  assert.equal((await f.read('empty')).completing, false);
  assert.equal((await f.read('stage')).completing, true);
  assert.equal((await f.read('revision')).completing, true);
});
