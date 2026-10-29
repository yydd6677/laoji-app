const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { ensureMetro, probeMetro } = require('../android-metro.cjs');

async function server(root, fn) {
  const service = http.createServer((req, res) => {
    res.setHeader('X-React-Native-Project-Root', encodeURI(root)); res.end('packager-status:running');
  });
  await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
  try { await fn(service.address().port); } finally { await new Promise(resolve => service.close(resolve)); }
}
async function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'laoji-metro-test-'));
  try { await fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
test('healthy exact-root server is reused without spawn or registry mutation', async () => {
  await server(process.cwd(), async port => {
    assert.equal(await probeMetro(process.cwd(), port), true);
    await ensureMetro({ root: process.cwd(), port, spawnServer() { assert.fail('must not spawn'); } });
  });
});
test('another workspace is rejected without stopping or replacing its service', async () => {
  await fixture(async root => server(root, async port => {
    await assert.rejects(ensureMetro({ root: process.cwd(), port, spawnServer() { assert.fail('must not spawn'); } }), /另一个工作区/);
    assert.equal(await probeMetro(root, port), true);
  }));
});
test('live starting PID is retained after observation timeout, not restarted', async () => {
  await fixture(async root => {
    const registry = path.join(root, '.laoji-metro-8083.json');
    fs.writeFileSync(registry, JSON.stringify({ pid: process.pid }));
    await assert.rejects(ensureMetro({ root, port: 8083, probe: async () => false, waitMs: 0,
      spawnServer() { assert.fail('must not duplicate active process'); } }), /仍在启动/);
    assert.equal(JSON.parse(fs.readFileSync(registry)).pid, process.pid);
  });
});
test('a malformed owner is not silently replaced', async () => {
  await fixture(async root => {
    fs.writeFileSync(path.join(root, '.laoji-metro-8083.json'), 'unknown owner');
    await assert.rejects(ensureMetro({ root, port: 8083, probe: async () => false,
      spawnServer() { assert.fail('must not spawn'); } }), /无法确认/);
  });
});
test('owned Metro starts detached with a memory-bounded worker pool and explicit override', async () => {
  for (const limit of [undefined,'2']) await fixture(async root => {
    fs.mkdirSync(path.join(root,'node_modules/expo'),{recursive:true});
    fs.writeFileSync(path.join(root,'node_modules/expo/package.json'),'{"name":"expo"}');
    let started=false;
    await ensureMetro({root,port:8083,env:limit?{LAOJI_METRO_MAX_WORKERS:limit}:{},probe:async()=>started,
      spawnServer(command,args,options){
        assert.equal(options.detached,true);assert.equal(options.cwd,root);
        const count=Number(args[args.indexOf('--max-workers')+1]);
        if(limit)assert.equal(count,2);else assert.ok(count>=1&&count<=4);
        started=true;const child=new EventEmitter();child.pid=process.pid;child.unref=()=>{};return child;
      }});
    assert.equal(JSON.parse(fs.readFileSync(path.join(root,'.laoji-metro-8083.json'))).pid,process.pid);
  });
});
