const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const { DatabaseSync } = require('node:sqlite');
function load(file, dependencies = {}) {
  const m = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require','module','exports',code)(name => dependencies[name] ?? {},m,m.exports); return m.exports;
}
const meaning = load('src/services/scheduleInput.ts');
const source = { purpose:'schedule', deviceId:'board', sourceCaptureId:'capture-1', recordingId:'source-1',
  audioChecksumSha256:`sha256:${'a'.repeat(64)}`, recordedAtMs:Date.parse('2026-10-24T15:58:00Z'), timeZone:'Asia/Shanghai' };
function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  const schema = load('src/data/db/openScheduleDatabase.ts', {'expo-sqlite':{}}).SCHEDULE_DATABASE_SCHEMA_SQL;
  sqlite.exec(schema);
  const db = {
    getFirstAsync: async (q,...p) => sqlite.prepare(q).get(...p) ?? null,
    getAllAsync: async (q,...p) => sqlite.prepare(q).all(...p),
    runAsync: async (q,...p) => sqlite.prepare(q).run(...p),
  };
  const repo = load('src/data/repositories/scheduleInputRepository.ts', {
    '../db/openScheduleDatabase':{ openScheduleDatabase:async()=>db,withScheduleDatabaseTransaction:async f=>f(db) },
    '../../services/scheduleInput':meaning,
  });
  return {sqlite,repo};
}
test('purpose never depends on duration, keywords or parser success', () => {
  assert.throws(()=>meaning.scheduleInputIdentity({...source,purpose:'meeting'}));
  assert.throws(()=>meaning.scheduleInputIdentity({...source,sourceCaptureId:null}));
  assert.equal(meaning.scheduleInputIdentity(source),'capture:board:capture-1');
  assert.deepEqual(meaning.scheduleInputContext(source),{reference_datetime:'2026-10-24T15:58:00.000Z',timezone:'Asia/Shanghai'});
});
test('unknown offline clock cannot silently assign tomorrow to receive day',()=>{
  const parsed={start_date:'2026-10-25',end_date:'2026-10-25',schedule_graph:{},needs_clarification:false};
  const result=meaning.scheduleInputDraft({...source,recordedAtMs:0},parsed);
  assert.equal(result.start_date,'');assert.equal(result.needs_clarification,true);assert.equal(result.schedule_graph,undefined);
  assert.strictEqual(meaning.scheduleInputDraft(source,parsed),parsed);
});
test('actual SQLite receives, resumes, edits and retires one immutable input across rename/transport',async()=>{
  const {sqlite,repo}=fixture();
  const first=await repo.enqueueScheduleInput(source); assert.equal(first.state,'pending');
  assert.equal((await repo.enqueueScheduleInput({...source,recordingId:'renamed',checksumSha256:'different-container'})).id,first.id);
  await assert.rejects(repo.enqueueScheduleInput({...source,audioChecksumSha256:`sha256:${'b'.repeat(64)}`}));
  await repo.updateScheduleInput(first.id,{raw_text:'下周三上午到医院复查',start_date:'2026-10-28'});
  const restored=(await repo.listScheduleInputs('display'))[0]; assert.equal(restored.draft.start_date,'2026-10-28');
  await repo.finishScheduleInput(first.id,'saved');
  assert.equal((await repo.listScheduleInputs()).length,0);
  assert.equal((await repo.enqueueScheduleInput(source)).state,'saved');
  await repo.updateScheduleInput(first.id,{start_date:'wrong'});
  assert.equal(sqlite.prepare('SELECT draft_json FROM schedule_input_jobs').get().draft_json,null);
  assert.deepEqual(await repo.receivedScheduleInputIds(),[first.id]);
  const row=sqlite.prepare('SELECT source_json FROM schedule_input_jobs').get();assert.equal(row.source_json,'{}');
});
test('bounded retry isolates terminal failed input without deleting its source',async()=>{
  const {sqlite,repo}=fixture();const input=await repo.enqueueScheduleInput(source);
  for(let i=0;i<5;i++) await repo.deferScheduleInput(input.id);
  const row=sqlite.prepare('SELECT * FROM schedule_input_jobs').get();
  assert.equal(row.state,'failed');assert.equal(JSON.parse(row.source_json).recordingId,source.recordingId);
});
