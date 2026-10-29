const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

function load(file, family, update) {
  const source = fs.readFileSync(path.resolve(__dirname, '../../', file), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.React, esModuleInterop: true,
  } }).outputText;
  const dependencies = {
    react: { createElement: (type, props, ...children) => ({ type, props, children }),
      useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}], useEffect() {}, useMemo: fn => fn() },
    'react-native': { Text: 'Text', View: 'View', StyleSheet: { create: x => x, hairlineWidth: 1 } },
    'expo-constants': { nativeAppVersion: '1.0.0' },
    '../theme/ThemeProvider': { useTheme: () => ({ themeId: 'neutral', tokens: { colors: {} }, appearance: { fontFamily: family } }) },
    '../theme/themeIds': { THEME_LABELS: { neutral: '标准' } },
    '../theme/uiTokens': { UI_DIMENSIONS: {}, UI_FONT_SIZES: {}, getUiTokens: () => ({ colors: {} }) },
    '../services/appUpdate': { currentVersionCode: () => 100, useAppUpdate: () => update },
    '../services/config': { getApiConfig: () => ({}) },
    '../components/AppDialog': { useAppDialog: () => ({}) },
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => dependencies[name] || {}, module, module.exports);
  return module.exports;
}
const flatten = styles => Object.assign({}, ...[styles].flat(Infinity).filter(Boolean));
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...(tree.children || []).flat(Infinity).flatMap(nodes)];
}
for (const theme of ['Neutral', 'Vivid', 'Paper', 'Midnight']) {
  test(`${theme}: settings version has one name and optional availability, not a duplicate build`, () => {
    for (const status of ['idle', 'available']) {
      const screen = load('src/screens/PrivacyScreen.tsx', `LaojiTheme${theme}`, {
        status, manifest: status === 'available' ? { version_code: 200 } : null,
      });
      const tree = nodes(screen.PrivacyScreen({ navigation: {} }));
      const row = tree.find(n => n.props?.testID === 'privacy-version-row');
      assert.equal((row.props.value.match(/1\.0\.0/g) || []).length, 1);
      assert.equal(row.props.value.includes('有更新'), status === 'available');
      assert.equal(/构建|100/.test(row.props.value), false);
      assert.equal(tree.filter(n => n.props?.testID === 'privacy-version-row').length, 1);
    }
  });
  test(`${theme}: update progress keeps one text owner with explicit measuring/drawing font`, () => {
    const family = `LaojiTheme${theme}`;
    for (const progress of [0, 0.01, 0.1, 0.37, 0.99, 1]) {
      const screen = load('src/screens/LegalDocumentScreen.tsx', family, {
        status: 'downloading', progress,
        manifest: { version_code: 200, version_name: '2.0.0', release_notes: ['优化更新下载。'] },
      });
      const tree = nodes(screen.LegalDocumentScreen({ route: { params: { kind: 'version' } }, navigation: {} }));
      const button = tree.find(n => n.props?.testID === 'legal-update-install');
      assert.equal(button.props.disabled, true);
      assert.equal(button.props.accessibilityLabel, `正在下载 ${Math.round(progress * 100)}%`);
      const labels = nodes(button).filter(n => n.type === 'Text');
      assert.equal(labels.length, 1);
      assert.equal(flatten(labels[0].props.style).fontFamily, family);
      assert.equal(tree.some(n => n.props?.testID === 'legal-check-update'), false);
      const version = tree.find(n => n.props?.testID === 'legal-about-version');
      assert.equal(flatten(version.props.style).fontFamily, family);
    }
    const row = load('src/components/SettingsGroup.tsx', family).SettingsRow({ label: '构建编号', value: '274' });
    const labels = nodes(row).filter(n => n.type === 'Text');
    assert.equal(labels.length, 2);
    for (const label of labels) assert.equal(flatten(label.props.style).fontFamily, family);
  });
}
