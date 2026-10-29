const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const React = require('react');
const { create, act } = require('react-test-renderer');
global.IS_REACT_ACT_ENVIRONMENT = true;

function fixture() {
  const events = new Map(), pending = [];
  let bottom = 900;
  const View = React.forwardRef((props, ref) => {
    React.useImperativeHandle(ref, () => ({ measureInWindow: callback => callback(0, 50, 400, bottom - 50) }), []);
    return React.createElement('frame', props);
  });
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/components/KeyboardFrame.tsx'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true,
  } }).outputText;
  const m = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => {
    if (name === 'react') return React;
    if (name === 'react-native') return { View, Platform: { OS: 'android' }, KeyboardAvoidingView: 'ios-frame',
      Keyboard: { addListener: (event, callback) => { events.set(event, callback); return { remove: () => events.delete(event) }; } },
      Dimensions: { addEventListener: (event, callback) => { events.set(event, callback); return { remove: () => events.delete(event) }; } },
    };
    if (name === 'laoji-native-platform') return { readNativeKeyboardFrame: () => new Promise(resolve => pending.push(resolve)) };
    throw Error(name);
  }, m, m.exports);
  let root;
  return {
    mount: () => act(async () => { root = create(React.createElement(m.exports.KeyboardFrame, {}, React.createElement('input'))); }),
    resolve: (index, value) => act(async () => pending[index](value)),
    event: (name, value) => act(async () => events.get(name)(value)),
    padding: () => root.root.findByType('frame').props.style[1].paddingBottom,
    resizedBottom: value => { bottom = value; },
    dispose: () => act(async () => root.unmount()), events,
  };
}

test('the Android frame uses system insets, ignores corrupt RN coordinates and resets completely on hide', async () => {
  const f = fixture();
  try {
    await f.mount();
    await f.resolve(0, { visible: false, top: 0 });
    assert.equal(f.padding(), 0);
    await f.event('keyboardDidShow', { endCoordinates: { screenY: 50, height: 850 } });
    await f.resolve(1, { visible: true, top: 580 });
    assert.equal(f.padding(), 320);
    await f.event('keyboardDidHide', { endCoordinates: { screenY: 840, height: 0 } });
    assert.equal(f.padding(), 0);
  } finally { await f.dispose(); }
  assert.equal(f.events.size, 0);
});

test('an already resized window is not deducted twice and stale inset reads cannot restore old padding', async () => {
  const f = fixture();
  try {
    await f.mount();
    f.resizedBottom(580);
    await f.resolve(0, { visible: true, top: 580 });
    assert.equal(f.padding(), 0);
    await f.event('keyboardDidShow', {});
    await f.event('keyboardDidHide', {});
    await f.resolve(1, { visible: true, top: 200 });
    assert.equal(f.padding(), 0);
  } finally { await f.dispose(); }
});
