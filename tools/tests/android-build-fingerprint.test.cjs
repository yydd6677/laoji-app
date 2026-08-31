const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  nativeProjectGenerationState,
  writeNativeInputsMarker,
} = require('../android-build.cjs');

const generatedFiles = [
  'gradlew',
  'settings.gradle',
  'app/build.gradle',
  'app/src/main/AndroidManifest.xml',
  'app/src/main/java/com/laoji/app/MainActivity.kt',
  'app/src/main/java/com/laoji/app/MainApplication.kt',
];

function write(root, relativePath, contents = '') {
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, contents);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'laoji-native-fingerprint-'));
  write(root, 'app.config.js', 'module.exports = { version: "1.0.0" };\n');
  write(root, 'package.json', '{"name":"laoji-test","version":"1.0.0"}\n');
  write(root, 'package-lock.json', '{"lockfileVersion":3}\n');
  write(root, 'plugins/native.js', 'module.exports = value => value;\n');
  write(root, 'modules/laoji-native-platform/package.json', '{"name":"laoji-native-platform"}\n');
  write(root, 'modules/laoji-native-platform/expo-module.config.json', '{}\n');
  write(root, 'modules/laoji-native-platform/android/src/main/Test.kt', 'class Test\n');
  write(root, 'assets/fonts/theme/font.ttf', 'font-v1');
  for (const relativePath of generatedFiles) write(root, `android/${relativePath}`, 'generated\n');
  return root;
}

test('matching fingerprint reuses the generated Android tree', t => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { APP_ENV: 'development', EXPO_ALLOW_CLEARTEXT: 'true' };
  writeNativeInputsMarker(root, env);

  const state = nativeProjectGenerationState(root, env);
  assert.equal(state.rebuild, false);
  assert.equal(state.reason, 'native_inputs_match');
});

test('an old marker schema triggers clean prebuild', t => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { APP_ENV: 'development' };
  writeNativeInputsMarker(root, env);
  const markerPath = path.join(root, 'android/.laoji-native-inputs.json');
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  marker.schema = 0;
  fs.writeFileSync(markerPath, `${JSON.stringify(marker)}\n`);

  const state = nativeProjectGenerationState(root, env);
  assert.equal(state.rebuild, true);
  assert.equal(state.reason, 'marker_schema_changed');
});

test('a native source input change triggers clean prebuild', t => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { APP_ENV: 'development' };
  writeNativeInputsMarker(root, env);
  write(root, 'plugins/native.js', 'module.exports = value => ({ ...value, changed: true });\n');

  const state = nativeProjectGenerationState(root, env);
  assert.equal(state.rebuild, true);
  assert.equal(state.reason, 'native_inputs_changed');
});
