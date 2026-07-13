#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const WebSocket = require('ws');

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function createSession(baseUrl, index) {
  const response = await fetch(`${baseUrl}/api/laoji/meetings/guest-sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: `Realtime ASR idle probe ${index}` }),
  });
  if (!response.ok) throw new Error(`session ${index} creation failed: ${response.status}`);
  return response.json();
}

function openConnection(wsBase, session, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `${wsBase}/ws/laoji/schedule/${encodeURIComponent(session.meeting_id)}/funasr`,
      { headers: { 'X-Guest-Session-Token': session.guest_token } },
    );
    let settled = false;
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error(`websocket config timeout for ${session.meeting_id}`));
    }, timeoutMs);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve({ ws, session });
    };
    ws.on('message', raw => {
      try {
        const message = JSON.parse(String(raw));
        if (message.type === 'config') finish();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    ws.on('error', finish);
    ws.on('close', () => finish(new Error(`websocket closed before config for ${session.meeting_id}`)));
  });
}

function stopConnection(connection, timeoutMs) {
  return new Promise((resolve, reject) => {
    const { ws, session } = connection;
    let settled = false;
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error(`ready_to_stop timeout for ${session.meeting_id}`));
    }, timeoutMs);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    ws.on('message', raw => {
      try {
        const message = JSON.parse(String(raw));
        if (message.type === 'ready_to_stop') {
          ws.close();
          finish();
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    ws.on('error', finish);
    ws.send(Buffer.alloc(0));
  });
}

async function cleanupSession(baseUrl, session) {
  const response = await fetch(
    `${baseUrl}/api/laoji/meetings/guest-sessions/${encodeURIComponent(session.meeting_id)}`,
    {
      method: 'DELETE',
      headers: { 'X-Guest-Session-Token': session.guest_token },
    },
  );
  return response.status;
}

async function main() {
  const baseUrl = argument('base-url', 'http://127.0.0.1:18020').replace(/\/$/, '');
  const concurrency = Number(argument('concurrency', '32'));
  const holdMs = Number(argument('hold-ms', '5000'));
  const timeoutMs = Number(argument('timeout-ms', '30000'));
  const output = argument('output', '');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) {
    throw new Error('--concurrency must be an integer from 1 to 64');
  }
  if (!Number.isFinite(holdMs) || holdMs < 0 || holdMs > 60000) {
    throw new Error('--hold-ms must be between 0 and 60000');
  }
  const wsBase = baseUrl.replace(/^http/, 'ws');
  const startedAt = performance.now();
  const sessions = [];
  const connections = [];
  const cleanupStatuses = [];
  let openedAt = null;
  let stoppedAt = null;

  try {
    sessions.push(...await Promise.all(
      Array.from({ length: concurrency }, (_, index) => createSession(baseUrl, index + 1)),
    ));
    await Promise.all(sessions.map(async session => {
      const connection = await openConnection(wsBase, session, timeoutMs);
      connections.push(connection);
    }));
    openedAt = performance.now();
    await new Promise(resolve => setTimeout(resolve, holdMs));
    await Promise.all(connections.map(connection => stopConnection(connection, timeoutMs)));
    stoppedAt = performance.now();
  } finally {
    await Promise.all(connections.map(async connection => {
      if (connection.ws.readyState === WebSocket.OPEN) connection.ws.terminate();
    }));
    cleanupStatuses.push(...await Promise.all(
      sessions.map(session => cleanupSession(baseUrl, session)),
    ));
  }

  const report = {
    generated_at: new Date().toISOString(),
    endpoint: baseUrl,
    route: 'schedule',
    concurrency,
    hold_ms: holdMs,
    sessions_created: sessions.length,
    websocket_configs_received: connections.length,
    ready_to_stop_received: connections.length,
    cleanup_statuses: cleanupStatuses,
    timing: {
      open_all_ms: openedAt === null ? null : Math.round(openedAt - startedAt),
      hold_actual_ms: openedAt === null || stoppedAt === null ? null : Math.round(stoppedAt - openedAt),
      total_ms: Math.round(performance.now() - startedAt),
    },
    passed:
      sessions.length === concurrency
      && connections.length === concurrency
      && cleanupStatuses.length === concurrency
      && cleanupStatuses.every(status => status === 204),
  };
  if (output) {
    const outputPath = path.resolve(output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.passed ? 0 : 1;
}

if (require.main === module) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
}
