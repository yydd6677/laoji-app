#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const AdmZip = require('adm-zip');

const projectRoot = path.resolve(__dirname, '..');
const [bundleArg, outputArg] = process.argv.slice(2);

function fail(message) {
  console.error(message);
  process.exit(2);
}

if (!bundleArg || !outputArg) {
  fail('Usage: node scripts/materialize_aab_for_emulator.js <bundle.aab> <output.apk>');
}

const bundlePath = path.resolve(bundleArg);
const outputPath = path.resolve(outputArg);
if (!fs.existsSync(bundlePath) || path.extname(bundlePath).toLowerCase() !== '.aab') {
  fail(`AAB does not exist: ${bundlePath}`);
}
if (path.extname(outputPath).toLowerCase() !== '.apk') {
  fail('Output path must end with .apk.');
}

function newestBuildTool(sdkRoot, executable) {
  const buildToolsRoot = path.join(sdkRoot, 'build-tools');
  const candidates = fs.readdirSync(buildToolsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => ({
      version: entry.name,
      executable: path.join(buildToolsRoot, entry.name, executable),
    }))
    .filter(candidate => fs.existsSync(candidate.executable))
    .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  if (!candidates[0]) fail(`Unable to locate ${executable} under ${buildToolsRoot}.`);
  return candidates[0].executable;
}

function run(command, args, label, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    shell: process.platform === 'win32',
    ...options,
  });
  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || '').trim();
    throw new Error(`${label} failed: ${detail}`);
  }
}

const sdkRoot = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
if (!sdkRoot) fail('ANDROID_HOME or ANDROID_SDK_ROOT is required.');

const executableSuffix = process.platform === 'win32' ? '.exe' : '';
const aapt2Path = newestBuildTool(sdkRoot, `aapt2${executableSuffix}`);
const gradleWrapper = process.env.GRADLEW || path.join(
  projectRoot,
  'android',
  process.platform === 'win32' ? 'gradlew.bat' : 'gradlew',
);
if (!fs.existsSync(gradleWrapper)) fail(`Gradle wrapper does not exist: ${gradleWrapper}`);

const javaHomeKeytool = process.env.JAVA_HOME
  ? path.join(process.env.JAVA_HOME, 'bin', `keytool${executableSuffix}`)
  : null;
const keytool = javaHomeKeytool && fs.existsSync(javaHomeKeytool)
  ? javaHomeKeytool
  : `keytool${executableSuffix}`;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'laoji-aab-materialize-'));
const keystorePath = path.join(tempDir, 'emulator-only.keystore');
const apksPath = path.join(tempDir, 'universal.apks');
const password = `laoji-${crypto.randomBytes(12).toString('hex')}`;

try {
  fs.writeFileSync(path.join(tempDir, 'settings.gradle'), "rootProject.name = 'laoji-aab-materialize'\n");
  fs.writeFileSync(path.join(tempDir, 'build.gradle'), `
repositories {
    google()
    mavenCentral()
}

configurations {
    bundletool
}

dependencies {
    bundletool 'com.android.tools.build:bundletool:1.18.1'
}

tasks.register('buildUniversal', JavaExec) {
    classpath = configurations.bundletool
    mainClass = 'com.android.tools.build.bundletool.BundleToolMain'
    args 'build-apks',
        "--bundle=\${providers.gradleProperty('bundle').get()}",
        "--output=\${providers.gradleProperty('output').get()}",
        "--aapt2=\${providers.gradleProperty('aapt2').get()}",
        "--ks=\${providers.gradleProperty('keystore').get()}",
        "--ks-pass=pass:\${providers.gradleProperty('storePass').get()}",
        '--ks-key-alias=androiddebugkey',
        "--key-pass=pass:\${providers.gradleProperty('keyPass').get()}",
        '--mode=universal',
        '--overwrite'
}
`);

  run(keytool, [
    '-genkeypair',
    '-keystore', keystorePath,
    '-storepass', password,
    '-alias', 'androiddebugkey',
    '-keypass', password,
    '-keyalg', 'RSA',
    '-keysize', '2048',
    '-validity', '30',
    '-dname', 'CN=LaoJi Emulator Test,O=LaoJi,C=CN',
    '-noprompt',
  ], 'temporary emulator key generation');

  run(gradleWrapper, [
    '-p', tempDir,
    '--no-daemon',
    '-q',
    'buildUniversal',
    `-Pbundle=${bundlePath}`,
    `-Poutput=${apksPath}`,
    `-Paapt2=${aapt2Path}`,
    `-Pkeystore=${keystorePath}`,
    `-PstorePass=${password}`,
    `-PkeyPass=${password}`,
  ], 'BundleTool universal APK materialization');

  const universalEntry = new AdmZip(apksPath).getEntry('universal.apk');
  if (!universalEntry) throw new Error('BundleTool output does not contain universal.apk.');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, universalEntry.getData(), { mode: 0o600 });
  console.log(`Materialized emulator-only universal APK: ${outputPath}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
