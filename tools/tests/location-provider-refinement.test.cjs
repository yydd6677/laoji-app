const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname,
  '../../src/services/currentAddressPolicy.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const target = { exports: {} };
new Function('module', 'exports', code)(target, target.exports);
const { watchLocationProvider, raceLocationProviders } = target.exports;
const fix = (accuracy, latitude = 23) => ({ latitude, longitude: 113, accuracyMeters: accuracy,
  timestampMs: Date.now(), ageMs: 0, provider: 'watch', source: 'live' });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('coarse first result does not discard a later precise fix', async () => {
  let receive; let removed = 0;
  const attempt = watchLocationProvider('watch', async cb => {
    receive = cb; cb(fix(900));
    return { remove() { removed++; } };
  });
  const result = raceLocationProviders([attempt], { timeoutMs: 200, degradedGraceMs: 100 });
  await delay(10); receive(fix(15));
  assert.equal((await result).accuracyMeters, 15);
  assert.equal(removed, 1);
  receive(fix(1)); assert.equal(removed, 1);
});
test('best coarse fix returns on the bounded grace period when GPS cannot improve', async () => {
  let receive; let removed = 0;
  const attempt = watchLocationProvider('watch', async cb => {
    receive = cb; cb(fix(900)); return { remove() { removed++; } };
  });
  const result = raceLocationProviders([attempt], { timeoutMs: 200, degradedGraceMs: 30 });
  await delay(5); receive(fix(180)); receive(fix(600));
  assert.equal((await result).accuracyMeters, 180); assert.equal(removed, 1);
});
test('synchronous precise result cleans a subscription resolved after race completion', async () => {
  let removed = 0;
  const attempt = watchLocationProvider('watch', async cb => {
    cb(fix(10)); await delay(10); return { remove() { removed++; } };
  });
  assert.equal((await raceLocationProviders([attempt], { timeoutMs: 100 })).accuracyMeters, 10);
  await delay(20); assert.equal(removed, 1);
});
test('timeout and permission failures clean up without accepting a stale position', async () => {
  let removed = 0;
  const attempt = watchLocationProvider('watch', async () => ({ remove() { removed++; } }));
  await assert.rejects(raceLocationProviders([attempt], { timeoutMs: 15 }));
  assert.equal(removed, 1);
  const denied = watchLocationProvider('watch', async () => { throw new Error('denied'); });
  await assert.rejects(raceLocationProviders([denied], { timeoutMs: 100 }), /denied/);
});
