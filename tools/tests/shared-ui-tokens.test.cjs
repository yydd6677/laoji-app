const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('shared token check is read-only and rejects an isolated stale Android output', () => {
  const root = path.resolve(__dirname, '../..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'laoji-tokens-'));
  const files = ['tools/generate-ui-tokens.cjs', 'design-system/tokens/core.tokens.json',
    'src/theme/generatedUiTokens.ts',
    'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/ui/GeneratedUiTokens.kt'];
  try {
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(temp, file)), { recursive: true });
      fs.copyFileSync(path.join(root, file), path.join(temp, file));
    }
    const check = () => spawnSync(process.execPath, [path.join(temp, files[0]), '--check'], { encoding: 'utf8' });
    const clean = check(); assert.equal(clean.status, 0, clean.stderr);
    const target = path.join(temp, files[3]);
    const broken = fs.readFileSync(target, 'utf8').replace('dimension_iconTarget = 48.0f', 'dimension_iconTarget = 32.0f');
    assert.ok(broken.includes('dimension_iconTarget = 32.0f'));
    fs.writeFileSync(target, broken);
    const failure = check();
    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /Outdated generated UI tokens.*GeneratedUiTokens/);
    assert.equal(fs.readFileSync(target, 'utf8'), broken, '--check must not repair its own failure');
    fs.copyFileSync(path.join(root, files[3]), target);
    const source = path.join(temp, files[1]);
    const tokens = JSON.parse(fs.readFileSync(source, 'utf8'));
    tokens.palette.paper.primary.$value = '#123456';
    fs.writeFileSync(source, JSON.stringify(tokens));
    assert.equal(check().status, 1, 'a palette edit must invalidate both generated owners');
    const generated = spawnSync(process.execPath, [path.join(temp, files[0])], { encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr);
    const jsModule = { exports: {} };
    const ts = require('typescript');
    new Function('exports', ts.transpileModule(fs.readFileSync(path.join(temp, files[2]), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText)(jsModule.exports);
    assert.equal(jsModule.exports.GENERATED_PALETTES.paper.primary, '#123456');
    assert.match(fs.readFileSync(target, 'utf8'), /private val paperPalette = ThemePalette\([\s\S]*?primary = 0xff123456.toInt\(\)/);
    assert.equal(check().status, 0);
    const valid = fs.readFileSync(target, 'utf8');
    tokens.palette.paper.primary.$value = 'rgba(256,0,0,0.5)';
    fs.writeFileSync(source, JSON.stringify(tokens));
    const invalid = spawnSync(process.execPath, [path.join(temp, files[0])], { encoding: 'utf8' });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /Invalid RGB color/);
    assert.equal(fs.readFileSync(target, 'utf8'), valid, 'invalid colors cannot partially replace generated native output');
  } finally { fs.rmSync(temp, { recursive: true }); }
});
