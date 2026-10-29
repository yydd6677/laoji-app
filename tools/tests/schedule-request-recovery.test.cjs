const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const ts = require('typescript');

function load(file, dependencies = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
    return dependencies[name];
  }, module, module.exports);
  return module.exports;
}

const http = load('src/services/http.ts');
class ApiError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}
class V2Error extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

function parser(capabilities, graph) {
  const calls = [];
  const api = load('src/services/scheduleParsing.ts', {
    './localScheduleParser': {
      parseLocalScheduleText: () => null,
      classifyScheduleParseRoute: () => ({ route: 'server_required' }),
      classifyScheduleParseIntent: () => 'create',
    },
    './deviceApi': { DeviceApiError: ApiError },
    './deviceV2Api': { DeviceV2ApiError: V2Error, loadDeviceV2Capabilities: capabilities },
    './http': http,
    './scheduleGraphV2': { parseScheduleGraphV2: async input => { calls.push(input); return graph(input); } },
    'laoji-native-platform': {}, './config': {}, './realtimeAsr': {},
  });
  return { ...api, calls };
}

test('capability timeout remains a timeout and does not submit graph or lose the caller input', async () => {
  let attempts = 0;
  const p = parser(async () => {
    if (++attempts === 1) throw new http.RequestTimeoutError(5000);
    return { scheduleGraphV2: true };
  }, () => { throw new V2Error('invalid', 422, 'SCHEDULE_GRAPH_INVALID'); });
  const text = '周五下班后和同事吃饭';
  await assert.rejects(p.parseText(text), { code: 'request_timeout', message: '解析请求超时，请重试' });
  assert.equal(p.calls.length, 0);
  await assert.rejects(p.parseText(text), { code: 'invalid_schedule', status: 422 });
  assert.equal(p.calls.length, 1);
  assert.equal(p.calls[0].text, text);
});

test('explicit capability withdrawal still fails closed without submitting graph', async () => {
  const p = parser(async () => ({ scheduleGraphV2: false }), () => assert.fail('must not submit'));
  await assert.rejects(p.parseText('明天晚饭后去散步'), { code: 'parser_unavailable' });
  assert.equal(p.calls.length, 0);
});

test('v2 provider outage stays unavailable while v2 content errors stay content errors', async () => {
  for (const [status, code, expected] of [
    [503, 'SCHEDULE_GRAPH_PROVIDER_UNAVAILABLE', 'parser_unavailable'],
    [422, 'SCHEDULE_GRAPH_INVALID', 'invalid_schedule'],
    [422, 'SCHEDULE_MODEL_NO_RESULT', 'invalid_schedule'],
    [422, 'MISSING_DATE', 'missing_date'],
  ]) {
    const p = parser(async () => ({ scheduleGraphV2: true }), () => { throw new V2Error('rejected', status, code); });
    await assert.rejects(p.parseText('下班后去看电影'), { code: expected, status });
    assert.equal(p.calls.length, 1, 'inference POST is never automatically repeated');
  }
});
