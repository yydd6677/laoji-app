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
const crypto = require('crypto');

function parseArgs(args) {
  const options = { base: 'HEAD', files: [], summaryOnly: false, json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--changed') continue;
    if (arg === '--summary') options.summaryOnly = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--base') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error('--base requires a commit/ref');
      options.base = args[++i];
    } else if (arg === '--files') {
      const start = options.files.length;
      while (args[i + 1] && !args[i + 1].startsWith('--')) options.files.push(args[++i]);
      if (options.files.length === start) throw Error('--files requires at least one path');
    } else throw Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function isUiSource(relative) {
  if (!/\.(?:tsx?|kt)$/.test(relative)) return false;
  if (/^src\/(?:components|screens|navigation)\//.test(relative)) return true;
  if (/^modules\/laoji-native-platform\/android\/src\/main\/java\/com\/laoji\/nativeplatform\/media\/(?:MinutesPlayerView|MinutesPlaybackSpeedSheet)\.kt$/.test(relative)) return true;
  return /^modules\/laoji-native-platform\/android\/src\/main\/java\/com\/laoji\/nativeplatform\/(?:calendar|calendarpages|minutes|speaker|ui|hardware)\//.test(relative);
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

function inventory(root, options) {
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const baseCommit = git(['rev-parse', '--verify', '--end-of-options', `${options.base}^{commit}`]).trim();
const comparison = new Map();
const changes = git(['diff', '--name-status', '--no-renames', '-z', baseCommit]).split('\0');
for (let i = 0; i + 1 < changes.length; i += 2) comparison.set(changes[i + 1], changes[i]);
const statuses = new Map();
const statusItems = git(['status', '--porcelain=v1', '-z', '--untracked-files=all']).split('\0');
for (let i = 0; i < statusItems.length; i++) {
  const item = statusItems[i];
  if (!item) continue;
  statuses.set(item.slice(3), item.slice(0, 2));
  if (/[RC]/.test(item.slice(0, 2))) i++; // porcelain -z puts the old name next.
}
const candidates = options.files.length ? options.files : [
  ...comparison.keys(),
  ...git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0'),
];
const claimed = [...new Set(candidates.filter(relative => relative && (options.files.length || isUiSource(relative))).map(relative => {
  const absolute = path.resolve(root, relative);
  const normalized = path.relative(root, absolute).split(path.sep).join('/');
  if (normalized.startsWith('../') || normalized === '..' || !normalized) throw Error(`Path outside file scope: ${relative}`);
  return normalized;
}))].sort();
const slice = claimed.map(relative => {
  const absolute = path.join(root, relative);
  const exists = fs.existsSync(absolute);
  const status = statuses.get(relative) || '  ';
  const baseStatus = comparison.get(relative) || (status === '??' ? 'untracked' : 'unchanged');
  if (!exists && !status.includes('D') && baseStatus !== 'D') throw Error(`Missing claimed file: ${relative}`);
  if (exists && !fs.statSync(absolute).isFile()) throw Error(`Expected file: ${relative}`);
  return { path: relative, status, baseStatus, ui: isUiSource(relative),
    sha256: exists ? crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex') : null };
});
const files = slice.filter(file => file.ui && file.sha256).map(file => file.path);
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

return { baseCommit, slice, fingerprint: crypto.createHash('sha256').update(JSON.stringify(slice)).digest('hex'),
  files: files.length, copyCount, repeatedGroupCount, reviewCandidateCount, reports,
  semanticVerdict: 'review_required' };
}

function main() {
const options = parseArgs(process.argv.slice(2));
const result = inventory(path.resolve(__dirname, '..'), options);
if (options.json) { process.stdout.write(JSON.stringify(result, null, 2) + '\n'); return; }
const { files, copyCount, repeatedGroupCount, reviewCandidateCount, reports } = result;
process.stdout.write(
  `UI semantic-review inventory: ${files} scoped surfaces, ${copyCount} copy literals, ${repeatedGroupCount} exact-repeat groups, ${reviewCandidateCount} state/action/recovery candidates.\nSlice SHA-256: ${result.fingerprint}\n`,
);
process.stdout.write('REVIEW REQUIRED: different wording may still repeat one fact; equal wording may be valid in mutually exclusive states. Inspect rendered coexistence and transitions.\n');

if (!options.summaryOnly) {
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
}

module.exports = { parseArgs, inventory, isUiSource, extractCopy };
if (require.main === module) {
  try { main(); } catch (error) { process.stderr.write(`Inventory failed: ${error.message}\n`); process.exitCode = 1; }
}
