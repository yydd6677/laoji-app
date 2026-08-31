#!/usr/bin/env node

/*
 * This tool inventories copy that needs semantic review. It deliberately does
 * not claim that equal strings are always redundant, or that different strings
 * express different information. The reviewer must inspect the rendered states
 * and assign one visible owner to each object, state, action, consequence and
 * recovery path.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));
const summaryOnly = args.has('--summary');

function changedFiles() {
  const output = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMR', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  });
  return output.split(/\r?\n/).filter(Boolean);
}

function isUiSource(relative) {
  if (!/\.(?:tsx?|kt)$/.test(relative)) return false;
  if (/^src\/(?:components|screens|navigation)\//.test(relative)) return true;
  return /^modules\/laoji-native-platform\/android\/src\/main\/java\/com\/laoji\/nativeplatform\/(?:calendar|calendarpages|minutes|schedulevoice|speaker|ui)\//.test(relative);
}

function lineNumber(source, offset) {
  return source.slice(0, offset).split('\n').length;
}

function normalize(text) {
  return text
    .replace(/\$\{[^}]+\}/g, '#')
    .replace(/\\[nrt]/g, ' ')
    .replace(/[\s，。！？、：；,.!?:;（）()【】\[\]“”'"`·]/g, '')
    .trim();
}

function extractCopy(source) {
  const items = [];
  const literal = /(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  let match;
  while ((match = literal.exec(source)) !== null) {
    const text = match[2].trim();
    if (!/[\u3400-\u9fff]/.test(text) || text.length > 180) continue;
    if (/^(?:https?:|[A-Z0-9_./{}$-]+$)/.test(text)) continue;
    items.push({ text, normalized: normalize(text), line: lineNumber(source, match.index) });
  }
  return items;
}

const files = changedFiles().filter(isUiSource).filter(relative => fs.existsSync(path.join(root, relative)));
let copyCount = 0;
let repeatedGroupCount = 0;
let reviewCandidateCount = 0;
const reports = [];

for (const relative of files) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8');
  const items = extractCopy(source);
  copyCount += items.length;
  const byMeaningCandidate = new Map();
  for (const item of items) {
    if (!item.normalized) continue;
    const existing = byMeaningCandidate.get(item.normalized) || [];
    existing.push(item);
    byMeaningCandidate.set(item.normalized, existing);
  }
  const repeats = [...byMeaningCandidate.values()].filter(group => group.length > 1);
  const candidates = items.filter(item => /(正在|等待|完成|失败|不可用|重试|请|点击|打开|关闭|保存|删除|上传|下载|生成|同步|稍后|后台)/.test(item.text));
  repeatedGroupCount += repeats.length;
  reviewCandidateCount += candidates.length;
  if (repeats.length || candidates.length) reports.push({ relative, repeats, candidates });
}

process.stdout.write(
  `UI semantic-review inventory: ${files.length} changed surfaces, ${copyCount} copy literals, ${repeatedGroupCount} exact-repeat groups, ${reviewCandidateCount} state/action/recovery candidates.\n`,
);
process.stdout.write('REVIEW REQUIRED: different wording may still repeat one fact; equal wording may be valid in mutually exclusive states. Inspect rendered coexistence and transitions.\n');

if (!summaryOnly) {
  for (const report of reports) {
    process.stdout.write(`\n${report.relative}\n`);
    for (const group of report.repeats) {
      process.stdout.write(`  repeat candidate x${group.length}: ${JSON.stringify(group[0].text)} @ ${group.map(item => item.line).join(', ')}\n`);
    }
    for (const item of report.candidates) {
      process.stdout.write(`  review: ${item.line}: ${JSON.stringify(item.text)}\n`);
    }
  }
}
