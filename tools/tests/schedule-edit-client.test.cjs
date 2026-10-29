const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function fixture() {
  const calls = []; let capability = true; let response;
  const modules = new Map();
  const overrides = {
    [path.resolve('src/theme/colors.ts')]: {},
    [path.resolve('src/services/deviceV2Api.ts')]: {
      loadDeviceV2Capabilities: async () => ({ scheduleEditV1: capability, scheduleTimePrecisionV1: capability }),
      deviceV2Request: async (url, init) => { calls.push({ url, init }); return response; },
    },
  };
  function load(file) {
    file = path.resolve(file);
    if (Object.hasOwn(overrides, file)) return overrides[file];
    if (modules.has(file)) return modules.get(file).exports;
    const module = { exports: {} }; modules.set(file, module);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    new Function('require', 'module', 'exports', code)(name => {
      if (!name.startsWith('.')) throw new Error(`unexpected dependency ${name}`);
      return load(path.resolve(path.dirname(file), `${name}.ts`));
    }, module, module.exports);
    return module.exports;
  }
  const domain = load('src/domain/scheduleEditor.ts');
  const api = load('src/services/scheduleEditV1.ts');
  const draft = domain.beginScheduleEditorInput(domain.createScheduleEditorDraft({
    id: 'draft-1', saveRequestId: 'save-1', startDate: '2026-10-28',
    content: { title: '手动标题', location: '手动地点', notes: '原备注',
      time: { precision: 'exact', period: null, startTime: '09:23', endTime: null } },
  }), { id: 'input-1', mode: 'patch', referenceDatetime: '2026-10-28T15:59:59.000Z',
    timezone: 'Asia/Shanghai', text: '🍜晚一小时' });
  const value = { schema_version: 1, draft_id: draft.id, base_revision: draft.revision,
    input_sequence: 1, status: 'patch', producer_revision: 'schedule-edit-test',
    changes: [{ field: 'time', op: 'set', value: { precision: 'exact', period: null, start_time: '10:23', end_time: null },
      evidence: '晚一小时' }], evidence_spans: { time: { text: '晚一小时', start: 2, end: 6 } } };
  response = value;
  return { calls, domain, api, draft, value, setCapability: v => { capability = v; }, setResponse: v => { response = v; } };
}

test('one request sends current edited fields, fixed clock and operation fence, never original text or event identity', async () => {
  const f = fixture();
  const result = await f.api.editScheduleDraftV1(f.draft, f.draft.pendingInput);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, '/schedule/graph/edit');
  const body = JSON.parse(f.calls[0].init.body);
  assert.equal(body.draft.title, '手动标题'); assert.equal(body.draft.location, '手动地点');
  assert.equal(body.reference_datetime, '2026-10-28T15:59:59.000Z');
  assert.equal(body.utterance, '🍜晚一小时');
  assert.equal(body.draft.rawText, undefined); assert.equal(body.draft.eventRef, undefined);
  const applied = f.domain.applyScheduleEditorInput(f.draft, {
    id: 'input-1', baseRevision: f.draft.revision, sequence: 1,
  }, result.changes);
  assert.equal(applied.accepted, true); assert.equal(applied.draft.time.startTime, '10:23');
  assert.equal(applied.draft.location, '手动地点'); assert.equal(applied.draft.notes, '原备注');
});

test('capability withdrawal never posts to old clarify or retries', async () => {
  const f = fixture(); f.setCapability(false);
  await assert.rejects(f.api.editScheduleDraftV1(f.draft, f.draft.pendingInput), /直接编辑日程/);
  assert.equal(f.calls.length, 0);
});

test('initial and replacement interpretations never enter the current-draft patch endpoint', async () => {
  for (const mode of ['initial', 'replace']) {
    const f = fixture();
    await assert.rejects(f.api.editScheduleDraftV1(f.draft, { ...f.draft.pendingInput, mode }));
    assert.equal(f.calls.length, 0);
  }
});

test('foreign fence, invalid UTF16 evidence, duplicates and extra target field fail before partial application', async () => {
  const variants = [
    v => { v.draft_id = 'other'; }, v => { v.base_revision++; }, v => { v.input_sequence++; },
    v => { v.evidence_spans.time.start = 1; }, v => { v.evidence_spans.time.end = 60; },
    v => { v.changes.push(v.changes[0]); },
    v => { v.changes[0].field = 'event_id'; }, v => { v.changes[0].value.start_time = '25:00'; },
    v => { v.status = 'no_change'; }, v => { v.changes[0].op = 'clear'; },
  ];
  for (const mutate of variants) {
    const f = fixture(); const value = structuredClone(f.value); mutate(value); f.setResponse(value);
    await assert.rejects(f.api.editScheduleDraftV1(f.draft, f.draft.pendingInput));
    assert.equal(f.draft.time.startTime, '09:23'); assert.equal(f.calls.length, 1);
  }
});

test('late valid response cannot overwrite manual edit and retains current input for reuse', async () => {
  const f = fixture(); const result = await f.api.editScheduleDraftV1(f.draft, f.draft.pendingInput);
  const manual = f.domain.editScheduleFields(f.draft, { location: '用户新地点' });
  const applied = f.domain.applyScheduleEditorInput(manual, { id: 'input-1', baseRevision: 1, sequence: 1 }, result.changes);
  assert.equal(applied.accepted, false); assert.equal(applied.draft.time.startTime, '09:23');
  assert.equal(applied.draft.location, '用户新地点'); assert.equal(applied.draft.latestInputText, '🍜晚一小时');
});
