#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { activeAndroidTsxFiles, scanSource } = require('../feishu_ui_ast_gate');

const mapped = scanSource(
  "const screen = <Pressable {...feishuEvidence('UI-SHELL-001', 'primary-action')} onPress={save} />;",
  'Mapped.tsx',
);
assert.strictEqual(mapped.controls.length, 1);
assert.deepStrictEqual(mapped.controls[0].evidence, {
  id: 'UI-SHELL-001',
  semanticKey: 'primary-action',
});

const unmapped = scanSource('const screen = <Pressable onPress={save} />;', 'Unmapped.tsx');
assert.strictEqual(unmapped.controls.length, 1);
assert.strictEqual(unmapped.controls[0].evidence, null);

const discovered = scanSource(
  `
  const styles = StyleSheet.create({ root: { height: 50, backgroundColor: '#ffffff' } });
  const value = Animated.timing(progress, { toValue: 1 });
  const route = <Stack.Screen name="Profile" component={ProfileScreen} />;
  `,
  'Discovery.tsx',
);
assert.deepStrictEqual(
  discovered.visualConstants.map(item => item.property),
  ['height', 'backgroundColor'],
);
assert.strictEqual(discovered.animations.length, 1);
assert.deepStrictEqual(discovered.routes[0], {
  name: 'Profile',
  component: 'ProfileScreen',
  line: 4,
});

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'laoji-ui-ast-'));
fs.mkdirSync(path.join(fixture, 'src'));
fs.writeFileSync(path.join(fixture, 'App.tsx'), 'export default function App() { return null; }');
fs.writeFileSync(path.join(fixture, 'src', 'Screen.tsx'), 'export const Screen = null;');
fs.writeFileSync(path.join(fixture, 'src', 'Shadow.tsx'), 'export const Shadow = null;');
fs.writeFileSync(path.join(fixture, 'src', 'Shadow.android.tsx'), 'export const Shadow = null;');
const active = activeAndroidTsxFiles(fixture)
  .map(file => path.relative(fixture, file).split(path.sep).join('/'));
assert.deepStrictEqual(active, ['App.tsx', 'src/Screen.tsx', 'src/Shadow.android.tsx']);
fs.rmSync(fixture, { recursive: true, force: true });

console.log('Feishu TypeScript AST contracts: ok');
