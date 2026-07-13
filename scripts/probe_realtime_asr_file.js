#!/usr/bin/env node

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const WebSocket = require('ws');

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function argumentsFor(name) {
  const values = [];
  process.argv.forEach((value, index) => {
    if (value === `--${name}` && process.argv[index + 1]) values.push(process.argv[index + 1]);
  });
  return values;
}

function decodePcm(file) {
  const result = spawnSync('ffmpeg', [
    '-v', 'error', '-i', file, '-f', 's16le', '-ac', '1', '-ar', '16000', 'pipe:1',
  ], { encoding: null, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`ffmpeg decode failed for ${file}: ${String(result.stderr || '')}`);
  }
  return result.stdout;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function describeError(error) {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  const causeParts = cause && typeof cause === 'object'
    ? [cause.code, cause.message].filter(Boolean)
    : [];
  return [error.message, ...causeParts].filter(Boolean).join(': ');
}

function reexecWithoutEnvironmentProxy() {
  if (process.env.NODE_USE_ENV_PROXY !== '1') return null;
  if (process.argv.includes('--respect-environment-proxy')) return null;
  if (process.env.LAOJI_DIRECT_FETCH_REEXEC === '1') {
    throw new Error('NODE_USE_ENV_PROXY remained enabled after direct-fetch re-exec');
  }
  const result = spawnSync(process.execPath, process.argv.slice(1), {
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_USE_ENV_PROXY: '0',
      LAOJI_DIRECT_FETCH_REEXEC: '1',
    },
  });
  return result.status ?? 1;
}

async function fetchDetailed(label, url, options) {
  try {
    return await fetch(url, options);
  } catch (error) {
    throw new Error(`${label} failed: ${describeError(error)}`, { cause: error });
  }
}

async function revokeGuestSession(baseUrl, session, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchDetailed(
        'guest session cleanup',
        `${baseUrl}/api/laoji/meetings/guest-sessions/${encodeURIComponent(session.meeting_id)}`,
        {
          method: 'DELETE',
          headers: { 'X-Guest-Session-Token': session.guest_token },
        },
      );
      if (response.status === 204 || response.status === 404) return 204;
      if (response.status < 500 || attempt === attempts) return response.status;
      lastError = new Error(`guest session cleanup returned ${response.status}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt === attempts) break;
    }
    await delay(attempt * 100);
  }
  throw lastError ?? new Error('guest session cleanup failed');
}

async function sendPcm(ws, pcm, frameBytes, frameMs) {
  for (let offset = 0; offset < pcm.length; offset += frameBytes) {
    const frame = pcm.subarray(offset, Math.min(offset + frameBytes, pcm.length));
    ws.send(frame.length === frameBytes ? frame : Buffer.concat([frame, Buffer.alloc(frameBytes - frame.length)]));
    await delay(frameMs);
  }
}

async function runProbe({
  baseUrl,
  route,
  files,
  gapMs = 1400,
  leadingSilenceMs = 300,
  trailingSilenceMs = 2000,
  timeoutMs = 120000,
  title = `Realtime ASR ${route} file probe`,
  respectEnvironmentProxy = false,
}) {
  if (!respectEnvironmentProxy && process.env.NODE_USE_ENV_PROXY === '1') {
    throw new Error('refusing implicit environment proxy; start with NODE_USE_ENV_PROXY=0');
  }
  const normalizedBaseUrl = baseUrl.replace(/\/$/, '');
  if (!['schedule', 'meeting'].includes(route)) throw new Error('route must be schedule or meeting');
  if (files.length === 0) throw new Error('provide at least one file');
  files.forEach(file => {
    if (!fs.existsSync(file)) throw new Error(`missing audio file: ${file}`);
  });

  const pcmFiles = files.map(file => decodePcm(file));
  const frameBytes = 3200;
  const frameMs = 100;
  const audioDurationMs = Math.round(
    pcmFiles.reduce((total, pcm) => total + pcm.length, 0) / (16000 * 2) * 1000,
  );
  const startedAt = performance.now();
  const createdResponse = await fetchDetailed('guest session creation', `${normalizedBaseUrl}/api/laoji/meetings/guest-sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (!createdResponse.ok) throw new Error(`session creation failed: ${createdResponse.status}`);
  const session = await createdResponse.json();
  const sessionCreatedAt = performance.now();
  const wsBase = normalizedBaseUrl.replace(/^http/, 'ws');
  const routePath = route === 'schedule'
    ? `/ws/laoji/schedule/${encodeURIComponent(session.meeting_id)}/funasr`
    : `/ws/meeting/${encodeURIComponent(session.meeting_id)}/funasr`;
  const transcripts = [];
  const timing = {
    session_created_ms: Math.round(sessionCreatedAt - startedAt),
    websocket_open_ms: null,
    config_received_ms: null,
    audio_started_ms: null,
    speech_ended_ms: null,
    stop_signal_ms: null,
    first_completed_ms: null,
    last_completed_ms: null,
    ready_to_stop_ms: null,
    total_ms: null,
  };
  let cleanupStatus = null;

  try {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${wsBase}${routePath}`, {
        headers: { 'X-Guest-Session-Token': session.guest_token },
      });
      let settled = false;
      let senderStarted = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) {
          ws.terminate();
          reject(error);
        }
        else resolve();
      };
      const timeout = setTimeout(() => {
        ws.terminate();
        finish(new Error(`realtime probe timed out after ${timeoutMs} ms`));
      }, timeoutMs);

      ws.on('open', () => {
        timing.websocket_open_ms = Math.round(performance.now() - startedAt);
      });
      ws.on('message', raw => {
        let message;
        try {
          message = JSON.parse(String(raw));
        } catch (error) {
          finish(new Error(`invalid websocket JSON: ${error instanceof Error ? error.message : String(error)}`));
          return;
        }
        const receivedMs = Math.round(performance.now() - startedAt);
        if (message.type === 'transcript.completed') {
          if (timing.first_completed_ms === null) timing.first_completed_ms = receivedMs;
          timing.last_completed_ms = receivedMs;
          transcripts.push({
            text: message.text,
            start_time: message.start_time,
            end_time: message.end_time,
            purpose: message.purpose,
            received_ms: receivedMs,
          });
        }
        if (message.type === 'config' && !senderStarted) {
          senderStarted = true;
          timing.config_received_ms = receivedMs;
          void (async () => {
            timing.audio_started_ms = Math.round(performance.now() - startedAt);
            await sendPcm(
              ws,
              Buffer.alloc(Math.round(leadingSilenceMs / frameMs) * frameBytes),
              frameBytes,
              frameMs,
            );
            for (let index = 0; index < pcmFiles.length; index += 1) {
              await sendPcm(ws, pcmFiles[index], frameBytes, frameMs);
              if (index + 1 < pcmFiles.length) {
                await sendPcm(
                  ws,
                  Buffer.alloc(Math.round(gapMs / frameMs) * frameBytes),
                  frameBytes,
                  frameMs,
                );
              }
            }
            timing.speech_ended_ms = Math.round(performance.now() - startedAt);
            await sendPcm(
              ws,
              Buffer.alloc(Math.round(trailingSilenceMs / frameMs) * frameBytes),
              frameBytes,
              frameMs,
            );
            ws.send(Buffer.alloc(0));
            timing.stop_signal_ms = Math.round(performance.now() - startedAt);
          })().catch(error => finish(error instanceof Error ? error : new Error(String(error))));
        }
        if (message.type === 'ready_to_stop') {
          timing.ready_to_stop_ms = receivedMs;
          ws.close();
          finish();
        }
      });
      ws.on('error', error => finish(error));
      ws.on('close', () => {
        if (!settled) finish(new Error('websocket closed before ready_to_stop'));
      });
    });
  } finally {
    cleanupStatus = await revokeGuestSession(normalizedBaseUrl, session);
  }

  timing.total_ms = Math.round(performance.now() - startedAt);
  return {
    route,
    files,
    gap_ms: gapMs,
    leading_silence_ms: leadingSilenceMs,
    trailing_silence_ms: trailingSilenceMs,
    audio_duration_ms: audioDurationMs,
    cleanup_status: cleanupStatus,
    timing: {
      ...timing,
      first_completed_after_audio_start_ms:
        timing.first_completed_ms === null || timing.audio_started_ms === null
          ? null
          : timing.first_completed_ms - timing.audio_started_ms,
      first_completed_after_speech_end_ms:
        timing.first_completed_ms === null || timing.speech_ended_ms === null
          ? null
          : timing.first_completed_ms - timing.speech_ended_ms,
      ready_after_stop_signal_ms:
        timing.ready_to_stop_ms === null || timing.stop_signal_ms === null
          ? null
          : timing.ready_to_stop_ms - timing.stop_signal_ms,
    },
    transcripts,
  };
}

async function main() {
  const baseUrl = argument('base-url', 'http://127.0.0.1:18020').replace(/\/$/, '');
  const route = argument('route', 'schedule');
  const files = argumentsFor('file').map(value => path.resolve(value));
  const gapMs = Number(argument('gap-ms', '1400'));
  const output = argument('output', '');
  const report = await runProbe({ baseUrl, route, files, gapMs });
  if (output) fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
}

module.exports = { decodePcm, describeError, reexecWithoutEnvironmentProxy, revokeGuestSession, runProbe };

if (require.main === module) {
  const reexecStatus = reexecWithoutEnvironmentProxy();
  if (reexecStatus !== null) {
    process.exit(reexecStatus);
  } else {
    main().catch(error => {
      console.error(describeError(error));
      process.exit(1);
    });
  }
}
