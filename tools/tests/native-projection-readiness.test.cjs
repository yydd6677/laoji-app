const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const React = require('react');
const { act, create } = require('react-test-renderer');
global.IS_REACT_ACT_ENVIRONMENT = true;

test('visible projection starts after a frame, not route completion; superseded hashes cannot authenticate a newer body', async () => {
  const frames = new Map(), hashes = [], commits = [];
  let frameId = 0, result, root;
  const oldFrame = global.requestAnimationFrame, oldCancel = global.cancelAnimationFrame;
  global.requestAnimationFrame = fn => { frames.set(++frameId, fn); return frameId; };
  global.cancelAnimationFrame = id => frames.delete(id);
  const file = path.resolve(__dirname, '../../src/native/useNativeProjection.ts');
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const m = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => {
    if (name === 'react') return React;
    if (name === 'react-native') return { InteractionManager: { runAfterInteractions() { throw Error('route wait'); } } };
    if (name === 'laoji-native-platform') return { createNativeRandomUuid: () => 'surface' };
    if (name.endsWith('/deviceIdentity')) return { getOrCreateDeviceIdentity: async () => ({ epochId: 'epoch' }) };
    if (name.endsWith('/deviceAuthorityRepository')) return { ensureDeviceEpoch: async () => {} };
    if (name.endsWith('/nativeProjectionCheckpointRepository')) return {
      getNativeProjectionCheckpoint: async () => null,
      acceptNativeProjectionCheckpoint: async input => { commits.push(input); return { status: 'accepted', checkpoint: input }; },
    };
    if (name.endsWith('/projectionEnvelope')) return {
      projectionPayloadSha256: source => new Promise(resolve => hashes.push({ source, resolve })),
      createProjectionEnvelope: async input => input,
    };
    return {};
  }, m, m.exports);
  function Host({ snapshot }) {
    result = m.exports.useNativeProjection(snapshot, { entityId: 'meeting', surfaceKey: 'detail' });
    return null;
  }
  async function render(snapshot) {
    await act(async () => {
      const element = React.createElement(Host, { snapshot });
      if (root) root.update(element); else root = create(element);
    });
  }
  async function frame() { await act(async () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); }); }
  try {
    const first = { body: 'first' }, second = { body: 'second' };
    await render(first);
    assert.equal(result.projection, null);
    await frame();
    assert.equal(hashes[0].source, first);
    await render(second);
    await act(async () => hashes[0].resolve('sha256:first'));
    assert.equal(result.projection, null);
    assert.equal(commits.length, 0);
    await frame();
    await act(async () => hashes[1].resolve('sha256:second'));
    assert.equal(result.body, 'second');
    assert.equal(result.projection.payloadSha256, 'sha256:second');
    assert.equal(commits.length, 1);
  } finally {
    await act(async () => root?.unmount());
    global.requestAnimationFrame = oldFrame; global.cancelAnimationFrame = oldCancel;
  }
});
