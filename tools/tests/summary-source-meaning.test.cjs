const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const m = { exports: {} };
const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname,
  '../../src/domain/meeting/summarySourceMeaning.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
new Function('module', 'exports', code)(m, m.exports);
const meaning = m.exports.summaryTranscriptMeaning;
const row = { text: '周五交付接口文档。', speakerLabel: '张敏', startMs: 10, endMs: 100, confidence: .6, speakerClusterId: 'old' };
test('alignment, confidence and opaque identity changes do not change summary meaning', () => {
  assert.equal(meaning([row]), meaning([{ ...row, startMs: 0, endMs: 101, confidence: .9, speakerClusterId: 'new' }]));
});
test('splitting an identical utterance does not require regeneration', () => {
  assert.equal(meaning([row]), meaning([{ ...row, text: '周五交付' }, { ...row, text: '接口文档。' }]));
  assert.equal(meaning([{ text: 'send the report' }]), meaning([{ text: 'send' }, { text: 'the report' }]));
});
test('word, speaker and negation changes remain real changes', () => {
  for (const changed of [{ ...row, text: '周六交付接口文档。' }, { ...row, text: '周五不交付接口文档。' },
    { ...row, speakerLabel: '李强' }, { ...row, speakerLabelOverride: '另一个人' }]) {
    assert.notEqual(meaning([row]), meaning([changed]));
  }
});
test('language-bearing spaces and punctuation are not erased', () => {
  assert.notEqual(meaning([{ text: 'now here' }]), meaning([{ text: 'nowhere' }]));
  assert.notEqual(meaning([{ text: '不，可以提交。' }]), meaning([{ text: '不可以提交。' }]));
});
