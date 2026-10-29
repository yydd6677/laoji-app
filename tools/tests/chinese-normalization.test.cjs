const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const source = fs.readFileSync(path.resolve(__dirname, '../../src/utils/simplifiedChinese.ts'), 'utf8');
const parsed = ts.createSourceFile('simplifiedChinese.ts', source, ts.ScriptTarget.Latest, true);
const dictionaries = {};
function visit(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
    && ['TRADITIONAL_CHARACTERS', 'SIMPLIFIED_CHARACTERS'].includes(node.name.text)
    && ts.isStringLiteral(node.initializer)) dictionaries[node.name.text] = Array.from(node.initializer.text);
  ts.forEachChild(node, visit);
}
visit(parsed);
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function load() {
  let enumerated = 0;
  class CountedArray extends Array {
    static from(input, ...args) {
      if (typeof input === 'string') enumerated += input.length;
      return Array.from(input, ...args);
    }
  }
  const module = { exports: {} };
  new Function('module', 'exports', 'Array', code)(module, module.exports, CountedArray);
  return { ...module.exports, enumerated };
}

test('cold Chinese dictionary initialization enumerates each dictionary only a bounded number of times', () => {
  const loaded = load();
  const size = dictionaries.TRADITIONAL_CHARACTERS.length + dictionaries.SIMPLIFIED_CHARACTERS.length;
  // Count real enumeration work, not a machine-specific wall-clock threshold
  // or a requirement that the implementation use one particular API.
  assert.ok(loaded.enumerated <= size * 4, `repeated dictionary enumeration: ${loaded.enumerated}`);
});

test('linear initialization preserves every bundled character mapping and phrase policy', () => {
  const loaded = load();
  const expected = new Map(dictionaries.TRADITIONAL_CHARACTERS.map((character, index) => [
    character, dictionaries.SIMPLIFIED_CHARACTERS[index] ?? character,
  ]));
  for (const [character, simplified] of expected) assert.equal(loaded.toSimplifiedChinese(character), simplified);
  assert.equal(loaded.toSimplifiedChinese('會議記錄與待辦事項，設定時間。'), '会议记录与待办事项，设定时间。');
  assert.equal(loaded.toSimplifiedChinese('你好 English 123 🗓️ 𠮷\n'), '你好 English 123 🗓️ 𠮷\n');
});

test('transcript conversion preserves identities, times and its immutable input', () => {
  const loaded = load();
  const input = Object.freeze([Object.freeze({ id: 'stable', text: '會議記錄', speaker_label: '發言人', start_time: 1, end_time: 2 })]);
  const result = loaded.simplifyTranscriptLines(input);
  assert.deepEqual(result, [{ id: 'stable', text: '会议记录', speaker_label: '发言人', start_time: 1, end_time: 2 }]);
  assert.equal(input[0].text, '會議記錄');
  assert.notEqual(result[0], input[0]);
});
