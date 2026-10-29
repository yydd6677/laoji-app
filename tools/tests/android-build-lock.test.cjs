const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const modulePath = path.resolve(__dirname, '../android-build-lock.cjs');
const { acquireAndroidBuildLock } = require(modulePath);

function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'laoji-build-lock-'));
  try { fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('another builder is rejected before it can replace the generated tree', () => fixture(root => {
  const release = acquireAndroidBuildLock(root);
  const generated = path.join(root, 'android'); fs.mkdirSync(generated);
  const sentinel = path.join(generated, 'current.txt'); fs.writeFileSync(sentinel, 'keep');
  try {
    const child = spawnSync(process.execPath, ['-e', `
      require(${JSON.stringify(modulePath)}).acquireAndroidBuildLock(${JSON.stringify(root)});
      require('node:fs').rmSync(${JSON.stringify(generated)},{recursive:true});
    `], { encoding: 'utf8' });
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /Android 构建目录已被占用/);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
  } finally { release(); }
}));

test('normal completion releases the lock and release is idempotent', () => fixture(root => {
  const first = acquireAndroidBuildLock(root); first(); first();
  const second = acquireAndroidBuildLock(root); second();
  assert.equal(fs.existsSync(path.join(root, '.laoji-android-build.lock')), false);
}));

test('normal child process exit releases its own lock', () => fixture(root => {
  const child = spawnSync(process.execPath, ['-e',
    `require(${JSON.stringify(modulePath)}).acquireAndroidBuildLock(${JSON.stringify(root)});process.exit(7)`]);
  assert.equal(child.status, 7);
  const release = acquireAndroidBuildLock(root); release();
}));

test('release cannot remove another owner or a malformed lock', () => fixture(root => {
  const release = acquireAndroidBuildLock(root);
  const file = path.join(root, '.laoji-android-build.lock');
  const other = JSON.stringify({ pid: process.pid, token: 'another-owner' });
  fs.writeFileSync(file, other); release();
  assert.equal(fs.readFileSync(file, 'utf8'), other);
  fs.writeFileSync(file, 'interrupted creation');
  assert.throws(() => acquireAndroidBuildLock(root), /PID 未知/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'interrupted creation');
}));

test('a dead parent alone is not proof that its Gradle children stopped', () => fixture(root => {
  const file = path.join(root, '.laoji-android-build.lock');
  fs.writeFileSync(file, JSON.stringify({ pid: 2147483647, token: 'interrupted' }));
  assert.throws(() => acquireAndroidBuildLock(root), /先确认其子进程结束/);
  assert.equal(fs.existsSync(file), true);
}));
