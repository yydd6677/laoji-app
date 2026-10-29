const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../src/native/nativeMinutesSnapshots.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const m = { exports: {} };
new Function('require', 'module', 'exports', code)(name => {
  if (name === 'laoji-native-platform') return { MINUTES_SNAPSHOT_SCHEMA_VERSION: 1 };
  if (name.endsWith('/meetingSummaryDocument')) return {
    dedupeMeetingSummaryActions: value => value,
    meetingSummarySectionsForPresentation: value => value,
    isMeetingSummaryActionSection: () => false,
  };
  if (name.endsWith('/simplifiedChinese')) return { toSimplifiedChinese: value => value };
  if (name.endsWith('/speakerLabels')) return { speakerDisplayLabel: value => value };
  if (name.endsWith('/meetingMedia')) return { formatDuration: () => '00:00' };
  throw Error(name);
}, m, m.exports);
const build = input => m.exports.buildNativeMinutesDetailSnapshot({
  meetingId: 'meeting', title: '项目讨论', activeTab: 'summary', transcript: [],
  canGenerateSummary: true, ...input,
}).detail;
const actions = [{ id: 'action', content: '核对资料', status: 'suggested', citations: [], dueAtMs: null, reminderAtMs: null }];
const document = { sections: [{ id: 'overview', stableKey: 'overview', kind: 'paragraph', title: '概述', content: '先核对资料。', citations: [] }], actionItemCandidates: actions };

test('unread local roots, read failure and confirmed absence are distinct from an empty summary', () => {
  const pending = build({ available: false, sourceLoading: true, title: '会议记录' });
  for (const page of Object.values(pending.pageStates)) assert.equal(page.phase, 'loading');
  assert.equal(pending.canGenerateSummary, false);
  assert.equal(pending.summaryGenerating, false);
  const failed = build({ available: false, sourceError: '会议记录暂时无法读取，请稍后重试。' });
  assert.equal(failed.pageStates.summary.phase, 'error');
  assert.equal(failed.pageStates.summary.message, '会议记录暂时无法读取，请稍后重试。');
  assert.equal(failed.canGenerateSummary, false);
  const missing = build({ available: false, sourceLoading: false });
  assert.equal(missing.pageStates.summary.message, '会议记录不存在');
  const empty = build({ available: true, sourceLoading: false, summaryRestoring: false });
  assert.equal(empty.pageStates.summary.message, '该会议暂未生成整理结果');
});

test('initial local restore cannot expose action-only or generate-empty frames before the document', () => {
  const pending = build({ summaryRestoring: true, actionItemCandidates: actions });
  assert.deepEqual(pending.actions, []);
  assert.deepEqual(pending.summary, []);
  assert.equal(pending.pageStates.summary.phase, 'loading');
  assert.equal(pending.canGenerateSummary, false);
  assert.equal(pending.summaryGenerating, false, 'a local read is not a generation task');
  assert.equal(pending.processingStatusLabel, '');
  const ready = build({ summaryRestoring: false, summaryDocument: document, actionItemCandidates: actions });
  assert.equal(ready.summary.length, 1);
  assert.equal(ready.actions.length, 1);
  assert.equal(ready.pageStates.summary.phase, 'ready');
});

test('retained results remain visible during restore or generation; genuinely action-only records remain valid', () => {
  const retained = build({ summaryRestoring: true, summaryLoading: true, summaryDocument: document, actionItemCandidates: actions });
  assert.equal(retained.summary.length, 1);
  assert.equal(retained.actions.length, 1);
  assert.equal(build({ summaryRestoring: false, actionItemCandidates: actions }).actions.length, 1);
});
