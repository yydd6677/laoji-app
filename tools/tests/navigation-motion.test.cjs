const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const React = require('react');

for (const theme of ['neutral', 'vivid', 'paper', 'midnight']) {
  for (const reduceMotion of [false, true]) {
    test(`${theme}: detail route motion shares one contract; reduced=${reduceMotion}`, () => {
      const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../src/navigation/index.tsx'), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true },
      }).outputText;
      const m = { exports: {} };
      new Function('require', 'module', 'exports', code)(name => {
        if (name === 'react') return React;
        if (name === '@react-navigation/native-stack') return { createNativeStackNavigator: () => ({ Navigator: 'navigator', Screen: 'screen' }) };
        if (name.endsWith('/ThemeProvider')) return { useTheme: () => ({
          reduceMotion, appearance: { modalAnimation: 'slide_from_bottom', stackAnimation: `forbidden-${theme}`,
            surfaceMode: theme === 'paper' ? 'editorial' : 'flat' },
        }) };
        return new Proxy({}, { get: () => () => null });
      }, m, m.exports);
      const navigator = m.exports.RootNavigator();
      assert.equal(navigator.props.screenOptions.animation, reduceMotion ? 'none' : 'fade');
      // Android edge-to-edge drops the deprecated color prop. The existing
      // native window owner handles backdrop and icon contrast together.
      assert.equal(navigator.props.screenOptions.navigationBarColor, undefined);
      for (const name of ['EventDetail', 'Transcription']) {
        const screen = navigator.props.children.find(child => child.props.name === name);
        assert.equal(screen.props.options?.animation ?? navigator.props.screenOptions.animation, reduceMotion ? 'none' : 'fade');
      }
    });
  }
}
