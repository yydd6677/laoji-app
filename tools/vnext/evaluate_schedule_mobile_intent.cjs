#!/usr/bin/env node
/*
 * Evaluate the real mobile admission classifier against public MASSIVE source
 * intent supervision. This is intentionally not a LaoJi field-quality or
 * human-adjudicated naturalness benchmark.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..', '..');
const SOURCE = path.join(ROOT, 'src', 'services', 'localScheduleParser.ts');
const INTENT_MAP = Object.freeze({
  calendar_set: 'create',
  calendar_query: 'query',
  calendar_remove: 'delete',
});

function argument(name, required = true) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  if (required) throw new Error(`missing_argument:${name}`);
  return null;
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function loadClassifier() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'laoji-mobile-intent-'));
  const services = path.join(temp, 'services');
  const utils = path.join(temp, 'utils');
  fs.mkdirSync(services, { recursive: true });
  fs.mkdirSync(utils, { recursive: true });
  const source = fs.readFileSync(SOURCE, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: SOURCE,
    reportDiagnostics: true,
  });
  const fatal = (output.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error);
  if (fatal.length > 0) throw new Error('typescript_transpile_failed');
  fs.writeFileSync(path.join(services, 'localScheduleParser.js'), output.outputText, 'utf8');
  // The classifier does not use event colors. The real module imports the
  // theme/native bridge at module load, so the evaluator supplies only the
  // pure function names needed to load the parser in a platform-neutral Node
  // process. Production code remains untouched.
  fs.writeFileSync(path.join(utils, 'eventColors.js'), [
    "exports.colorForEventCategory = () => '#000000';",
    "exports.inferEventCategory = () => '其他';",
    "exports.isEventCategory = value => typeof value === 'string';",
    "exports.normalizeEventCategory = value => String(value || '其他');",
    '',
  ].join('\n'), 'utf8');
  const parser = require(path.join(services, 'localScheduleParser.js'));
  return {
    classify: parser.classifyScheduleParseIntent,
    cleanup: () => fs.rmSync(temp, { recursive: true, force: true }),
  };
}

function main() {
  const input = path.resolve(argument('--input'));
  const output = path.resolve(argument('--json-out'));
  const minimum = Number(argument('--minimum', false) || '0.95');
  if (!(minimum >= 0 && minimum <= 1)) throw new Error('minimum_invalid');
  const inputBytes = fs.readFileSync(input);
  const rows = inputBytes.toString('utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const runtime = loadClassifier();
  const matrix = {};
  const mismatches = [];
  let exact = 0;
  try {
    for (const row of rows) {
      const expected = INTENT_MAP[row?.expected?.source_intent];
      const text = String(row?.text || '').trim();
      if (!expected || !text || row?.source?.dataset !== 'AmazonScience/massive') {
        throw new Error('source_row_invalid');
      }
      const observed = runtime.classify(text);
      const key = `${expected}->${observed}`;
      matrix[key] = (matrix[key] || 0) + 1;
      if (expected === observed) exact += 1;
      else mismatches.push({
        source_id: String(row.id || row.source?.source_id || ''),
        utterance_sha256: sha256(text),
        expected,
        observed,
      });
    }
  } finally {
    runtime.cleanup();
  }
  const accuracy = rows.length > 0 ? exact / rows.length : 0;
  const report = {
    schema_version: 1,
    candidate_only: true,
    production_mutation: false,
    source_policy: 'MASSIVE zh-CN source intent supervision only; no LaoJi field or human-adjudication claim',
    source_sha256: sha256(inputBytes),
    parser_source_sha256: sha256(fs.readFileSync(SOURCE)),
    total: rows.length,
    intent_exact: exact,
    intent_accuracy: Number(accuracy.toFixed(6)),
    minimum,
    passed: rows.length >= 30 && accuracy >= minimum,
    matrix,
    mismatches,
    field_promotion_eligible: false,
    remaining: [
      'independent human LaoJi field adjudication',
      'reference-datetime field oracle',
      'model route and Android save replay',
    ],
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({
    total: report.total,
    intent_exact: report.intent_exact,
    intent_accuracy: report.intent_accuracy,
    passed: report.passed,
  })}\n`);
  return report.passed ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'evaluation_failed'}\n`);
  process.exitCode = 2;
}
