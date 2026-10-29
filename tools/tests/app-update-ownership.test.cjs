const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const manifest = {
  platform: 'android', version_name: '2.0.0', version_code: 200,
  apk_url: 'https://laoji.cloud/downloads/android/laoji.apk',
  sha256: 'sha256:' + 'a'.repeat(64), size_bytes: 1000, release_notes: [],
};
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
function load(overrides = {}) {
  const states = [], downloads = [], calls = { fetch: 0, install: 0, delete: 0 };
  const fsApi = {
    cacheDirectory: 'file:///cache/', makeDirectoryAsync: async () => {},
    readDirectoryAsync: async () => [], deleteAsync: async () => { calls.delete++; },
    createDownloadResumable: (_url, uri, _options, progress) => {
      const done = deferred(); downloads.push({ progress, done, uri });
      return { downloadAsync: () => done.promise };
    }, ...overrides.fs,
  };
  const dependencies = {
    'react-native': { AppState: { addEventListener: () => ({ remove() {} }) } },
    react: {}, 'expo-constants': { default: { expoConfig: { android: { versionCode: 100 } } } },
    'expo-file-system/legacy': fsApi,
    '@react-native-async-storage/async-storage': { default: {
      getItem: async () => '0', setItem: async () => {}, ...overrides.storage,
    } },
    './config': { getApiConfig: () => ({ apiBase: 'https://laoji.cloud' }) },
    './http': {
      fetchWithTimeout: async () => { calls.fetch++; return overrides.fetch ? overrides.fetch() : { ok: true }; },
      readJsonWithTimeout: async () => manifest,
    },
    'laoji-native-platform': {
      sha256NativeFile: overrides.hash || (async () => ({ checksumSha256: manifest.sha256, byteSize: manifest.size_bytes })),
      installVerifiedApk: () => { calls.install++; },
    },
  };
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/services/appUpdate.ts'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => {
    assert.ok(name in dependencies, name); return dependencies[name];
  }, module, module.exports);
  module.exports.subscribeAppUpdate(s => states.push(s));
  return { api: module.exports, states, downloads, calls };
}
async function startDownload(harness) {
  await harness.api.checkForAppUpdate({ manual: true });
  const pending = harness.api.downloadAndInstallAppUpdate();
  await flush();
  return { pending, download: harness.downloads[0] };
}
function finish(download) { download.done.resolve({ status: 200, uri: download.uri }); }

test('automatic check awaiting storage cannot erase an active download', async () => {
  const storage = deferred();
  const h = load({ storage: { getItem: () => storage.promise } });
  await h.api.checkForAppUpdate({ manual: true });
  const check = h.api.checkForAppUpdate(); await flush();
  const pending = h.api.downloadAndInstallAppUpdate(); await flush();
  h.downloads[0].progress({ totalBytesWritten: 320, totalBytesExpectedToWrite: 1000 });
  const mark = h.states.length;
  storage.resolve('0'); await check;
  assert.equal(h.api.getAppUpdateState().progress, 0.32);
  assert.equal(h.states.length, mark);
  finish(h.downloads[0]); await pending;
});
for (const failure of [false, true]) {
  test(`late check ${failure ? 'failure' : 'success'} cannot replace download state`, async () => {
    const fetch = deferred(); let first = true;
    const h = load({ fetch: () => { if (first) { first = false; return { ok: true }; } return fetch.promise; } });
    await h.api.checkForAppUpdate({ manual: true });
    const check = h.api.checkForAppUpdate({ manual: true }); await flush();
    const pending = h.api.downloadAndInstallAppUpdate(); await flush();
    h.downloads[0].progress({ totalBytesWritten: 400 });
    if (failure) fetch.reject(Error('offline')); else fetch.resolve({ ok: true });
    await check;
    assert.equal(h.api.getAppUpdateState().status, 'downloading');
    assert.equal(h.api.getAppUpdateState().progress, 0.4);
    finish(h.downloads[0]); await pending;
  });
}
test('rapid checks and repeated install taps are each single-flight', async () => {
  const h = load();
  const a = h.api.checkForAppUpdate({ manual: true });
  assert.equal(a, h.api.checkForAppUpdate({ manual: true })); await a;
  const b = h.api.downloadAndInstallAppUpdate();
  assert.equal(b, h.api.downloadAndInstallAppUpdate()); await flush();
  assert.equal(h.downloads.length, 1);
  finish(h.downloads[0]); await b;
  assert.equal(h.calls.install, 1); assert.equal(h.calls.fetch, 1);
});
test('progress starts at zero, remains numeric and never retreats or disappears during verification', async () => {
  const hash = deferred(); const h = load({ hash: () => hash.promise });
  const { pending, download } = await startDownload(h);
  assert.equal(h.api.getAppUpdateState().progress, 0);
  for (const bytes of [250, 100, NaN, Infinity, -1, 500]) {
    download.progress({ totalBytesWritten: bytes, totalBytesExpectedToWrite: bytes === 500 ? 2000 : -1 });
  }
  assert.equal(h.api.getAppUpdateState().progress, 0.5);
  finish(download); await flush();
  assert.equal(h.api.getAppUpdateState().progress, 1);
  download.progress({ totalBytesWritten: 10 });
  assert.equal(h.api.getAppUpdateState().progress, 1);
  hash.resolve({ checksumSha256: manifest.sha256, byteSize: 1000 }); await pending;
  download.progress({ totalBytesWritten: 900 });
  assert.equal(h.api.getAppUpdateState().status, 'ready_to_install');
  await h.api.checkForAppUpdate({ manual: true });
  assert.equal(h.api.getAppUpdateState().status, 'ready_to_install');
  const values = h.states.filter(s => s.status === 'downloading').map(s => s.progress);
  assert.deepEqual(values, [0, 0.25, 0.5, 1]);
});
for (const phase of ['directory', 'download', 'hash', 'size']) {
  test(`${phase} failure is terminal; retry has a new owner and late callbacks cannot revive the old one`, async () => {
    let first = true;
    const h = load({
      fs: phase === 'directory' ? { makeDirectoryAsync: async () => { if (first) { first = false; throw Error('storage'); } } } : {},
      hash: async () => {
        if (first && (phase === 'hash' || phase === 'size')) { first = false; return { checksumSha256: phase === 'hash' ? 'bad' : manifest.sha256, byteSize: phase === 'size' ? 999 : 1000 }; }
        return { checksumSha256: manifest.sha256, byteSize: 1000 };
      },
    });
    const { pending, download } = await startDownload(h);
    const rejected = assert.rejects(pending);
    if (download) { if (phase === 'download') download.done.reject(Error('offline')); else finish(download); }
    await rejected;
    assert.equal(h.api.getAppUpdateState().status, 'failed');
    const retry = h.api.downloadAndInstallAppUpdate(); await flush();
    if (download) download.progress({ totalBytesWritten: 900 });
    assert.equal(h.api.getAppUpdateState().progress, 0);
    finish(h.downloads.at(-1)); await retry;
    assert.equal(h.api.getAppUpdateState().status, 'ready_to_install');
  });
}
