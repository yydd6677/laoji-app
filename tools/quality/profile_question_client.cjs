// Real emulator bearer stays in memory. No app question, binding or data is changed.
// Default target is an SSH-forwarded isolated database. A public baseline
// requires the exact explicit final argument and uses new diagnostic tasks.
const fs = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const { openCdp } = require('../hardware/runtime_cdp.cjs');
const { runtimeModuleExpression, selectRuntimeTarget } = require('../hardware/runtime_module.cjs');
const { acquireInspectionLock } = require('../hardware/inspection_lock.cjs');
const [bindingId, evidencePath, outputPath, countArg = '3', question = '最后多少钱一个？', publicBaseline, gzip] = process.argv.slice(2);
if (!bindingId || !evidencePath || !outputPath) throw Error('binding evidence output required');
const count = Number(countArg);
if (!Number.isInteger(count) || count < 1 || count > 5) throw Error('profile_count_must_be_1_to_5');
if (publicBaseline && !['--public-baseline','--isolated'].includes(publicBaseline)) throw Error('unknown_target');
if (gzip && gzip !== '--gzip') throw Error('unknown_encoding');
const publicTarget = publicBaseline === '--public-baseline';
const origin = publicTarget ? 'https://laoji.cloud' : 'http://127.0.0.1:18023';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
}
(async () => {
  const release = await acquireInspectionLock();
  let cdp;
  const key = '__q2ProfileAuth_' + randomUUID();
  try {
    const targets = await (await fetch('http://127.0.0.1:8083/json/list')).json();
    cdp = await openCdp(WebSocket, selectRuntimeTarget(targets).webSocketDebuggerUrl);
    await cdp.evaluate(`(()=>{globalThis[${JSON.stringify(key)}]={done:false};
      const a=${runtimeModuleExpression('src/services/deviceV2Api.ts')};
      a.ensureDeviceV2Session().then(auth=>{globalThis[${JSON.stringify(key)}]={done:true,auth}},
        e=>{globalThis[${JSON.stringify(key)}]={done:true,error:String(e.name)}});})();undefined`);
    let auth;
    for (let i = 0; i < 100; i++) {
      const reply = await cdp.evaluate(`JSON.stringify(globalThis[${JSON.stringify(key)}])`);
      const value = JSON.parse(reply.result?.result?.value || '{}');
      if (value.done) { if (value.error) throw Error(value.error); auth = value.auth; break; }
      await delay(200);
    }
    if (!auth) throw Error('emulator_auth_unavailable');
    await cdp.evaluate(`delete globalThis[${JSON.stringify(key)}]`);
    console.log('emulator_auth_ready_without_export');
    let ready = false;
    for (let i = 0; i < 180; i++) {
      try { const value = await (await fetch(origin + (publicTarget ? '/api/ready' : '/profile-ready'))).json();
        if (publicTarget ? value.ready === true && value.task_worker.queue_depth === 0
          && value.task_worker.active_leases === 0 && value.asr.queue_depth === 0
          && value.llm.queue.depth === 0 && value.llm.queue.active === null : value.isolated === true) {
          ready = true; break;
        } } catch {}
      await delay(1000);
    }
    if (!ready) throw Error('isolated_endpoint_unavailable');
    const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + auth.token,
      'X-Laoji-Device-Id': auth.deviceId, 'X-Laoji-Epoch-Id': auth.epochId };
    const bindingResponse = await fetch(origin + '/api/device/v2/meetings/' + bindingId, { headers });
    if (!bindingResponse.ok) throw Error('isolated_binding_status_' + bindingResponse.status);
    const binding = (await bindingResponse.json()).binding;
    const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    const sources = evidence.transcript.map(row => ({ source_type: 'transcript', source_id: row.segmentId,
      source_revision_id: evidence.transcriptRevisionId, content_sha256: hash(row.text), text: row.text }));
    if (evidence.manualNote) sources.push({ source_type: 'manual_note', source_id: 'manual-note',
      source_revision_id: String(evidence.manualNoteRevision), content_sha256: hash(evidence.manualNote), text: evidence.manualNote });
    const sourceFingerprint = hash(stable({ schema_version: 2, sources: sources.map(({text, ...metadata}) => metadata) }));
    const results = [];
    for (let i = 0; i < count; i++) {
      const seed = createHash('sha256').update(randomUUID()).digest('hex');
      const payload = { schema_version: 2, contract_revision: 'question.reader.v2', provider_revision: 'q2-reader-v2',
        snapshot_id: 'profile-' + seed, question, source_fingerprint: sourceFingerprint,
        binding_generation: binding.binding_generation, binding_revision: binding.binding_revision,
        cancel_revision: binding.cancel_revision, source_entity_id: evidence.meetingId || 'profile-meeting',
        task_id: 'q2-task:' + seed, source_stream_id: 'q2-source-stream:' + seed, prepare_sources: true, sources };
      const start = Date.now();
      if (gzip) {
        const raw = Buffer.from(JSON.stringify(sources));
        delete payload.sources;
        payload.compressed_sources = { encoding: 'gzip-base64', uncompressed_bytes: raw.length,
          data: require('node:zlib').gzipSync(raw, {level:1,mtime:0}).toString('base64') };
      }
      const body = JSON.stringify(payload);
      const response = await fetch(origin + '/api/device/v2/meetings/' + bindingId + '/questions-v2', {
        method: 'POST', headers, body, signal: AbortSignal.timeout(180000) });
      const result = await response.json();
      results.push({ ordinal: i, status: response.status, wall_ms: Date.now() - start,
        boundary: publicTarget ? 'public real auth and task, not app UI' : 'isolated real auth and task',
        request_bytes: Buffer.byteLength(body), result });
      fs.writeFileSync(outputPath, JSON.stringify(results, null, 2), {mode: 0o600});
      console.log(JSON.stringify({ ordinal: i, status: response.status, wall_ms: results.at(-1).wall_ms,
        answer_kind: result.answer_kind, clauses: result.clauses?.length }));
      if (!response.ok) throw Error('isolated_request_failed_' + response.status);
    }
  } finally {
    if (cdp?.isOpen()) await cdp.evaluate(`delete globalThis[${JSON.stringify(key)}]`).catch(()=>{});
    cdp?.close(); release();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
