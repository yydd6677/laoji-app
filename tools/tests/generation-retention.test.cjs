const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

function load(response) {
  const calls = [];
  const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../src/services/generationPrivacy.ts'), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => {
    assert.equal(name, './deviceV2Api');
    return { deviceV2Request: async (...args) => { calls.push(args); return response(); } };
  }, module, module.exports);
  return { ...module.exports, calls };
}

test('load uses the authenticated server, not the removed local-only value', async () => {
  const api = load(() => ({ schema_version: 2, enabled: false, revision: 0 }));
  assert.equal(await api.loadGenerationRetentionPreference(), false);
  assert.equal(api.calls[0][0], '/privacy/generated-results');
});
test('save explicitly sends a boolean and waits for confirmation', async () => {
  const api = load(() => ({ schema_version: 2, enabled: true, revision: 1 }));
  assert.equal(await api.saveGenerationRetentionPreference(true), true);
  assert.equal(api.calls[0][1].method, 'PUT');
  assert.deepEqual(JSON.parse(api.calls[0][1].body), { enabled: true });
});
for (const value of [null, {}, { schema_version: 2, enabled: 'true', revision: 1 },
  { schema_version: 2, enabled: true, revision: -1 }]) {
  test('unconfirmed/malformed server state is not represented as a saved preference: '+JSON.stringify(value), async () => {
    const api = load(() => value);
    await assert.rejects(api.loadGenerationRetentionPreference());
  });
}
test('a failed PUT cannot become a local success', async () => {
  const api = load(() => { throw new Error('offline'); });
  await assert.rejects(api.saveGenerationRetentionPreference(false), /offline/);
});
test('a contradictory acknowledgement cannot claim the switch changed', async () => {
  const api = load(() => ({ schema_version: 2, enabled: false, revision: 1 }));
  await assert.rejects(api.saveGenerationRetentionPreference(true), /未确认/);
});
