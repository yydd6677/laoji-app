#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function relativeInside(root, target) {
  const relative = path.relative(root, fs.realpathSync(target)).split(path.sep).join('/');
  if (!relative || relative === '.') return '.';
  if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error(`${target} resolves outside ${root}`);
  }
  return relative;
}

function runAutolinking(root) {
  const executable = require.resolve(
    'expo-modules-autolinking/bin/expo-modules-autolinking',
    { paths: [root] },
  );
  const result = spawnSync(
    process.execPath,
    [executable, 'resolve', '--platform', 'android', '--json', '--project-root', root],
    { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(`Expo autolinking failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return JSON.parse(result.stdout);
}

function inspectWorkspace(root, options = {}) {
  root = fs.realpathSync(root);
  const errors = [];
  const inputs = [];
  const resolutions = {};

  for (const relative of [
    'package-lock.json',
    'metro.config.js',
    'plugins/withLaojiNativePlatform.js',
    'modules/laoji-native-platform/package.json',
    'scripts/check_workspace_source_resolution.js',
  ]) {
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) {
      errors.push({ code: 'WORKSPACE_INPUT_MISSING', path: relative });
      continue;
    }
    inputs.push({ path: relative, sha256: sha256File(file) });
  }

  const nodeModules = path.join(root, 'node_modules');
  let nodeModulesRelative = null;
  if (!fs.existsSync(nodeModules)) {
    errors.push({ code: 'NODE_MODULES_MISSING', path: 'node_modules' });
  } else {
    const stat = fs.lstatSync(nodeModules);
    if (stat.isSymbolicLink()) {
      errors.push({ code: 'NODE_MODULES_EXTERNAL_LINK', target: fs.realpathSync(nodeModules) });
    }
    try {
      nodeModulesRelative = relativeInside(root, nodeModules);
    } catch (error) {
      errors.push({ code: 'NODE_MODULES_OUTSIDE_WORKTREE', message: error.message });
    }
  }

  const expected = {
    'laoji-native-platform/package.json': 'modules/laoji-native-platform/package.json',
    'expo/package.json': 'node_modules/expo/package.json',
    'react-native/package.json': 'node_modules/react-native/package.json',
  };
  for (const [request, expectedPath] of Object.entries(expected)) {
    try {
      const resolved = require.resolve(request, { paths: [root] });
      const relative = relativeInside(root, resolved);
      resolutions[request] = relative;
      if (relative !== expectedPath) {
        errors.push({ code: 'PACKAGE_RESOLUTION_MISMATCH', request, expected: expectedPath, actual: relative });
      }
    } catch (error) {
      errors.push({ code: 'PACKAGE_RESOLUTION_FAILED', request, message: error.message });
    }
  }

  const metroPath = path.join(root, 'metro.config.js');
  if (fs.existsSync(metroPath)) {
    const metro = fs.readFileSync(metroPath, 'utf8');
    if (!/['"]laoji-native-platform['"]\s*:\s*path\.join\(__dirname,\s*['"]modules\/laoji-native-platform['"]\)/.test(metro)) {
      errors.push({ code: 'METRO_LOCAL_MODULE_MAPPING_MISSING', path: 'metro.config.js' });
    }
  }

  let autolinking = null;
  try {
    autolinking = options.autolinkingResult || runAutolinking(root);
    const modules = Array.isArray(autolinking.modules) ? autolinking.modules : [];
    const local = modules.find(module => module.packageName === 'laoji-native-platform');
    const projects = local && Array.isArray(local.projects) ? local.projects : [];
    if (projects.length !== 1) {
      errors.push({ code: 'AUTOLINK_LOCAL_MODULE_CARDINALITY', count: projects.length });
    } else {
      const actual = relativeInside(root, projects[0].sourceDir);
      if (actual !== 'modules/laoji-native-platform/android') {
        errors.push({
          code: 'AUTOLINK_LOCAL_MODULE_MISMATCH',
          expected: 'modules/laoji-native-platform/android',
          actual,
        });
      }
    }
    for (const module of modules) {
      for (const project of Array.isArray(module.projects) ? module.projects : []) {
        try {
          relativeInside(root, project.sourceDir);
        } catch (error) {
          errors.push({
            code: 'AUTOLINK_PROJECT_OUTSIDE_WORKTREE',
            packageName: module.packageName,
            sourceDir: project.sourceDir,
          });
        }
      }
    }
  } catch (error) {
    errors.push({ code: 'AUTOLINK_RESOLUTION_FAILED', message: error.message });
  }

  return {
    schemaVersion: 1,
    kind: 'workspace-source-resolution',
    inputs: inputs.sort((left, right) => left.path.localeCompare(right.path)),
    nodeModules: {
      path: 'node_modules',
      realPath: nodeModulesRelative,
      symbolicLink: fs.existsSync(nodeModules) ? fs.lstatSync(nodeModules).isSymbolicLink() : null,
    },
    resolutions,
    autolinking: autolinking ? {
      moduleCount: Array.isArray(autolinking.modules) ? autolinking.modules.length : 0,
      laojiSourceDir: (() => {
        const local = autolinking.modules?.find(module => module.packageName === 'laoji-native-platform');
        const sourceDir = local?.projects?.[0]?.sourceDir;
        if (!sourceDir) return null;
        try { return relativeInside(root, sourceDir); } catch { return sourceDir; }
      })(),
    } : null,
    errors,
  };
}

function main() {
  const command = process.argv[2];
  if (!['check', 'report'].includes(command)) {
    console.error('usage: check_workspace_source_resolution.js <check|report> [--root path] [--output path]');
    process.exit(2);
  }
  const rootIndex = process.argv.indexOf('--root');
  const root = fs.realpathSync(rootIndex >= 0 ? process.argv[rootIndex + 1] : path.join(__dirname, '..'));
  const outputIndex = process.argv.indexOf('--output');
  const output = outputIndex >= 0 ? path.resolve(root, process.argv[outputIndex + 1]) : null;
  const report = inspectWorkspace(root);
  const payload = `${JSON.stringify(report, null, 2)}\n`;
  if (output) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, payload);
  } else {
    process.stdout.write(payload);
  }
  if (command === 'check' && report.errors.length) {
    for (const error of report.errors) console.error(`ERROR ${error.code}: ${JSON.stringify(error)}`);
    process.exit(1);
  }
  console.log(`Workspace source resolution ${command === 'check' ? 'passed' : 'report generated'} (${report.errors.length} errors).`);
}

module.exports = { inspectWorkspace, relativeInside, sha256File };
if (require.main === module) main();
