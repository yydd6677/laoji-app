#!/usr/bin/env node

const assert = require('assert');
const { scanSource } = require('../feishu_ui_ast_gate');

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

console.log('Feishu TypeScript AST contracts: ok');
