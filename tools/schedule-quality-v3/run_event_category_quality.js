#!/usr/bin/env node

/* Run authored event-category cases against the mobile rules and HTTP parser. */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..', '..');
const CORPUS = path.join(__dirname, 'event-category-corpus.jsonl');
const DEFAULT_REPORT = path.join(__dirname, 'reports', 'event-category-quality.json');
const DEFAULT_ENDPOINT = 'http://183.36.243.124:18035/api/laoji/parse';
const CATEGORIES = ['工作', '学习', '健康', '生活', '社交', '出行', '财务', '重要', '其他'];

function loadMobileParser() {
  const parserPath = path.join(ROOT, 'src', 'services', 'localScheduleParser.ts');
  require.extensions['.ts'] = (module, filename) => {
    const source = fs.readFileSync(filename, 'utf8');
    const compiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
      fileName: filename,
    }).outputText;
    module._compile(compiled, filename);
  };
  const originalLoad = Module._load;
  Module._load = function loadWithoutExpo(request, parent, isMain) {
    if (request === 'expo-modules-core') return { requireOptionalNativeModule: () => null };
    return originalLoad.call(this, request, parent, isMain);
  };
  return require(parserPath);
}

function args() {
  const result = { endpoint: DEFAULT_ENDPOINT, output: DEFAULT_REPORT, clientOnly: false, serverOnly: false, concurrency: 6 };
  for (let i = 2; i < process.argv.length; i += 1) {
    const value = process.argv[i];
    if (value === '--endpoint') result.endpoint = process.argv[++i];
    else if (value === '--output') result.output = process.argv[++i];
    else if (value === '--client-only') result.clientOnly = true;
    else if (value === '--server-only') result.serverOnly = true;
    else if (value === '--concurrency') result.concurrency = Math.max(1, Number(process.argv[++i]));
  }
  if (result.clientOnly && result.serverOnly) throw new Error('choose one of --client-only/--server-only');
  return result;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function requestJson(endpoint, payload) {
  const url = new URL(endpoint);
  const body = Buffer.from(JSON.stringify(payload));
  const transport = url.protocol === 'https:' ? require('node:https') : require('node:http');
  return new Promise(resolve => {
    const request = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Content-Length': body.length },
      timeout: 60_000,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch (_) { /* recorded as invalid JSON */ }
        resolve({ status: response.statusCode ?? null, response: parsed, response_raw: raw });
      });
    });
    request.on('error', error => resolve({ status: null, response: null, response_raw: '', error: String(error) }));
    request.on('timeout', () => request.destroy(new Error('request timeout')));
    request.end(body);
  });
}

async function mapLimit(rows, limit, fn) {
  const output = new Array(rows.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= rows.length) return;
      output[index] = await fn(rows[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, rows.length) }, worker));
  return output;
}

function rate(rows, layer) {
  const eligible = rows.filter(row => row[layer] && row[layer].eligible);
  const passed = eligible.filter(row => row[layer].passed).length;
  return { eligible: eligible.length, passed, failed: eligible.length - passed, pass_rate: eligible.length ? passed / eligible.length : 1 };
}

function macroF1(rows, layer) {
  const scores = [];
  for (const category of CATEGORIES) {
    const cases = rows.filter(row => row[layer]?.eligible && row.expected_category === category);
    if (!cases.length) continue;
    const tp = cases.filter(row => row[layer].actual_category === category).length;
    const predicted = rows.filter(row => row[layer]?.eligible && row[layer].actual_category === category).length;
    const recall = tp / cases.length;
    const precision = predicted ? tp / predicted : 0;
    scores.push(precision + recall ? (2 * precision * recall) / (precision + recall) : 0);
  }
  return scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : 1;
}

async function main() {
  const options = args();
  const rows = fs.readFileSync(CORPUS, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  if (rows.length < 200 || new Set(rows.map(row => row.text)).size !== rows.length) throw new Error('category corpus is incomplete or duplicated');
  if (rows.some(row => row.label_source !== 'authored_metadata_v1')) throw new Error('category labels are not authored metadata');
  const parser = options.serverOnly ? null : loadMobileParser();
  const prepared = rows.map(row => {
    const clientActual = parser
      ? parser.parseLocalScheduleText(row.text, new Date(row.reference_datetime), row.timezone)
      : null;
    return {
      ...row,
      client: options.serverOnly ? null : {
        eligible: true,
        actual_category: clientActual?.category ?? null,
        passed: clientActual?.category === row.expected_category,
      },
    };
  });
  const evaluated = options.clientOnly
    ? prepared
    : await mapLimit(prepared, options.concurrency, async row => {
      const result = await requestJson(options.endpoint, {
        text: row.text,
        reference_datetime: row.reference_datetime,
        timezone: row.timezone,
      });
      const actual = result.response;
      return {
        ...row,
        server: {
          eligible: true,
          status: result.status,
          actual_category: actual && typeof actual === 'object' ? actual.category ?? null : null,
          parse_source: actual && typeof actual === 'object' ? actual.parse_source ?? null : null,
          passed: result.status === 200 && actual && actual.category === row.expected_category,
          error: result.error ?? null,
          response_sha256: sha256(result.response_raw),
          response: actual,
        },
      };
    });
  const report = {
    schema_version: 1,
    service: 'event-category-classification',
    corpus: CORPUS,
    endpoint: options.clientOnly ? null : options.endpoint,
    total: evaluated.length,
    independent_oracle: true,
    label_source: 'authored_metadata_v1',
    client: options.serverOnly ? null : { ...rate(evaluated, 'client'), macro_f1: macroF1(evaluated, 'client') },
    server: options.clientOnly ? null : { ...rate(evaluated, 'server'), macro_f1: macroF1(evaluated, 'server') },
    failures: evaluated.filter(row => (row.client && !row.client.passed) || (row.server && !row.server.passed)),
    cases: evaluated,
  };
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    output: options.output,
    total: report.total,
    client: report.client,
    server: report.server,
    failure_count: report.failures.length,
  }, null, 2));
  return report.failures.length ? 1 : 0;
}

main().then(code => process.exitCode = code).catch(error => { console.error(error.stack || error); process.exitCode = 2; });
