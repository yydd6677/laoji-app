#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { inspectWorkspace } = require('../check_workspace_source_resolution');

function write(root, relative, value) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'laoji-workspace-source-'));
  write(root, 'package-lock.json', '{}');
  write(
    root,
    'metro.config.js',
    "config.resolver.extraNodeModules = {'laoji-native-platform': path.join(__dirname, 'modules/laoji-native-platform')};",
  );
  write(root, 'plugins/withLaojiNativePlatform.js', '// plugin');
  write(root, 'scripts/check_workspace_source_resolution.js', '// gate');
  write(root, 'modules/laoji-native-platform/package.json', '{"name":"laoji-native-platform"}');
  fs.mkdirSync(path.join(root, 'modules/laoji-native-platform/android'), { recursive: true });
  write(root, 'node_modules/expo/package.json', '{"name":"expo"}');
  fs.mkdirSync(path.join(root, 'node_modules/expo/android'), { recursive: true });
  write(root, 'node_modules/react-native/package.json', '{"name":"react-native"}');
  fs.symlinkSync('../modules/laoji-native-platform', path.join(root, 'node_modules/laoji-native-platform'));
  return root;
}

const root = fixture();
const clean = inspectWorkspace(root, {
  autolinkingResult: {
    modules: [
      {
        packageName: 'laoji-native-platform',
        projects: [{ sourceDir: path.join(root, 'modules/laoji-native-platform/android') }],
      },
      {
        packageName: 'expo',
        projects: [{ sourceDir: path.join(root, 'node_modules/expo/android') }],
      },
    ],
  },
});
assert.deepStrictEqual(clean.errors, []);
assert.strictEqual(clean.resolutions['laoji-native-platform/package.json'], 'modules/laoji-native-platform/package.json');

const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'laoji-workspace-external-'));
const linkedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'laoji-workspace-linked-'));
for (const [relative, value] of [
  ['package-lock.json', '{}'],
  ['metro.config.js', "'laoji-native-platform': path.join(__dirname, 'modules/laoji-native-platform')"],
  ['plugins/withLaojiNativePlatform.js', '// plugin'],
  ['scripts/check_workspace_source_resolution.js', '// gate'],
  ['modules/laoji-native-platform/package.json', '{"name":"laoji-native-platform"}'],
]) write(linkedRoot, relative, value);
fs.mkdirSync(path.join(externalRoot, 'expo'), { recursive: true });
fs.symlinkSync(externalRoot, path.join(linkedRoot, 'node_modules'));
const linked = inspectWorkspace(linkedRoot, { autolinkingResult: { modules: [] } });
assert(linked.errors.some(error => error.code === 'NODE_MODULES_EXTERNAL_LINK'));
assert(linked.errors.some(error => error.code === 'NODE_MODULES_OUTSIDE_WORKTREE'));

console.log('Workspace source resolution contracts: ok');
