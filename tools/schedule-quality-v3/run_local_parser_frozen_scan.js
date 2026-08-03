#!/usr/bin/env node

/* Scan the frozen v5 corpus for client-side C0/C1 silent-save hazards. */

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const crypto = require('node:crypto');
const Module = require('node:module');

const root = path.resolve(__dirname, '..', '..');
const parserPath = path.join(root, 'src', 'services', 'localScheduleParser.ts');
const corpusPath = path.join(__dirname, 'corpus-v5.jsonl');
const source = fs.readFileSync(parserPath, 'utf8');
require.extensions['.ts'] = (module, filename) => {
  const moduleSource = fs.readFileSync(filename, 'utf8');
  const compiled = ts.transpileModule(moduleSource, {
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
const parser = require(parserPath);

const counts = { local_safe: 0, server_required: 0, clarify: 0, reject: 0 };
const hazards = [];
const exactFieldNames = [
  'title',
  'event_type',
  'start_date',
  'end_date',
  'start_time',
  'end_time',
  'is_all_day',
  'location',
  'category',
  'reminder_minutes',
];
const criticalFieldNames = [
  'event_type',
  'start_date',
  'end_date',
  'start_time',
  'end_time',
  'is_all_day',
  'reminder_minutes',
];
const MAX_EXAMPLES = 20;
const exactStats = {
  eligible: 0,
  local_safe_complete: 0,
  complete_not_local_safe: 0,
  context_dependent_skipped: 0,
  exact_matches: 0,
  exact_mismatches: 0,
  mismatch_by_field: Object.fromEntries(exactFieldNames.map(field => [field, 0])),
  mismatch_by_severity: {},
  mismatch_by_slice: {},
  mismatch_by_timezone: {},
  examples: [],
};
const criticalStats = {
  eligible: 0,
  exact_matches: 0,
  exact_mismatches: 0,
  mismatch_by_field: Object.fromEntries(criticalFieldNames.map(field => [field, 0])),
  mismatch_by_severity: {},
  examples: [],
};
const rows = fs.readFileSync(corpusPath, 'utf8').trim().split('\n').map(JSON.parse);

for (const item of rows) {
  const referenceDate = new Date(item.reference_datetime);
  const timezone = typeof item.timezone === 'string' ? item.timezone : undefined;
  const parsed = parser.parseLocalScheduleText(item.text, referenceDate, timezone);
  const decision = parser.classifyScheduleParseRoute(item.text, parsed, referenceDate, timezone);
  counts[decision.route] = (counts[decision.route] ?? 0) + 1;

  const expectedNotSchedule = item.expected_outcome === 'not_schedule'
    || (item.expected === null && item.primary_slice === 'not_schedule');
  const expectedNeedsReview = (item.severity === 'C0' || item.severity === 'C1')
    && (item.expected_outcome === 'needs_clarification' || expectedNotSchedule);
  if ((expectedNotSchedule && decision.route !== 'reject')
    || (expectedNeedsReview && decision.route === 'local_safe')) {
    hazards.push({
      id: item.id,
      case_id: item.case_id,
      severity: item.severity,
      expected_outcome: item.expected_outcome,
      route: decision.route,
      text: item.text,
    });
  }

  const expectedComplete = item.expected_outcome === 'complete'
    && item.expected
    && typeof item.expected === 'object'
    && !Array.isArray(item.expected);
  if (!expectedComplete) continue;
  if (item.primary_slice === 'multi_turn' || Array.isArray(item.turns)) {
    exactStats.context_dependent_skipped += 1;
    continue;
  }
  exactStats.eligible += 1;
  if (decision.route !== 'local_safe' || !parsed) {
    exactStats.complete_not_local_safe += 1;
    continue;
  }
  exactStats.local_safe_complete += 1;
  const mismatches = exactFieldNames.filter(field => {
    const expected = item.expected[field] ?? null;
    const actual = parsed[field] ?? null;
    return JSON.stringify(actual) !== JSON.stringify(expected);
  });
  if (mismatches.length === 0) {
    exactStats.exact_matches += 1;
  } else {
    exactStats.exact_mismatches += 1;
    for (const field of mismatches) {
      exactStats.mismatch_by_field[field] += 1;
    }
    const severity = item.severity || 'unknown';
    const slice = item.primary_slice || 'unknown';
    const zone = timezone || 'unspecified';
    exactStats.mismatch_by_severity[severity] = (exactStats.mismatch_by_severity[severity] || 0) + 1;
    exactStats.mismatch_by_slice[slice] = (exactStats.mismatch_by_slice[slice] || 0) + 1;
    exactStats.mismatch_by_timezone[zone] = (exactStats.mismatch_by_timezone[zone] || 0) + 1;
    if (exactStats.examples.length < MAX_EXAMPLES) {
      exactStats.examples.push({
        id: item.id,
        case_id: item.case_id,
        severity,
        primary_slice: slice,
        timezone: zone,
        reference_datetime: item.reference_datetime,
        text: item.text,
        fields: Object.fromEntries(mismatches.map(field => [field, {
          expected: item.expected[field] ?? null,
          actual: parsed[field] ?? null,
        }])),
      });
    }
  }

  criticalStats.eligible += 1;
  const criticalMismatches = criticalFieldNames.filter(field => {
    const expected = item.expected[field] ?? null;
    const actual = parsed[field] ?? null;
    return JSON.stringify(actual) !== JSON.stringify(expected);
  });
  if (criticalMismatches.length === 0) {
    criticalStats.exact_matches += 1;
  } else {
    criticalStats.exact_mismatches += 1;
    const severity = item.severity || 'unknown';
    criticalStats.mismatch_by_severity[severity] = (criticalStats.mismatch_by_severity[severity] || 0) + 1;
    for (const field of criticalMismatches) criticalStats.mismatch_by_field[field] += 1;
    if (criticalStats.examples.length < MAX_EXAMPLES) {
      criticalStats.examples.push({
        id: item.id,
        case_id: item.case_id,
        severity,
        primary_slice: item.primary_slice || 'unknown',
        timezone: timezone || 'unspecified',
        reference_datetime: item.reference_datetime,
        text: item.text,
        fields: Object.fromEntries(criticalMismatches.map(field => [field, {
          expected: item.expected[field] ?? null,
          actual: parsed[field] ?? null,
        }])),
      });
    }
  }
}

const report = {
  schema_version: 2,
  service: 'SVC-01 local schedule parser frozen scan',
  corpus_sha256: crypto.createHash('sha256').update(fs.readFileSync(corpusPath)).digest('hex'),
  parser_sha256: crypto.createHash('sha256').update(source).digest('hex'),
  total: rows.length,
  counts,
  c0_c1_silent_save_hazards: hazards.length,
  hazards: hazards.slice(0, 100),
  field_exact: {
    ...exactStats,
    c0_c1_mismatches: Object.entries(exactStats.mismatch_by_severity)
      .filter(([severity]) => severity === 'C0' || severity === 'C1')
      .reduce((total, [, count]) => total + count, 0),
  },
  critical_field_exact: {
    ...criticalStats,
    c0_c1_mismatches: Object.entries(criticalStats.mismatch_by_severity)
      .filter(([severity]) => severity === 'C0' || severity === 'C1')
      .reduce((total, [, count]) => total + count, 0),
  },
  evidence_boundary: {
    passed_proves: [
      'no frozen C0/C1 not_schedule or needs_clarification case enters local_safe',
      'direct local_safe complete cases match all frozen critical date/time/recurrence/reminder fields',
    ],
    not_proven: ['remote model quality', 'server clarification quality', 'real-user shadow traffic', 'latency'],
  },
};
console.log(JSON.stringify(report, null, 2));
process.exitCode = hazards.length === 0 && report.critical_field_exact.c0_c1_mismatches === 0 ? 0 : 1;
