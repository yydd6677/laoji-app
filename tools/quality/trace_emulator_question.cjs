// Private diagnostic: exercise the real app owner and record timings, not bodies.
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { openCdp } = require('../hardware/runtime_cdp.cjs');
const { runtimeModuleExpression, selectRuntimeTarget } = require('../hardware/runtime_module.cjs');
const { acquireInspectionLock } = require('../hardware/inspection_lock.cjs');

const [meetingId, question, outputPath, noteFlag] = process.argv.slice(2);
if (!meetingId || !question || !outputPath) throw Error('meeting, question and private output path required');
if (noteFlag && noteFlag !== '--include-note') throw Error('unknown source option');
(async () => {
  const release = await acquireInspectionLock();
  let cdp;
  const inbox = `globalThis[${JSON.stringify('__q2Trace_' + randomUUID())}]`;
  try {
    const targets = await (await fetch('http://127.0.0.1:8083/json/list')).json();
    cdp = await openCdp(WebSocket, selectRuntimeTarget(targets).webSocketDebuggerUrl);
    const expression = `(()=>{
      const q=${runtimeModuleExpression('src/services/meetingQuestions.ts')};
      const api=${runtimeModuleExpression('src/services/deviceV2Api.ts')};
      const originalFetch=globalThis.fetch, calls=[];
      let start;
      ${inbox}={done:false};
      return api.loadDeviceV2Capabilities({forceRefresh:true}).then(()=>
        q.prepareMeetingQuestionSession({scopeKey:'guest',navigationMeetingId:${JSON.stringify(meetingId)},includeManualNote:${noteFlag === '--include-note'},forceNew:true})
      ).then(session=>{
        start=Date.now();
        globalThis.fetch=(url,init)=>{
          const at=Date.now();
          const requestBytes=typeof init?.body==='string'?new TextEncoder().encode(init.body).byteLength:null;
          return originalFetch(url,init).then(response=>{
            calls.push({path:'/'+String(url).split('/').slice(3).join('/').split('?')[0],status:response.status,ms:Date.now()-at,requestBytes});
            return response;
          },error=>{calls.push({path:String(url).split('?')[0],error:String(error.name),ms:Date.now()-at,requestBytes});throw error;});
        };
        return q.askMeetingQuestion({scopeKey:'guest',navigationMeetingId:${JSON.stringify(meetingId)},session,question:${JSON.stringify(question)}});
      }).then(session=>{${inbox}={done:true,wall_ms:Date.now()-start,calls,session};},
        error=>{${inbox}={done:true,wall_ms:start?Date.now()-start:null,calls,error:String(error)};})
      .finally(()=>{globalThis.fetch=originalFetch;});
    })();undefined`;
    const first = await cdp.evaluate(expression);
    if (first.result?.exceptionDetails || first.error) throw Error(JSON.stringify(first));
    const deadline = Date.now() + 280_000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const reply = await cdp.evaluate(`JSON.stringify(${inbox})`);
      const result = JSON.parse(reply.result?.result?.value ?? '{}');
      if (!result.done) continue;
      fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), {mode:0o600,flag:'wx'});
      console.log(JSON.stringify({wall_ms: result.wall_ms,calls:result.calls,error:result.error,
        turnCount:result.session?.thread?.turns?.length}));
      if (result.error) process.exitCode = 1;
      return;
    }
    throw Error('Trace timed out; app work may still be running and will restore fetch on settlement');
  } finally {
    if (cdp?.isOpen()) await cdp.evaluate(`if(${inbox}?.done)delete ${inbox}`).catch(()=>{});
    cdp?.close(); release();
  }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
