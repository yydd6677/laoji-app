const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
function load(file, deps, globals = {}) {
  const m = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText;
  new Function('require', 'module', 'exports', ...Object.keys(globals), code)(deps, m, m.exports, ...Object.values(globals));
  return m.exports;
}
const hashes = load('src/data/repositories/meetingNoteRepository.ts', () => ({}));
const titles = load('src/services/meetingMediaImport.ts', () => ({}));
const planner = load('src/services/hardwareRecordingImport.ts', name =>
  name.endsWith('/meetingNoteRepository') ? hashes : titles);
const source = id => ({ recordingId: id, localUri: `file:///${id}.wav`, title: `录音 ${id}`,
  sourceDeviceRecordingId: `${id}.wav`, recordedAtMs: 1000, durationMs: 1000,
  checksumSha256: `sha256:${'a'.repeat(64)}`, byteSize: 32044 });
async function settle() { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); }
function harness(items, options = {}) {
  const pending = new Map(items.map(item => [item.recordingId, item]));
  const roots = new Map(options.roots ?? []), assets = new Map();
  const effects = [], timers = [], dialogs = [], navigations = [], creates = [], imports = [], audits = [];
  const drafts = new Map(); let listener, now = 10_000, fail = !!options.failImport, failAck = !!options.failAck;
  const react = { createContext: () => ({}), useState: init => [init, () => {}], useRef: value => ({ current: value }),
    useMemo: fn => fn(), useCallback: fn => fn, useEffect: fn => effects.push(fn), createElement: () => null };
  const native = {
    hasNativeHardwareSupport: () => true, hasNativeMeetingMediaImport: () => false,
    listPendingHardwareRecordings: async () => [...pending.values()],
    addHardwareRecordingListener: fn => { listener = fn; return { remove() {} }; },
    stageMeetingMediaImport: async () => {},
    ingestMeetingMedia: async args => ({ ...args, localUri: `file:///canonical/${args.assetId}.wav`,
      checksumSha256: 'a'.repeat(64), byteSize: 32044, durationMs: 1000, fileName: '录音.wav', mimeType: 'audio/wav' }),
    acknowledgeHardwareRecording: async id => { if (failAck) { failAck = false; return false; } pending.delete(id); return true; },
    acknowledgeIngestedMeetingMedia: async () => true,
  };
  const repository = {
    findByRecordingAssetId: async id => assets.get(id) ?? null,
    findByNativeSessionId: async id => roots.get(id) ?? null,
  };
  const store = {
    meetings: [], updateMeetingStatus: async () => {},
    createMeeting: async (title, args) => {
      assert.ok(!roots.has(args.id), 'must not create the same shell twice'); creates.push(args.id);
      roots.set(args.id, { note: { id: args.id, legacySourceId: args.id, title, lifecycle: 'ended' }, recordingAssets: [] });
      return { id: args.id };
    },
    importMeetingMedia: async (media, draft) => {
      if (fail) { fail = false; throw Object.assign(new Error(), { code: 'ERR_MEDIA_IMPORT_STORAGE' }); }
      imports.push(media.assetId);
      const owner = roots.get(draft.targetMeetingId ?? media.meetingId);
      assert.ok(owner, 'canonical shell must exist');
      owner.recordingAssets = [{ id: media.assetId, localState: 'local_ready', localUri: media.localUri,
        byteSize: media.byteSize, checksumSha256: media.checksumSha256 }];
      assets.set(media.assetId, owner); return { id: owner.note.id };
    },
  };
  const dependencies = name => {
    if (name === 'react') return react;
    if (name === 'react-native') return { AppState: { currentState: 'active' } };
    if (name === 'laoji-native-platform') return native;
    if (name.endsWith('/MeetingsStore')) return { useMeetings: () => store };
    if (name.endsWith('/EventsStore')) return { useEvents: () => ({ searchableEvents: [] }) };
    if (name.endsWith('/AppDialog')) return { useAppDialog: () => ({ showDialog: value => dialogs.push(value) }) };
    if (name.endsWith('/sqliteMeetingNoteRepository')) return { sqliteMeetingNoteRepository: repository };
    if (name.endsWith('/hardwareRecordingImport')) return planner;
    if (name.endsWith('/meetingMediaImport')) return titles;
    if (name.endsWith('/meetingMediaImportDrafts')) return {
      saveMeetingMediaImportDraft: async (id, draft) => drafts.set(id, draft),
      deleteMeetingMediaImportDraft: async id => drafts.delete(id), loadMeetingMediaImportDraft: async id => drafts.get(id) };
    if (name.endsWith('/localDataEraseState')) return { isLocalDataErasing: () => false, localDataEraseRevision: () => 0 };
    if (name.endsWith('/diagnostics')) return { diagnosticAudit: (...args) => audits.push(args) };
    if (name.endsWith('/notificationNavigation')) return { navigationRef: { isReady: () => true, navigate: (...args) => navigations.push(args) } };
    return {};
  };
  class Clock extends Date { static now() { return now; } }
  const component = load('src/components/MeetingMediaImportProvider.tsx', dependencies, {
    setInterval: fn => { timers.push(fn); return timers.length; }, clearInterval() {}, Date: Clock,
  });
  component.MeetingMediaImportProvider({ children: null });
  const cleanups = effects.map(fn => fn());
  return { pending, roots, assets, creates, imports, dialogs, navigations, audits, drafts,
    notify: () => listener(), tick: async () => { now += 310_000; timers.forEach(fn => fn()); await settle(); },
    close: () => cleanups.forEach(fn => { if (typeof fn === 'function') fn(); }) };
}
test('two verified offline receives automatically become two meetings, with no sheet/modal/navigation', async t => {
  const h = harness([source('one'), source('two')]); t.after(h.close); await settle();
  assert.deepEqual(h.creates, ['one', 'two']); assert.deepEqual(h.imports, ['one', 'two']);
  assert.equal(h.pending.size, 0); assert.equal(h.drafts.size, 0);
  assert.deepEqual(h.dialogs, []); assert.deepEqual(h.navigations, []);
  h.notify(); await h.tick(); assert.equal(h.imports.length, 2);
});
test('a failed adoption quietly retries the same shell, without losing its pending source', async t => {
  const h = harness([source('retry')], { failImport: true }); t.after(h.close); await settle();
  assert.deepEqual(h.creates, ['retry']); assert.equal(h.pending.size, 1); assert.deepEqual(h.dialogs, []);
  await h.tick(); assert.equal(h.pending.size, 0); assert.deepEqual(h.creates, ['retry']);
  assert.deepEqual(h.imports, ['retry']);
});
test('cleanup failure after canonical commit does not repeat import or create another meeting', async t => {
  const h = harness([source('cleanup')], { failAck: true }); t.after(h.close); await settle();
  assert.equal(h.pending.size, 1); assert.equal(h.imports.length, 1);
  await h.tick(); assert.equal(h.pending.size, 0); assert.equal(h.imports.length, 1); assert.equal(h.creates.length, 1);
});
test('live source waits for its capture owner and then joins that original meeting', async t => {
  const root = { note: { id: 'live', legacySourceId: 'live', title: '已有会议', lifecycle: 'active' }, recordingAssets: [] };
  const h = harness([{ ...source('board'), captureMeetingId: 'live' }], { roots: [['live', root]] }); t.after(h.close);
  await settle(); assert.equal(h.pending.size, 1); assert.deepEqual(h.creates, []); assert.deepEqual(h.imports, []);
  root.note.lifecycle = 'ended'; await h.tick();
  assert.equal(h.pending.size, 0); assert.deepEqual(h.creates, []); assert.deepEqual(h.imports, ['board']);
  assert.equal(root.note.title, '已有会议'); assert.deepEqual(h.dialogs, []); assert.deepEqual(h.navigations, []);
});
