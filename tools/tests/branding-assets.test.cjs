const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');
const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const { applySplashBranding } = require('../../plugins/withLaojiBranding');

function dimensions(file) {
  const png = fs.readFileSync(path.join(root, file));
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
}

test('launcher, monochrome, splash and credit have platform dimensions', () => {
  for (const file of ['icon', 'splash-icon', 'android-icon-background', 'android-icon-foreground', 'android-icon-monochrome']) {
    assert.deepEqual(dimensions(`assets/${file}.png`), [1024, 1024]);
  }
  assert.deepEqual(dimensions('assets/brand/splash-credit.png'), [800, 320]);
  assert.deepEqual(dimensions('assets/brand/mark.png'), [512, 512]);
});

test('adaptive mark corners fit Android safe circle; no photograph is bundled', () => {
  const image = PNG.sync.read(fs.readFileSync(path.join(root, 'assets/android-icon-foreground.png')));
  const mono = PNG.sync.read(fs.readFileSync(path.join(root, 'assets/android-icon-monochrome.png')));
  let opaquePixels = 0;
  let minX = image.width, minY = image.height, maxX = -1, maxY = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const offset = (y * image.width + x) * 4;
      if (image.data[offset + 3] === 0) continue;
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      assert.ok(Math.hypot(x + 0.5 - 512, y + 0.5 - 512) < 1024 * 33 / 108);
      assert.equal(mono.data[offset + 3], image.data[offset + 3]);
      assert.equal(mono.data[offset], 0);
      assert.equal(mono.data[offset + 1], 0);
      assert.equal(mono.data[offset + 2], 0);
      opaquePixels += 1;
    }
  }
  assert.ok(opaquePixels > 90_000, 'mark must not be empty or undersized');
  assert.equal(maxX - minX, maxY - minY, 'visible mark, not just its canvas, must remain square');
  const source = read('assets/brand/visionary-mark.svg');
  assert.equal((source.match(/<path /g) || []).length, 2);
  assert.ok(!source.includes('<image'));
  assert.ok(!source.includes('<filter'));
});

test('branding plugin is idempotent and preserves all other splash attributes', () => {
  const old = { $: { name: 'windowSplashScreenAnimatedIcon' }, _: '@drawable/splashscreen_logo' };
  const resources = { style: [{ $: { name: 'Theme.App.SplashScreen' }, item: [old] }] };
  applySplashBranding(resources);
  applySplashBranding(resources);
  const items = resources.style[0].item;
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], old);
  assert.equal(items[1]._, '@drawable/laoji_splash_credit');
});

test('native generation tracks branding and React startup adds no timed brand interstitial', () => {
  assert.ok(read('tools/android-build.cjs').includes("'assets/brand'"));
  const config = read('app.config.js');
  assert.ok(config.indexOf("'./plugins/withLaojiBranding'") < config.indexOf("['expo-splash-screen'"));
  const screen = read('src/components/AppStartupStateView.tsx');
  assert.ok(screen.includes("require('../../assets/brand/mark.png')"));
  assert.ok(screen.includes('created by visionary tech'));
  assert.ok(!screen.includes('setTimeout'));
  assert.ok(!screen.includes('正在打开老记'));
  const about = read('src/screens/LegalDocumentScreen.tsx');
  assert.ok(about.includes("require('../../assets/icon.png')"));
  assert.ok(!about.includes('name="calendar-clear-outline"'));
});

test('font theme does not replace the launch theme before splash installation', () => {
  const plugin = read('plugins/withLaojiNativePlatform.js');
  const themeHook = plugin.slice(plugin.indexOf("tag: 'laoji-themed-font-activity'"));
  assert.ok(themeHook.slice(0, 400).includes('super\\.onCreate\\(null\\)'));
  assert.ok(read('tools/android-build.cjs').includes('splashInstall < fontTheme && fontTheme < activityCreate'));
});
