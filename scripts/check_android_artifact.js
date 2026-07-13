const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const AdmZip = require('adm-zip');
const { validateEmbeddedAppConfig } = require('./androidArtifactConfig');

const args = process.argv.slice(2);
const artifact = args.find(value => !value.startsWith('--'));
const production = args.includes('--production');
const rehearsal = args.includes('--rehearsal');
const productionLike = production || rehearsal;
const projectRoot = path.resolve(__dirname, '..');
const artifactPath = artifact ? path.resolve(artifact) : '';
const artifactType = path.extname(artifactPath).toLowerCase();

if (!artifact || !fs.existsSync(artifactPath) || !['.apk', '.aab'].includes(artifactType)) {
  console.error('Usage: node scripts/check_android_artifact.js <apk-or-aab> [--production|--rehearsal]');
  process.exit(2);
}
if (production && rehearsal) {
  console.error('Choose only one artifact mode: --production or --rehearsal.');
  process.exit(2);
}

const forbiddenPermissions = new Set([
  'android.permission.CAMERA',
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
  'android.permission.READ_MEDIA_IMAGES',
  'android.permission.READ_MEDIA_VIDEO',
  'android.permission.SYSTEM_ALERT_WINDOW',
  'com.google.android.c2dm.permission.RECEIVE',
]);

function commandCandidates() {
  const executable = process.platform === 'win32' ? 'apkanalyzer.bat' : 'apkanalyzer';
  const roots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT].filter(Boolean);
  return [
    executable,
    ...roots.map(root => path.join(root, 'cmdline-tools', 'latest', 'bin', executable)),
  ];
}

function runAnalyzer(commandArgs) {
  for (const executable of commandCandidates()) {
    const result = spawnSync(executable, commandArgs, { encoding: 'utf8' });
    if (!result.error && result.status === 0) return result.stdout;
    if (result.error && result.error.code === 'ENOENT') continue;
    const detail = (result.stderr || result.stdout || result.error?.message || '').trim();
    throw new Error(`apkanalyzer failed: ${detail}`);
  }
  throw new Error('apkanalyzer was not found. Set ANDROID_HOME or add it to PATH.');
}

function runRequired(executable, commandArgs, label, options = {}) {
  const result = spawnSync(executable, commandArgs, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || '').trim();
    throw new Error(`${label} failed: ${detail}`);
  }
  return result.stdout;
}

function bundletoolManifest() {
  const standaloneJar = process.env.BUNDLETOOL_JAR;
  if (standaloneJar) {
    if (!fs.existsSync(standaloneJar)) {
      throw new Error(`BUNDLETOOL_JAR does not exist: ${standaloneJar}`);
    }
    runRequired('java', ['-jar', standaloneJar, 'validate', `--bundle=${artifactPath}`], 'bundletool validate');
    return runRequired(
      'java',
      ['-jar', standaloneJar, 'dump', 'manifest', `--bundle=${artifactPath}`, '--module=base'],
      'bundletool dump manifest',
    );
  }

  const wrapper = process.env.GRADLEW || path.join(
    projectRoot,
    'android',
    process.platform === 'win32' ? 'gradlew.bat' : 'gradlew',
  );
  if (!fs.existsSync(wrapper)) {
    throw new Error('AAB inspection needs BUNDLETOOL_JAR or a generated Android Gradle wrapper.');
  }

  const runnerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'laoji-bundletool-'));
  try {
    fs.writeFileSync(path.join(runnerDir, 'settings.gradle'), "rootProject.name = 'laoji-bundletool-runner'\n");
    fs.writeFileSync(path.join(runnerDir, 'build.gradle'), `
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

tasks.register('validateBundle', JavaExec) {
    classpath = configurations.bundletool
    mainClass = 'com.android.tools.build.bundletool.BundleToolMain'
    args 'validate', "--bundle=\${providers.gradleProperty('bundle').get()}"
}

tasks.register('dumpManifest', JavaExec) {
    dependsOn 'validateBundle'
    classpath = configurations.bundletool
    mainClass = 'com.android.tools.build.bundletool.BundleToolMain'
    args 'dump', 'manifest', "--bundle=\${providers.gradleProperty('bundle').get()}", '--module=base'
}
`);
    return runRequired(
      wrapper,
      ['-p', runnerDir, '-q', 'dumpManifest', `-Pbundle=${artifactPath}`],
      'Gradle bundletool manifest inspection',
      { cwd: projectRoot },
    );
  } finally {
    fs.rmSync(runnerDir, { recursive: true, force: true });
  }
}

function embeddedAppConfig() {
  const entryName = artifactType === '.aab' ? 'base/assets/app.config' : 'assets/app.config';
  let entry;
  try {
    entry = new AdmZip(artifactPath).getEntry(entryName);
  } catch (error) {
    throw new Error(`Unable to inspect embedded app.config: ${error.message}`);
  }
  if (!entry) throw new Error(`Android artifact is missing ${entryName}.`);
  try {
    return JSON.parse(entry.getData().toString('utf8'));
  } catch (error) {
    throw new Error(`Embedded app.config is not valid JSON: ${error.message}`);
  }
}

let manifest;
let permissions;
if (artifactType === '.aab') {
  manifest = bundletoolManifest();
  const signatureOutput = runRequired(
    'jarsigner',
    ['-verify', '-verbose', '-certs', artifactPath],
    'AAB signature verification',
    { env: { ...process.env, LC_ALL: 'C' } },
  );
  if (!signatureOutput.includes('>>> Signer') || /jar is unsigned/i.test(signatureOutput)) {
    throw new Error('AAB signature verification failed: no signer was found.');
  }
  permissions = [...manifest.matchAll(/<uses-permission\b[^>]*android:name=["']([^"']+)["']/g)]
    .map(match => match[1]);
} else {
  const permissionOutput = runAnalyzer(['manifest', 'permissions', artifactPath]);
  permissions = permissionOutput
    .split(/\r?\n/)
    .map(line => line.trim().split(/[\s']/)[0])
    .filter(Boolean);
}
const forbiddenFound = permissions.filter(permission => forbiddenPermissions.has(permission));

if (forbiddenFound.length > 0) {
  console.error(`Forbidden Android permissions: ${forbiddenFound.join(', ')}`);
  process.exit(1);
}

manifest = manifest || runAnalyzer(['manifest', 'print', artifactPath]);
const applicationTag = manifest.match(/<application\b[^>]*>/s)?.[0] ?? '';
if (!/android:allowBackup=["']false["']/.test(applicationTag)) {
  console.error('Android artifact must disable application data backup.');
  process.exit(1);
}

if (productionLike) {
  if (/android:usesCleartextTraffic=["']true["']/.test(applicationTag)) {
    console.error('Production-like Android artifact enables cleartext traffic.');
    process.exit(1);
  }
  try {
    validateEmbeddedAppConfig(embeddedAppConfig(), production ? 'production' : 'rehearsal');
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

console.log(`Android artifact policy passed: ${artifactPath}`);
console.log(`Permissions inspected: ${permissions.length}; mode=${production ? 'production' : rehearsal ? 'rehearsal' : 'internal'}`);
