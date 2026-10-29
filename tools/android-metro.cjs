/* The bundler may outlive a build. Keep its process separate so a healthy
 * development server cannot hold the generated-tree build lock forever. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

async function probeMetro(root, port) {
  let response;
  try { response = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(1500) }); }
  catch { return false; }
  const source = response.headers.get('X-React-Native-Project-Root');
  if (!response.ok || (await response.text()).trim() !== 'packager-status:running' || !source) {
    throw new Error(`端口 ${port} 不是可确认的 Metro，未重启或覆盖该服务。`);
  }
  const actual = fs.realpathSync(decodeURI(source)); const expected = fs.realpathSync(root);
  if ((process.platform === 'win32' ? actual.toLowerCase() !== expected.toLowerCase() : actual !== expected)) {
    throw new Error(`端口 ${port} 属于另一个工作区，未停止该服务。`);
  }
  return true;
}

async function ensureMetro({ root, port, env = process.env, probe = () => probeMetro(root, port),
  spawnServer = spawn, waitMs = 15000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), logPath }) {
  if (await probe()) return;
  const registry = path.join(root, `.laoji-metro-${port}.json`);
  let owner;
  if (fs.existsSync(registry)) {
    try { owner = JSON.parse(fs.readFileSync(registry, 'utf8')); }
    catch { throw new Error(`无法确认已有开发服务器归属，请先检查 ${registry}。`); }
  }
  let startError;
  if (!alive(owner?.pid)) {
    const digest = crypto.createHash('sha256').update(root).digest('hex').slice(0, 12);
    const log = logPath || path.join(os.tmpdir(), `laoji-metro-${digest}-${port}.log`);
    const fd = fs.openSync(log, 'w', 0o600);
    let child;
    try {
      const cli = path.join(path.dirname(require.resolve('expo/package.json', { paths: [root] })), 'bin', 'cli');
      const workers = env.LAOJI_METRO_MAX_WORKERS || String(Math.min(4, os.availableParallelism?.() || os.cpus().length || 1));
      if (!/^[1-9]\d*$/.test(workers) || Number(workers) > 256) throw new Error('LAOJI_METRO_MAX_WORKERS 无效');
      child = spawnServer(process.execPath, [cli, 'start', '--dev-client', '--port', String(port), '--localhost', '--max-workers', workers],
        { cwd: root, env: { ...env, NODE_ENV: 'development' }, detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
      child.on('error', error => { startError = error; }); child.unref();
    } finally { fs.closeSync(fd); }
    if (!child.pid) throw new Error(`开发服务器未能启动，日志 ${log}`);
    owner = { schema: 1, pid: child.pid, port, log };
    fs.writeFileSync(registry, JSON.stringify(owner), { mode: 0o600 });
  }
  const deadline = Date.now() + waitMs;
  do {
    if (startError) throw startError;
    if (await probe()) return;
    if (!alive(owner.pid)) throw new Error(`开发服务器启动失败，请检查 ${owner.log || registry}。`);
    if (Date.now() >= deadline) break;
    await sleep(250);
  } while (true);
  // A timeout is not proof of a stopped process. Keep it and let the next
  // invocation probe the same PID, rather than starting another server.
  throw new Error(`开发服务器仍在启动 (PID ${owner.pid})，未重复启动；请检查 ${owner.log || registry}。`);
}

module.exports = { ensureMetro, probeMetro };
