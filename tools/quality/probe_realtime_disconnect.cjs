// Emulator-owned real identity/binding -> isolated or public realtime -> real
// ASR, with explicit socket loss. No native capture/UI acceptance claim.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const WS = require('ws');
const { openCdp } = require('../hardware/runtime_cdp.cjs');
const { runtimeModuleExpression, selectRuntimeTarget } = require('../hardware/runtime_module.cjs');
const { acquireInspectionLock } = require('../hardware/inspection_lock.cjs');
const [meeting, origin, pcmPath, output] = process.argv.slice(2);
if (!meeting || !/^wss?:\/\//.test(origin) || !pcmPath || !output) throw Error('meeting origin pcm output required');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

(async () => {
  const release = await acquireInspectionLock();
  const key = '__realtimeRecovery_' + randomUUID();
  let cdp, socket, credentials;
  const sessionId = randomUUID(), nonce = randomUUID();
  const events = new Map(), observations = [];
  let cursor = 0, fault;
  try {
    const targets = await (await fetch('http://127.0.0.1:8083/json/list')).json();
    cdp = await openCdp(WebSocket, selectRuntimeTarget(targets).webSocketDebuggerUrl);
    const expr = `(()=>{const r=${runtimeModuleExpression('src/services/deviceV2Realtime.ts')};
      const a=${runtimeModuleExpression('src/services/deviceV2Api.ts')};
      globalThis[${JSON.stringify(key)}]={done:false};
      return r.prepareDeviceV2RealtimeRecording({meetingId:${JSON.stringify(meeting)},sessionId:${JSON.stringify(sessionId)},
        taskId:${JSON.stringify('probe-transcript-' + nonce)},clientOperationId:${JSON.stringify('probe-operation-' + nonce)},
        assetId:${JSON.stringify('probe-asset-' + nonce)},assetGeneration:${JSON.stringify(nonce.replaceAll('-', ''))}})
      .then(options=>a.ensureDeviceV2Session().then(auth=>{globalThis[${JSON.stringify(key)}]={done:true,options,auth}}),
      e=>{globalThis[${JSON.stringify(key)}]={done:true,error:String(e)}});})();undefined`;
    await cdp.evaluate(expr);
    for (let i = 0; i < 150; i++) {
      const r = await cdp.evaluate(`JSON.stringify(globalThis[${JSON.stringify(key)}])`);
      const value = JSON.parse(r.result?.result?.value || '{}');
      if (value.done) { if (value.error) throw Error(value.error); credentials = value; break; }
      await delay(200);
    }
    assert(credentials, 'emulator credential preparation timed out');
    const { options: o, auth } = credentials;
    const opened = { schema_version: 2, type: 'session.open', task_id: o.taskId,
      client_operation_id: o.clientOperationId, binding_id: o.bindingId, binding_generation: o.bindingGeneration,
      binding_revision: o.bindingRevision, cancel_revision: o.cancelRevision, asset_id: o.assetId,
      asset_generation: o.assetGeneration, codec_revision: 'pcm16-16000-mono-v1', expires_at_epoch: o.expiresAtEpoch };
    let inbox;
    async function waitFor(predicate, ms = 45000) {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        if (fault) throw Error(fault);
        const index = inbox.findIndex(predicate);
        if (index >= 0) return inbox.splice(index, 1)[0];
        await delay(25);
      }
      throw Error('realtime message timeout');
    }
    async function connect() {
      inbox = []; fault = null;
      socket = new WS(origin + '/api/device/v2/realtime/' + sessionId, {
        headers: { Authorization: 'Bearer ' + auth.token, 'X-Laoji-Device-Id': auth.deviceId,
          'X-Laoji-Epoch-Id': auth.epochId }, handshakeTimeout: 10000,
      });
      socket.on('error', error => { fault = error.code || error.name; });
      socket.on('message', bytes => {
        const m = JSON.parse(bytes.toString());
        if (m.type === 'error') { fault = m.code; return; }
        if (m.contract_revision === 'transcript.stream.v2') {
          const previous = events.get(m.event_sequence);
          if (previous && previous !== hash(bytes)) { fault = 'event replay changed'; return; }
          events.set(m.event_sequence, hash(bytes)); cursor = Math.max(cursor, m.event_sequence);
        }
        inbox.push(m);
      });
      await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      socket.send(JSON.stringify({ ...opened, after_event_seq: cursor }));
      return waitFor(m => m.type === 'session.ready');
    }
    const pcm = fs.readFileSync(pcmPath);
    assert(pcm.length >= 192000 && pcm.length % 32000 === 0);
    async function chunk(sequence) {
      const audio = pcm.subarray(sequence * 32000, (sequence + 1) * 32000);
      const header = Buffer.from(JSON.stringify({ schema_version: 2, contract_revision: 'realtime.chunk.v2',
        type: 'audio.chunk', chunk_seq: sequence, start_ms: sequence * 1000,
        end_ms: (sequence + 1) * 1000, content_sha256: hash(audio) }));
      const prefix = Buffer.alloc(7); prefix.write('LJPC'); prefix[4] = 2; prefix.writeUInt16BE(header.length, 5);
      socket.send(Buffer.concat([prefix, header, audio]));
      await waitFor(m => m.type === 'audio.ack' && m.chunk_seq === sequence);
    }
    for (let i = 0; i < 4; i++) {
      const ready = await connect();
      assert.equal(ready.last_contiguous_chunk_seq, i - 1);
      await chunk(i);
      socket.terminate(); socket = null;
      await delay(350);
      observations.push({ connection: i + 1, acknowledged_chunk: i });
    }
    const ready = await connect();
    assert.equal(ready.last_contiguous_chunk_seq, 3);
    for (let i = 4; i < pcm.length / 32000; i++) await chunk(i);
    const began = Date.now();
    socket.send(JSON.stringify({ schema_version: 2, type: 'session.finalize' }));
    let textEvents = 0, finals = 0;
    while (true) {
      const m = await waitFor(m => m.contract_revision === 'transcript.stream.v2' || m.type === 'session.complete');
      if (m.type === 'session.complete') break;
      if (m.event_kind === 'stable' && m.text?.trim()) textEvents++;
      if (m.event_kind === 'final') finals++;
    }
    assert(textEvents > 0 && finals === 1);
    socket.send(JSON.stringify({ schema_version: 2, type: 'events.ack', through_event_seq: cursor }));
    await waitFor(m => m.type === 'events.acked');
    const report = { boundary: 'real emulator credentials; transport/ASR/durable cursors only, not capture/UI or speech quality',
      session_id: sessionId, task_id: o.taskId, disconnects: 4, connections: 5, observations,
      pcm_sha256: hash(pcm), pcm_bytes: pcm.length, text_events: textEvents, final_events: finals,
      highest_event: cursor, finalize_ms: Date.now() - began, result: 'pass' };
    fs.writeFileSync(output, JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ result: 'pass', disconnects: 4, text_events: textEvents, final_events: finals }));
  } finally {
    socket?.terminate();
    if (cdp?.isOpen()) await cdp.evaluate(`delete globalThis[${JSON.stringify(key)}]`).catch(() => {});
    credentials = null; cdp?.close(); release();
  }
})().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
