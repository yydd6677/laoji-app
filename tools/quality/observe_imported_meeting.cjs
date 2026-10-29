// Observe a normal UI import through read-only app owners; never seed results.
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { openCdp } = require('../hardware/runtime_cdp.cjs');
const { runtimeModuleExpression, selectRuntimeTarget } = require('../hardware/runtime_module.cjs');
const { acquireInspectionLock } = require('../hardware/inspection_lock.cjs');

const [title, reportPath, evidencePath] = process.argv.slice(2);
if (!title || !reportPath || !evidencePath) throw Error('title, new private report and evidence paths required');
(async () => {
  const release = await acquireInspectionLock();
  let cdp, descriptor;
  const slot = `globalThis[${JSON.stringify('__importObserve_' + randomUUID())}]`;
  try {
    descriptor = fs.openSync(reportPath, 'wx', 0o600);
    if (fs.existsSync(evidencePath)) throw Error('Evidence path already exists');
    const targets = await (await fetch('http://127.0.0.1:8083/json/list')).json();
    cdp = await openCdp(WebSocket, selectRuntimeTarget(targets).webSocketDebuggerUrl);
    const began = Date.now(), deadline = began + 15 * 60 * 1000;
    let last = '', pulse = 0;
    while (Date.now() < deadline) {
      const dispatched = await cdp.evaluate(`(()=>{${slot}={done:false};
        const repo=${runtimeModuleExpression('src/data/repositories/sqliteMeetingNoteRepository.ts')}.sqliteMeetingNoteRepository;
        repo.listProjection('guest',{limit:100}).then(rows=>{
          const matches=rows.items.filter(m=>m.title===${JSON.stringify(title)});
          if(matches.length>1)throw Error('Ambiguous meeting title');
          const m=matches[0];if(!m){${slot}={done:true,state:null};return;}
          return repo.getActiveTranscriptContent(m.id,'guest').then(t=>{
          const state={id:m.id,createdAtMs:m.createdAtMs,segments:m.activeTranscriptSegmentCount,
            stages:m.stages.map(s=>({stage:s.stage,status:s.status,updatedAtMs:s.updatedAtMs,errorCode:s.errorCode})),
            asset:m.primaryRecording?{mimeType:m.primaryRecording.mimeType,byteSize:m.primaryRecording.byteSize,
              durationMs:m.primaryRecording.durationMs,localState:m.primaryRecording.localState}:null,
            transcriptStatus:t?.revision.status??null,final:t?.segments.every(s=>s.isFinal)??false};
          if(t?.revision.status==='ready'&&t.segments.length&&t.segments.every(s=>s.isFinal)){
            const q=${runtimeModuleExpression('src/services/meetingQuestions.ts')};
            return q.loadQuestionEvidence({scopeKey:'guest',navigationMeetingId:m.id,includeManualNote:false})
              .then(evidence=>{${slot}={done:true,state,evidence};});
          }
          ${slot}={done:true,state,evidence:null};
          });
        }).catch(e=>{${slot}={done:true,error:String(e)};});})();undefined`);
      if (dispatched.result?.exceptionDetails) throw Error('Observation dispatch failed: ' +
        (dispatched.result.exceptionDetails.exception?.description || dispatched.result.exceptionDetails.text));
      let value;
      for (let i = 0; i < 100; i++) {
        await new Promise(resolve => setTimeout(resolve, 50));
        const reply = await cdp.evaluate(`JSON.stringify(${slot})`);
        value = JSON.parse(reply.result?.result?.value ?? '{}');
        if (value.done) break;
      }
      if (!value?.done) throw Error('Observation read timed out; import may still be running');
      if (value.error) throw Error(value.error);
      const encoded = JSON.stringify(value.state);
      if (encoded !== last || Date.now() - pulse > 30000) {
        const row = {observedAtMs:Date.now(), observationElapsedMs:Date.now()-began, ...value.state};
        fs.writeSync(descriptor, JSON.stringify(row) + '\n');
        console.log(JSON.stringify(row));last=encoded;pulse=Date.now();
      }
      if (value.evidence) {
        fs.writeFileSync(evidencePath, JSON.stringify(value.evidence, null, 2), {mode:0o600,flag:'wx'});
        console.log(JSON.stringify({completed:true,segments:value.evidence.transcript.length}));return;
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    throw Error('Observation window expired; durable import remains untouched');
  } finally {
    if (cdp?.isOpen()) await cdp.evaluate(`delete ${slot}`).catch(()=>{});
    cdp?.close();if(descriptor!==undefined)fs.closeSync(descriptor);release();
  }
})().catch(error => {console.error(error.message);process.exitCode=1;});
