#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const sourcePath = path.resolve(
  __dirname,
  '../../src/services/scheduleTranscript.ts',
);
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: sourcePath,
}).outputText;
const loaded = { exports: {} };
new Function('module', 'exports', 'require', compiled)(
  loaded,
  loaded.exports,
  require,
);

const { appendScheduleTranscriptSegment } = loaded.exports;
let segments = [];
segments = appendScheduleTranscriptSegment(segments, {
  segmentId: 'schedule:0',
  isFinal: false,
  text: '明天下午三点开会',
  receivedAt: 10,
  startTime: 0,
  endTime: 0.8,
});
segments = appendScheduleTranscriptSegment(segments, {
  segmentId: 'schedule:0',
  isFinal: false,
  text: '明天下午三点讨论发布',
  receivedAt: 20,
  startTime: 0,
  endTime: 2.4,
});
assert.equal(segments.length, 1);
assert.equal(segments[0].text, '明天下午三点讨论发布');

segments = appendScheduleTranscriptSegment(segments, {
  segmentId: 'schedule:0',
  isFinal: true,
  text: '明天下午三点开会讨论发布',
  receivedAt: 30,
  startTime: 0,
  endTime: 3.1,
});
assert.equal(segments.length, 1);
assert.equal(segments[0].isFinal, true);
assert.equal(segments[0].text, '明天下午三点开会讨论发布');

segments = appendScheduleTranscriptSegment(segments, {
  segmentId: 'schedule:0',
  isFinal: false,
  text: '迟到的预览',
  receivedAt: 40,
  startTime: 0,
  endTime: 2.4,
});
assert.equal(segments.length, 1);
assert.equal(segments[0].text, '明天下午三点开会讨论发布');

segments = appendScheduleTranscriptSegment(segments, {
  segmentId: 'schedule:3200',
  isFinal: true,
  text: '地点在三号会议室',
  receivedAt: 50,
  startTime: 3.2,
  endTime: 4.5,
});
assert.equal(segments.length, 2);
assert.equal(segments[1].text, '地点在三号会议室');

console.log('schedule transcript revision contract passed');
