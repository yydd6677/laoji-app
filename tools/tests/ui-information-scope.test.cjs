const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { inventory, parseArgs } = require('../audit-ui-information-ownership.cjs');

test('an explicit slice includes untracked/deleted files and excludes unrelated dirty history', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'laoji-ui-scope-'));
  const write = (name, data) => { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), data); };
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  try {
    git(['init', '-q']);
    write('src/screens/Old.tsx', 'const label="过去"');
    write('src/screens/Other.tsx', 'const label="其他"');
    git(['add', '.']);
    git(['-c', 'user.name=UI scope test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
    fs.unlinkSync(path.join(root, 'src/screens/Old.tsx'));
    write('src/screens/Other.tsx', 'const label="无关更改"');
    write('src/components/New.tsx', 'const label="正在读取"');
    const args = parseArgs(['--files', 'src/components/New.tsx', 'src/screens/Old.tsx']);
    const before = inventory(root, args);
    assert.equal(before.files, 1);
    assert.equal(before.copyCount, 1);
    assert.deepEqual(before.slice.map(item => item.status), ['??', ' D']);
    assert.equal(before.semanticVerdict, 'review_required');
    write('src/components/New.tsx', 'const label="正在整理"');
    assert.notEqual(inventory(root, args).fingerprint, before.fingerprint);
    assert.equal(inventory(root, parseArgs(['--changed'])).files, 2);
    const media = 'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/media/';
    write(`${media}MinutesPlayerView.kt`, 'val label="播放会议录音"');
    write(`${media}MinutesPlaybackController.kt`, 'val diagnostic="内部日志"');
    const mediaScope = inventory(root, parseArgs(['--changed']));
    assert.equal(mediaScope.files, 3, 'real media UI must be reviewed, not unrelated media internals');
    assert.ok(mediaScope.slice.some(item => item.path === `${media}MinutesPlayerView.kt` && item.ui));
    assert.throws(() => inventory(root, parseArgs(['--base', 'missing-ref'])), /git/);
    assert.throws(() => inventory(root, parseArgs(['--files', 'missing.tsx'])), /Missing claimed/);
    assert.throws(() => inventory(root, parseArgs(['--files', '../outside'])), /outside/);
    assert.throws(() => parseArgs(['--files']), /at least one/);
  } finally { fs.rmSync(root, { recursive: true }); }
});
