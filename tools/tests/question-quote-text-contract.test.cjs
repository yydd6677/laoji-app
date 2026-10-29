const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const m = { exports: {} };
const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname,
  '../../src/services/questionQ2DeviceProvider.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
new Function('require', 'module', 'exports', code + '\nexports.exactQuote=exactQuote;')(
  () => ({}), m, m.exports);

test('quote normalization preserves exact whitespace and Unicode bytes', () => {
  for (const text of [' 第一行\n第二行 ', '\t发言人：核对接口。\r\n', '😀会议记录']) {
    assert.equal(m.exports.exactQuote(text), text);
    assert.deepEqual(Buffer.from(m.exports.exactQuote(text)), Buffer.from(text));
  }
});
test('metadata-like controls, empty quotes and excessive bodies still fail closed', () => {
  for (const value of ['', ' \n\t', null, '数据\u0000', '字'.repeat(601)]) {
    assert.throws(() => m.exports.exactQuote(value));
  }
});
