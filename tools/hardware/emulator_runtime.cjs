// Inspect the emulator's actual JS runtime. UI actions remain separate evidence.
const { randomUUID } = require('node:crypto');
const { openCdp } = require('./runtime_cdp.cjs');
const { runtimeModuleExpression, selectRuntimeTarget } = require('./runtime_module.cjs');
const { acquireInspectionLock } = require('./inspection_lock.cjs');
const [modulePath, expression, waitArgument = '12000'] = process.argv.slice(2);
const waitMs = Number(waitArgument);
if (!Number.isSafeInteger(waitMs) || waitMs < 500 || waitMs > 50000) throw Error('inspection wait must be 500..50000 milliseconds');
if (!modulePath || !expression) throw Error('module path and function expression required');
(async () => {
  const release = await acquireInspectionLock();
  let connection;
  // A timed-out request can settle after this tool disconnects. Give each
  // invocation its own inbox so it cannot overwrite a later inspection.
  const inbox = `globalThis[${JSON.stringify(`__hardwareInspect_${randomUUID()}`)}]`;
  try {
    const targets = await (await fetch('http://127.0.0.1:8083/json/list', { signal: AbortSignal.timeout(5000) })).json();
    const target = selectRuntimeTarget(targets);
    connection = await openCdp(WebSocket, target.webSocketDebuggerUrl);
    const evaluate = connection.evaluate;
    const start = await evaluate(`${inbox}={done:false};Promise.resolve().then(()=>(${expression})(${runtimeModuleExpression(modulePath)})).then(value=>{if(${inbox})${inbox}={done:true,value}},error=>{if(${inbox})${inbox}={done:true,error:String(error)}});undefined`);
    if (start.result?.exceptionDetails || start.error) throw Error(JSON.stringify(start));
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 200));
      const result = await evaluate(`JSON.stringify(${inbox})`);
      const value = JSON.parse(result.result?.result?.value ?? '{}');
      if (value.done) {
        if (value.error) throw Error(value.error);
        console.log(JSON.stringify(value.value, null, 2)); return;
      }
    }
    throw Error('Runtime inspection timeout; native work may still be running');
  } finally {
    if (connection?.isOpen()) await connection.evaluate(`delete ${inbox}`).catch(() => {});
    connection?.close();release();
  }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
