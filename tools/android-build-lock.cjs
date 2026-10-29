/* One generated Android tree has one builder. The lock lives OUTSIDE android/
 * because Expo --clean replaces that entire directory. Atomic creation works
 * on Linux and Windows; this is not an app/runtime lock. */
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function acquireAndroidBuildLock(root) {
  const file = path.join(root, '.laoji-android-build.lock');
  const token = randomUUID();
  let fd;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let owner;
    try { owner = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* Fail closed for interrupted creation. */ }
    const pid = Number.isInteger(owner?.pid) && owner.pid > 0 ? owner.pid : '未知';
    throw new Error(`Android 构建目录已被占用 (PID ${pid})。请等待现有构建；若已异常退出，先确认其子进程结束，再移除 ${file}。`);
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({ schema: 1, pid: process.pid, token, startedAt: new Date().toISOString() }));
    fs.fsyncSync(fd);
  } catch (error) {
    fs.closeSync(fd); fs.rmSync(file, { force: true }); throw error;
  }
  fs.closeSync(fd);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      const current = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (current.token === token && current.pid === process.pid) fs.unlinkSync(file);
    } catch { /* Never remove an unknown/replaced owner's lock. */ }
    process.removeListener('exit', release);
  };
  process.once('exit', release);
  return release;
}

module.exports = { acquireAndroidBuildLock };
