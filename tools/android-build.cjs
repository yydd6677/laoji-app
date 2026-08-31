#!/usr/bin/env node

/*
 * Build/run LaoJi with exactly the ABI required by the selected Android
 * target. This keeps release APKs arm64-only while letting emulator-5562 use
 * x86_64 without changing tracked Gradle configuration.
 */

const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const androidRoot = path.join(projectRoot, 'android');
const isWindows = process.platform === 'win32';
const npx = isWindows ? 'npx.cmd' : 'npx';
const nativeInputsMarkerName = '.laoji-native-inputs.json';
const nativeInputsSchema = 1;
const nativeInputRoots = [
  'app.config.js',
  'package.json',
  'package-lock.json',
  'config',
  'plugins',
  'modules/laoji-native-platform/package.json',
  'modules/laoji-native-platform/expo-module.config.json',
  'modules/laoji-native-platform/android',
  'assets/icon.png',
  'assets/splash-icon.png',
  'assets/android-icon-background.png',
  'assets/android-icon-foreground.png',
  'assets/android-icon-monochrome.png',
  'assets/fonts',
  'patches',
];
const ignoredNativeInputDirectories = new Set([
  '.gradle',
  '.kotlin',
  '__pycache__',
  'build',
]);
const requiredGeneratedAndroidFiles = [
  'gradlew',
  'settings.gradle',
  'app/build.gradle',
  'app/src/main/AndroidManifest.xml',
  'app/src/main/java/com/laoji/app/MainActivity.kt',
  'app/src/main/java/com/laoji/app/MainApplication.kt',
];

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const result = { target: 'auto', variant: 'debug', serial: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!['--target', '--variant', '--serial'].includes(name)) fail(`未知参数: ${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`${name} 缺少值`);
    result[name.slice(2)] = value;
    index += 1;
  }
  if (!['auto', 'device', 'emulator', 'release'].includes(result.target)) {
    fail(`不支持的目标: ${result.target}`);
  }
  if (!['debug', 'release'].includes(result.variant)) fail(`不支持的构建类型: ${result.variant}`);
  return result;
}

function commandResult(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || projectRoot,
    env: options.env || process.env,
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
    shell: isWindows && /\.(cmd|bat)$/i.test(command),
  });
  if (result.error) fail(`${command} 启动失败: ${result.error.message}`);
  return result;
}

function adbCommand() {
  const executable = isWindows ? 'adb.exe' : 'adb';
  const sdkRoot = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME;
  if (sdkRoot) {
    const candidate = path.join(sdkRoot, 'platform-tools', executable);
    if (fs.existsSync(candidate)) return candidate;
  }
  return executable;
}

function connectedDevices(adb) {
  const result = commandResult(adb, ['devices']);
  if (result.status !== 0) fail(`adb devices 失败: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout
    .split(/\r?\n/)
    .slice(1)
    .map(line => line.trim().split(/\s+/))
    .filter(parts => parts.length >= 2 && parts[1] === 'device')
    .map(parts => parts[0]);
}

function chooseSerial(adb, target, requestedSerial) {
  const devices = connectedDevices(adb);
  if (requestedSerial) {
    if (!devices.includes(requestedSerial)) fail(`目标 ${requestedSerial} 当前不在线`);
    return requestedSerial;
  }

  const inherited = String(process.env.ANDROID_SERIAL || '').trim();
  if (inherited) {
    if (!devices.includes(inherited)) fail(`ANDROID_SERIAL=${inherited} 当前不在线`);
    return inherited;
  }

  let candidates = devices;
  if (target === 'device') candidates = devices.filter(serial => !serial.startsWith('emulator-'));
  if (target === 'emulator') {
    candidates = devices.filter(serial => serial === 'emulator-5562');
    if (candidates.length === 0) candidates = devices.filter(serial => serial.startsWith('emulator-'));
  }
  if (candidates.length === 0) fail(`没有找到可用的 Android ${target === 'device' ? '真机' : '目标'}`);
  if (candidates.length > 1) {
    fail(`存在多个 Android 目标 (${candidates.join(', ')})，请使用 --serial 明确选择`);
  }
  return candidates[0];
}

function targetAbi(adb, serial) {
  const result = commandResult(adb, ['-s', serial, 'shell', 'getprop', 'ro.product.cpu.abi']);
  if (result.status !== 0) fail(`无法读取 ${serial} 的 ABI: ${(result.stderr || result.stdout).trim()}`);
  const abi = result.stdout.trim();
  const supported = new Set(['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86']);
  if (!supported.has(abi)) fail(`${serial} 返回了不支持的 ABI: ${abi || '空'}`);
  return abi;
}

function expoDeviceName(adb, serial) {
  if (!serial.startsWith('emulator-')) return serial;
  const result = commandResult(adb, ['-s', serial, 'emu', 'avd', 'name']);
  if (result.status !== 0) return serial;
  const name = result.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line && line !== 'OK');
  return name || serial;
}

function runInteractive(command, args, options = {}) {
  const result = commandResult(command, args, { ...options, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function lexicalCompare(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function portableRelativePath(root, absolutePath) {
  return path.relative(root, absolutePath).split(path.sep).join('/');
}

function collectNativeInputEntries(root = projectRoot) {
  const entries = [];

  function visit(absolutePath) {
    const relativePath = portableRelativePath(root, absolutePath);
    if (!fs.existsSync(absolutePath)) {
      entries.push({ kind: 'missing', path: relativePath, value: null });
      return;
    }
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink()) {
      entries.push({ kind: 'symlink', path: relativePath, value: fs.readlinkSync(absolutePath) });
      return;
    }
    if (stat.isDirectory()) {
      if (ignoredNativeInputDirectories.has(path.basename(absolutePath))) return;
      const children = fs.readdirSync(absolutePath)
        .map(name => path.join(absolutePath, name))
        .sort((left, right) => lexicalCompare(
          portableRelativePath(root, left),
          portableRelativePath(root, right),
        ));
      if (children.length === 0) entries.push({ kind: 'directory', path: relativePath, value: null });
      for (const child of children) visit(child);
      return;
    }
    if (stat.isFile()) entries.push({ kind: 'file', path: relativePath, value: absolutePath });
  }

  for (const relativePath of nativeInputRoots) visit(path.join(root, relativePath));
  return entries.sort((left, right) => lexicalCompare(left.path, right.path));
}

function nativeEnvironmentEntries(env = process.env) {
  const explicit = new Set([
    'APP_ENV',
    'EAS_BUILD',
    'EXPO_ALLOW_CLEARTEXT',
    'LAOJI_SIGNING_PROPERTIES',
  ]);
  return Object.keys(env)
    .filter(key => explicit.has(key) || key.startsWith('EXPO_PUBLIC_'))
    .sort(lexicalCompare)
    .map(key => [key, String(env[key] ?? '')]);
}

function computeNativeInputsFingerprint(root = projectRoot, env = process.env) {
  const hash = crypto.createHash('sha256');
  const entries = collectNativeInputEntries(root);
  hash.update(`laoji-native-inputs-v${nativeInputsSchema}\0`);
  for (const entry of entries) {
    hash.update(`${entry.kind}\0${entry.path}\0`);
    if (entry.kind === 'file') hash.update(fs.readFileSync(entry.value));
    else if (entry.value !== null) hash.update(String(entry.value));
    hash.update('\0');
  }
  for (const [key, value] of nativeEnvironmentEntries(env)) {
    hash.update(`env\0${key}\0${value}\0`);
  }
  return { fingerprint: hash.digest('hex'), inputCount: entries.length };
}

function nativeInputsMarkerPath(root = projectRoot) {
  return path.join(root, 'android', nativeInputsMarkerName);
}

function generatedAndroidFilesExist(root = projectRoot) {
  return requiredGeneratedAndroidFiles.every(relativePath => (
    fs.existsSync(path.join(root, 'android', relativePath))
  ));
}

function nativeProjectGenerationState(root = projectRoot, env = process.env) {
  const current = computeNativeInputsFingerprint(root, env);
  if (!generatedAndroidFilesExist(root)) {
    return { rebuild: true, reason: 'generated_project_missing', current };
  }
  const markerPath = nativeInputsMarkerPath(root);
  if (!fs.existsSync(markerPath)) return { rebuild: true, reason: 'marker_missing', current };
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch {
    return { rebuild: true, reason: 'marker_invalid', current };
  }
  if (marker.schema !== nativeInputsSchema) {
    return { rebuild: true, reason: 'marker_schema_changed', current };
  }
  if (marker.fingerprint !== current.fingerprint) {
    return { rebuild: true, reason: 'native_inputs_changed', current };
  }
  return { rebuild: false, reason: 'native_inputs_match', current };
}

function writeNativeInputsMarker(root = projectRoot, env = process.env) {
  const current = computeNativeInputsFingerprint(root, env);
  const markerPath = nativeInputsMarkerPath(root);
  const temporaryPath = `${markerPath}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(temporaryPath, `${JSON.stringify({
    schema: nativeInputsSchema,
    fingerprint: current.fingerprint,
    inputCount: current.inputCount,
  }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(temporaryPath, markerPath);
  } catch (error) {
    // Windows does not consistently replace an existing file with rename.
    // A clean prebuild normally removes the marker; this is the safe fallback
    // for tests and interrupted/manual regeneration.
    if (!isWindows || !['EEXIST', 'EPERM'].includes(error?.code)) throw error;
    fs.rmSync(markerPath, { force: true });
    fs.renameSync(temporaryPath, markerPath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
  return current;
}

function parseEnvFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  const result = {};
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const normalized = line.startsWith('export ') ? line.slice(7).trim() : line;
    const separator = normalized.indexOf('=');
    if (separator <= 0) continue;
    const key = normalized.slice(0, separator).trim();
    let value = normalized.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function releaseEnvironment() {
  const configured = String(process.env.LAOJI_RELEASE_ENV_FILE || '').trim();
  const candidates = [
    configured,
    path.join(projectRoot, '.env.production.local'),
    path.join(os.homedir(), '.config', 'laoji', 'mobile-release.env'),
    path.join(projectRoot, '.env.local'),
  ].filter(Boolean);
  const envFile = candidates.find(candidate => fs.existsSync(candidate));
  if (!envFile) {
    fail(
      '缺少老记正式构建环境。请设置 LAOJI_RELEASE_ENV_FILE，'
      + '或创建 ~/.config/laoji/mobile-release.env。',
    );
  }
  const loaded = parseEnvFile(envFile);
  const compatibleSigning = path.join(
    os.homedir(),
    '.config',
    'laoji',
    'signing',
    'compatible-public-updates.properties',
  );
  const env = {
    ...process.env,
    ...loaded,
    APP_ENV: 'production',
    NODE_ENV: 'production',
    LAOJI_SIGNING_PROPERTIES: process.env.LAOJI_SIGNING_PROPERTIES || compatibleSigning,
    EXPO_ALLOW_CLEARTEXT: 'false',
  };
  const apiBase = String(env.EXPO_PUBLIC_API_BASE || '').trim();
  const bootstrapKey = String(env.EXPO_PUBLIC_DEVICE_BOOTSTRAP_KEY || '').trim();
  if (!apiBase.startsWith('https://')) fail('正式构建缺少 HTTPS API 地址');
  if (bootstrapKey.length < 32) fail('正式构建缺少有效的设备注册引导密钥');
  if (!fs.existsSync(env.LAOJI_SIGNING_PROPERTIES)) {
    fail('正式构建缺少与公开更新链兼容的签名配置');
  }
  return env;
}

function verifyGeneratedAndroidProject({ requireReleaseSigning = false } = {}) {
  for (const relativePath of requiredGeneratedAndroidFiles) {
    const absolutePath = path.join(androidRoot, relativePath);
    if (!fs.existsSync(absolutePath)) fail(`Expo prebuild 未生成 ${relativePath}`);
  }

  const expectations = [
    ['app/build.gradle', '@generated-by-laoji-release-contract-verification'],
    ['app/build.gradle', '@generated-by-laoji-java-time-desugaring'],
    ['app/src/main/AndroidManifest.xml', 'com.laoji.nativeplatform.audio.LaojiRecordingService'],
    ['app/src/main/AndroidManifest.xml', 'com.laoji.nativeplatform.media.LaojiMinutesPlaybackService'],
    ['app/src/main/java/com/laoji/app/MainActivity.kt', 'MediaImportIntentInbox'],
    ['app/src/main/java/com/laoji/app/MainActivity.kt', 'LaojiThemeTypography'],
    ['app/src/main/java/com/laoji/app/MainApplication.kt', 'LaojiThemeNeutral'],
  ];
  if (requireReleaseSigning) {
    expectations.push(['app/build.gradle', '// LaoJi local release signing']);
  }
  for (const [relativePath, marker] of expectations) {
    const contents = fs.readFileSync(path.join(androidRoot, relativePath), 'utf8');
    if (!contents.includes(marker)) {
      fail(`Expo prebuild 产物缺少 ${relativePath} 中的 ${marker}`);
    }
  }

  // app.config.js is the release-version owner. package.json is kept only as
  // the npm/Expo mirror and must never drift from the freshly generated native
  // version again.
  const packageVersion = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
  ).version;
  const buildGradle = fs.readFileSync(path.join(androidRoot, 'app/build.gradle'), 'utf8');
  const generatedVersion = buildGradle.match(/^\s*versionName\s+["']([^"']+)["']/m)?.[1];
  if (!generatedVersion || packageVersion !== generatedVersion) {
    fail(
      `版本来源不一致: app.config.js=${generatedVersion || '未生成'}, `
      + `package.json=${packageVersion || '缺失'}`,
    );
  }
}

function cleanPrebuildAndroid(env, { requireReleaseSigning = false } = {}) {
  runInteractive(npx, ['expo', 'prebuild', '--platform', 'android', '--clean', '--no-install'], { env });
  verifyGeneratedAndroidProject({ requireReleaseSigning });
  writeNativeInputsMarker(projectRoot, env);
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.target === 'release') {
    if (options.variant !== 'release') fail('release 目标必须使用 release 构建类型');
    const env = releaseEnvironment();
    runInteractive(process.execPath, [path.join(projectRoot, 'tools', 'audit-ui-information-ownership.cjs'), '--changed', '--summary']);
    runInteractive(process.execPath, [path.join(projectRoot, 'tools', 'verify-ui-known-regressions.cjs')]);
    runInteractive(process.execPath, [path.join(projectRoot, 'tools', 'verify-ui-continuity-contract.cjs')]);
    process.stdout.write('老记正式包: arm64-v8a\n');
    // A release always starts from source-owned native inputs, even if a
    // matching debug marker exists.
    cleanPrebuildAndroid(env, { requireReleaseSigning: true });
    const gradle = path.join(androidRoot, isWindows ? 'gradlew.bat' : 'gradlew');
    runInteractive(gradle, [':app:assembleRelease', '-PreactNativeArchitectures=arm64-v8a'], {
      cwd: androidRoot,
      env,
    });
    return;
  }

  if (options.variant !== 'debug') fail('真机和模拟器运行脚本当前只负责 debug 构建');
  const adb = adbCommand();
  const serial = chooseSerial(adb, options.target, options.serial);
  const abi = targetAbi(adb, serial);
  const deviceName = expoDeviceName(adb, serial);
  const metroPort = String(process.env.LAOJI_METRO_PORT || '8083').trim();
  if (!/^\d+$/.test(metroPort)) fail(`LAOJI_METRO_PORT 无效: ${metroPort}`);
  const env = {
    ...process.env,
    ANDROID_SERIAL: serial,
    ORG_GRADLE_PROJECT_reactNativeArchitectures: abi,
    ORG_GRADLE_PROJECT_reactNativeDevServerPort: metroPort,
  };
  const nativeState = nativeProjectGenerationState(projectRoot, env);
  if (nativeState.rebuild) {
    process.stdout.write(`老记 Android 原生输入已变化，重新生成 (${nativeState.reason})\n`);
    cleanPrebuildAndroid(env);
  } else {
    process.stdout.write('老记 Android 原生输入未变化，复用生成树\n');
  }
  process.stdout.write(`老记 Android 目标: ${serial} (${abi})\n`);
  runInteractive(npx, ['expo', 'run:android', '--device', deviceName, '--port', metroPort], { env });
}

if (require.main === module) main();

module.exports = {
  collectNativeInputEntries,
  computeNativeInputsFingerprint,
  generatedAndroidFilesExist,
  nativeProjectGenerationState,
  writeNativeInputsMarker,
};
