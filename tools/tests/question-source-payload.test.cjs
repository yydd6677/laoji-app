const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');
const ts = require('typescript');
const moduleValue = {exports:{}};
const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../src/services/questionSourcePayload.ts'), 'utf8'),
  { compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
new Function('require','module','exports',code)(require,moduleValue,moduleValue.exports);
const {encodeInlineQuestionSources: encode} = moduleValue.exports;
const row = text => ({source_type:'transcript',source_id:'source:stable',source_revision_id:'revision:stable',
  content_sha256:'sha256:'+'a'.repeat(64),text});

test('lossless deterministic gzip preserves every UTF-8 text byte and metadata', () => {
  const sources = [row(' \t记录\n😀 \n'.repeat(300)),
    {...row('我的记录\n'),source_type:'manual_note',source_id:'note:stable'},
    {...row('附件原文\n'),source_type:'attachment',source_id:'attachment:stable'}];
  const before = JSON.stringify(sources);
  const result = encode(sources);
  assert.equal(result.sources, undefined);
  assert.equal(result.compressed_sources.encoding, 'gzip-base64');
  assert.equal(result.compressed_sources.uncompressed_bytes, Buffer.byteLength(before));
  const decoded = zlib.gunzipSync(Buffer.from(result.compressed_sources.data,'base64')).toString('utf8');
  assert.equal(decoded,before);
  assert.equal(JSON.stringify(sources),before);
  assert.deepEqual(encode(sources),result);
});

test('small text keeps the smaller existing wire representation', () => {
  const sources = [row('请周五确认。')];
  assert.deepEqual(encode(sources),{sources});
});

test('wire compression cannot make an oversized inline source eligible', () => {
  assert.throws(()=>encode([row('字'.repeat(100000))]),RangeError);
  assert.throws(()=>encode(Array(1025).fill(row('a'))),RangeError);
});

test('close-to-budget sources remain exact after compression', () => {
  const sources = Array.from({length:10},(_,i)=>({...row('字'.repeat(8000)),source_id:'s'+i}));
  const encoded = encode(sources);
  assert.deepEqual(JSON.parse(zlib.gunzipSync(Buffer.from(encoded.compressed_sources.data,'base64'))),sources);
});
