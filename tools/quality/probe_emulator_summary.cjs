// Real Android source -> service Task -> validated local projection probe.
// Does not activate a summary version or replace the meeting's current result.
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { openCdp } = require('../hardware/runtime_cdp.cjs');
const { runtimeModuleExpression, selectRuntimeTarget } = require('../hardware/runtime_module.cjs');
const { acquireInspectionLock } = require('../hardware/inspection_lock.cjs');

const [meetingId, output] = process.argv.slice(2);
if (!meetingId || !output) throw Error('meeting ID and private output file required');
(async () => {
  const release = await acquireInspectionLock();
  let cdp;
  const inbox = `globalThis[${JSON.stringify('__summaryTrace_' + randomUUID())}]`;
  try {
    const targets = await (await fetch('http://127.0.0.1:8083/json/list')).json();
    cdp = await openCdp(WebSocket, selectRuntimeTarget(targets).webSocketDebuggerUrl);
    const begin = await cdp.evaluate(`(()=>{
      const q=${runtimeModuleExpression('src/services/meetingQuestions.ts')};
      const api=${runtimeModuleExpression('src/services/deviceV2Api.ts')};
      const summary=${runtimeModuleExpression('src/services/meetingSummary.ts')};
      const progress=[];let taskId=null,capabilities,start=Date.now();
      ${inbox}={done:false};
      api.loadDeviceV2Capabilities({forceRefresh:true}).then(c=>{
        capabilities={handler:c.summaryHandlerRevision,prompt:c.summaryPromptRevision,model:c.summaryModelRevision};
        return q.loadQuestionEvidence({scopeKey:'guest',navigationMeetingId:${JSON.stringify(meetingId)},includeManualNote:true});
      }).then(e=>summary.generateSummaryForMeeting({
        meetingId:e.meetingId,transcriptLines:e.transcript.map(t=>({id:t.segmentId,text:t.text,
          start_time:t.startMs/1000,end_time:t.endMs/1000,speaker_label:t.speaker})),
        manualNote:{content:e.manualNote||'',revision:e.manualNoteRevision||0},
        forceRegenerate:true,onTaskPrepared:id=>{taskId=id;},
        onProgress:p=>progress.push({stage:p.stage,at_ms:Date.now()-start}),
      })).then(result=>{${inbox}={done:true,wall_ms:Date.now()-start,capabilities,taskId,progress,result};},
        error=>{${inbox}={done:true,wall_ms:Date.now()-start,capabilities,taskId,progress,error:String(error)};});
    })();undefined`);
    if (begin.result?.exceptionDetails || begin.error) throw Error(JSON.stringify(begin));
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const reply = await cdp.evaluate(`JSON.stringify(${inbox})`);
      const value = JSON.parse(reply.result?.result?.value ?? '{}');
      if (!value.done) continue;
      fs.writeFileSync(output, JSON.stringify(value, null, 2));
      console.log(JSON.stringify({wall_ms:value.wall_ms,capabilities:value.capabilities,
        progress:value.progress,facts:value.result?.facts_document_v3?.factsDocument?.facts?.length,
        sections:value.result?.structured_document?.sections?.length,error:value.error}));
      if (value.error) process.exitCode = 1;
      return;
    }
    throw Error('Summary probe timeout; durable work may still be active');
  } finally {
    if (cdp?.isOpen()) await cdp.evaluate(`if(${inbox}?.done)delete ${inbox}`).catch(()=>{});
    cdp?.close();release();
  }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
