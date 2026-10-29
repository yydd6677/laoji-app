const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

function client(authError, capabilityResponses = [], transportBase) {
  const calls = [];
  const storage = new Map();
  const clock = { now: Date.now() };
  class RuntimeDate extends Date { static now() { return clock.now; } }
  const http = { exports: {} };
  new Function('module', 'exports', ts.transpileModule(fs.readFileSync(path.resolve(__dirname,
    '../../src/services/http.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText)(http, http.exports);
  let sequence = 0;
  const compiled = ts.transpileModule(fs.readFileSync(path.resolve(__dirname,
    '../../src/services/deviceV2Api.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const dependencies = {
    'expo-crypto': { randomUUID: () => `request-${++sequence}`,
      CryptoDigestAlgorithm: { SHA256: 'sha256' }, digest: async () => new Uint8Array(32) },
    'expo-secure-store': { getItemAsync: async k => storage.get(k) ?? null,
      setItemAsync: async (k, v) => { storage.set(k, v); } },
    './config': { getApiConfig: () => ({ apiBase: transportBase ?? 'https://example.invalid' }) },
    './deviceIdentity': { getDeviceIdentityRevision: () => 0,
      getOrCreateDeviceIdentity: async () => ({ deviceId: 'device', epochId: 'epoch' }) },
    './diagnostics': { diagnosticAudit() {} },
    'laoji-native-platform': {
      getOrCreateDeviceKey: async () => ({ keyVersion: 1, publicKeyDer: 'AQID' }),
      signWithDeviceKey: () => 'signature', findDeviceProofOfWork: async () => 0,
      preparePurgeCapability: async () => ({ capabilityId: 'purge', secretSha256: 'hash',
        registrationRequestId: 'purge-request' }), markPurgeCapabilityArmed() {},
    },
    './http': {
      RequestTimeoutError: http.exports.RequestTimeoutError,
      readJsonWithTimeout: async r => r instanceof Response ? http.exports.readJsonWithTimeout(r) : r.body,
      fetchWithTimeout: async (url, init) => {
        const route = new URL(url).pathname.replace('/api/device/v2', '');
        calls.push(route);
        if (route === '/capabilities') {
          if (transportBase) return http.exports.fetchWithTimeout(url, init);
          const response = capabilityResponses.shift() ?? { status: 200, body: {
            schema_version: 2, device_api: true, schedule_graph_v2: true,
          } };
          if (response instanceof Error) throw response;
          return { ok: response.status === 200, ...response };
        }
        if (route === '/auth/challenges' && authError && calls.length === 1) {
          return { ok: false, status: 401, body: { detail: { code: authError, message: '认证失败' } } };
        }
        if (route.endsWith('/challenges')) return { ok: true, status: 200,
          body: { challenge_id: 'challenge', nonce: 'nonce', key_version: 1, proof_difficulty_bits: 0 } };
        return { ok: true, status: 200, body: { access_token: 'token',
          expires_at: Date.now() + 3_600_000, key_version: 1 } };
      },
    },
  };
  new Function('require', 'module', 'exports', 'Date', compiled)(name => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
    return dependencies[name];
  }, module, module.exports, RuntimeDate);
  return { api: module.exports, calls, http: http.exports, capabilityResponses, clock };
}

test('a missing bearer uses the existing device key without consuming registration quota', async () => {
  const { api, calls } = client();
  const [a, b] = await Promise.all([api.ensureDeviceV2Session(), api.ensureDeviceV2Session()]);
  assert.equal(a.token, 'token');
  assert.equal(a, b);
  assert.deepEqual(calls, ['/auth/challenges', '/auth/tokens']);
  await api.ensureDeviceV2Session();
  assert.equal(calls.length, 2);
});

test('only an explicitly missing registration enters bootstrap', async () => {
  const { api, calls } = client('DEVICE_NOT_REGISTERED');
  assert.equal((await api.ensureDeviceV2Session()).token, 'token');
  assert.deepEqual(calls, ['/auth/challenges', '/bootstrap/challenges', '/bootstrap/complete',
    '/auth/challenges', '/auth/tokens']);
});

test('a different authentication failure never resets identity or re-registers', async () => {
  const { api, calls } = client('DEVICE_KEY_MISMATCH');
  await assert.rejects(api.ensureDeviceV2Session(), { code: 'DEVICE_KEY_MISMATCH' });
  assert.deepEqual(calls, ['/auth/challenges']);
});

test('capability GET has a short deadline without changing inference deadlines', () => {
  const { http } = client();
  assert.equal(http.requestTimeoutMs('https://example.invalid/api/device/v2/capabilities'), 5000);
  assert.equal(http.requestTimeoutMs('https://example.invalid/api/device/v2/capabilities?revision=1'), 5000);
  assert.equal(http.requestTimeoutMs('https://example.invalid/api/device/v2/schedule/graph'), 20000);
});

test('one stalled capability GET recovers silently and concurrent refreshes share the retry', async () => {
  const p = client();
  p.capabilityResponses.push(new p.http.RequestTimeoutError(5000));
  const [a, b] = await Promise.all([
    p.api.loadDeviceV2Capabilities(), p.api.loadDeviceV2Capabilities({ forceRefresh: true }),
  ]);
  assert.equal(a.scheduleGraphV2, true);
  assert.strictEqual(a, b);
  assert.equal(p.calls.filter(route => route === '/capabilities').length, 2);
  await p.api.loadDeviceV2Capabilities();
  assert.equal(p.calls.filter(route => route === '/capabilities').length, 2);
});

test('a network fetch failure and a temporary gateway failure each get only one retry', async () => {
  for (const error of [new TypeError('Network request failed'),
    { status: 503, body: { detail: { code: 'TEMPORARILY_UNAVAILABLE' } } }]) {
    const p = client(undefined, [error]);
    assert.equal((await p.api.loadDeviceV2Capabilities()).scheduleGraphV2, true);
    assert.equal(p.calls.filter(route => route === '/capabilities').length, 2);
  }
});

test('persistent failure releases single-flight but never reuses a stale affirmative snapshot', async () => {
  const p = client();
  await p.api.loadDeviceV2Capabilities();
  p.clock.now += 60_001;
  p.capabilityResponses.push(new p.http.RequestTimeoutError(5000), new p.http.RequestTimeoutError(5000));
  await assert.rejects(p.api.loadDeviceV2Capabilities(), p.http.RequestTimeoutError);
  assert.equal(p.calls.filter(route => route === '/capabilities').length, 3);
  p.capabilityResponses.push({ status: 200, body: { schema_version: 2, device_api: true, schedule_graph_v2: false } });
  assert.equal((await p.api.loadDeviceV2Capabilities({ forceRefresh: true })).scheduleGraphV2, false);
  assert.equal((await p.api.loadDeviceV2Capabilities()).scheduleGraphV2, false);
});

test('denial, cancellation and malformed capability contracts are not retried or guessed', async () => {
  for (const response of [
    { status: 403, body: { detail: { code: 'FORBIDDEN' } } },
    { status: 200, body: { schema_version: 1, device_api: true } },
    Object.assign(new Error('cancelled'), { name: 'AbortError' }),
  ]) {
    const p = client(undefined, [response]);
    await assert.rejects(p.api.loadDeviceV2Capabilities());
    assert.equal(p.calls.filter(route => route === '/capabilities').length, 1);
  }
});

test('real HTTP stalled headers are aborted before a successful capability retry', async t => {
  const { createServer } = require('node:http');
  const { once } = require('node:events');
  let requests = 0;
  const server = createServer((request, response) => {
    assert.equal(request.url, '/api/device/v2/capabilities');
    assert.equal(request.headers.authorization, 'Bearer token');
    if (++requests === 1) return; // Real open socket, not a mocked timeout exception.
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ schema_version: 2, device_api: true, schedule_graph_v2: true }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const p = client(undefined, [], `http://127.0.0.1:${server.address().port}`);
  const start = performance.now();
  assert.equal((await p.api.loadDeviceV2Capabilities()).scheduleGraphV2, true);
  assert.equal(requests, 2);
  assert.ok(performance.now() - start >= 4900, 'the real production request deadline was exercised');
});
