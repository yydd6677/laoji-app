const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const React = require('react');
const { act, create } = require('react-test-renderer');
global.IS_REACT_ACT_ENVIRONMENT = true;

function fixture() {
  const host = name => React.forwardRef((props, ref) => React.createElement(name, { ...props, ref }));
  const animationEvents = [];
  class Value { setValue(value) { animationEvents.push({ setValue: value }); } stopAnimation() {} interpolate() { return 0; } }
  const rn = {
    View: host('view'), Text: host('text'), TextInput: host('input'), Image: host('image'), Modal: host('modal'),
    KeyboardAvoidingView: host('keyboard-host'),
    TouchableOpacity: host('button'), Pressable: host('pressable'), ScrollView: host('scroll'),
    Animated: { Value, Text: host('animated-text'), View: host('animated-view'), timing: (_, config) => {
      animationEvents.push({ timing: config.toValue });
      return { start: fn => fn?.({ finished: true }) };
    } },
    Easing: { inOut: value => value, in: value => value, out: value => value, ease: {}, cubic: {}, quad: {} },
    BackHandler: { addEventListener: () => ({ remove() {} }) },
    Platform: { OS: 'android' }, Keyboard: { dismiss() {}, addListener: () => ({ remove() {} }) },
    StyleSheet: { create: value => value, absoluteFill: {}, absoluteFillObject: {} },
    useWindowDimensions: () => ({ width: 400, height: 800 }),
  };
  let theme;
  const setTheme = id => {
    const colors = Object.fromEntries(['primary', 'green', 'orange', 'red', 'text', 'sub', 'faint',
      'disabled', 'body', 'card', 'inputBg', 'overlay', 'divider'].map(key => [key, `${id}:${key}`]));
    theme = { colors, appearance: { fontFamily: `font:${id}`, titleFontFamily: `font:${id}`,
      surfaceMode: { neutral: 'flat', vivid: 'soft', paper: 'editorial', midnight: 'layered' }[id],
      cardRadius: id === 'vivid' ? 16 : 10, borderWidth: id === 'vivid' ? 1 : 0,
      elevation: id === 'vivid' ? 1 : 0,
      titleLetterSpacing: 0, iconRadius: 6,
      motionScale: { neutral: 1, vivid: 1.12, paper: 0.96, midnight: 0.9 }[id] }, reduceMotion: false };
    theme.tokens = { colors: Object.fromEntries(['backgroundFloat', 'backgroundBase', 'backgroundMask',
      'backgroundBody', 'textTitle', 'textCaption', 'textPlaceholder', 'divider', 'primary', 'primaryPressed',
      'primarySoft', 'iconPrimary', 'iconSecondary', 'iconTertiary', 'danger', 'onPrimary'].map(key => [key, `${id}:${key}`])) };
  };
  setTheme('neutral');
  const load = file => {
    const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../src/components', file), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true },
    }).outputText;
    const m = { exports: {} };
    new Function('require', 'module', 'exports', code)(name => {
      if (name === 'react') return React;
      if (name === 'react-native') return rn;
      if (name.endsWith('/ThemeProvider')) return { useTheme: () => theme };
      if (name.endsWith('/colors')) return {
        Colors: theme.colors, Motion: { fast: 120, standard: 180, panel: 240 },
        getColorsForTheme: id => new Proxy({}, { get: (_, key) => `${id}:${String(key)}` }),
        getThemeAppearance: id => ({ cardRadius: 10, motionScale: 1, titleLetterSpacing: 0,
          surfaceMode: { neutral: 'flat', vivid: 'soft', paper: 'editorial', midnight: 'layered' }[id] }),
      };
      if (name.endsWith('/themeIds')) {
        const ids = { exports: {} };
        const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../src/theme/themeIds.ts'), 'utf8'), {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText;
        new Function('exports', code)(ids.exports);
        return ids.exports;
      }
      if (name.endsWith('/typography')) return { getThemeFontFamily: id => `font:${id}` };
      if (name.endsWith('/uiTokens')) return { UI_DIMENSIONS: { divider: 0.5 }, UI_FONT_SIZES: { body0: 16, body1: 14 } };
      if (name === 'react-native-safe-area-context') return { useSafeAreaInsets: () => ({ bottom: 0 }) };
      if (name === '@expo/vector-icons/Ionicons') return host('icon');
      if (name === '@react-native-community/datetimepicker') return host('date-picker');
      if (name.endsWith('/eventIdentity')) return { eventRefKey: ref => ref.eventId, eventRefForEvent: event => ({ eventId: event.id }) };
      if (name === 'react-native-svg') return { __esModule: true, default: host('svg'), Circle: host('circle'), Path: host('path') };
      if (name === './MotionPressable') return { MotionPressable: host('motion-button') };
      if (name === './AppShell') return { AppTitleBar: host('title-bar') };
      throw new Error(`Unmocked dependency: ${name}`);
    }, m, m.exports);
    return m.exports;
  };
  return { setTheme, load, animationEvents };
}
const style = node => Object.assign({}, ...[node.props.style].flat(Infinity).filter(Boolean));
const byId = (root, type, id) => root.root.findAll(node => node.type === type && node.props.testID === id).at(0);

test('classification empty states distinguish missing tags from tags with no assigned meetings', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/screens/MeetingOrganizationScreen.tsx'), 'utf8');
  const file = ts.createSourceFile('MeetingOrganizationScreen.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let owner;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'renderState') owner = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(owner);
  const code = ts.transpileModule(`const render = ${owner.getText(file)};`, {
    compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
  }).outputText + '\nreturn render();';
  const render = (mode, tags, loading = false, error = '') => new Function(
    'React', 'View', 'Text', 'ActivityIndicator', 'Ionicons', 'Pressable', 'styles', 'F', 'groups', 'mode', 'tags', 'loading', 'error', 'load', code,
  )(React, 'view', 'text', 'spinner', 'icon', 'button', {}, {}, [], mode, tags, loading, error, () => {});
  const text = node => Array.isArray(node) ? node.flatMap(text)
    : React.isValidElement(node) ? text(node.props.children)
      : typeof node === 'string' ? [node] : [];
  assert.deepEqual(text(render('people', [{}])), ['暂无可归类的人物']);
  assert.deepEqual(text(render('tags', [])), ['暂无标签']);
  assert.deepEqual(text(render('tags', [{}])), ['暂无已标记的会议']);
  assert.deepEqual(text(render('tags', [{}], true)), []);
  assert.deepEqual(text(render('tags', [{}], false, '分类暂时无法读取')), ['分类暂时无法读取', '重试']);
});

test('emptying the bin confirms destruction once and lets the refreshed list own success', async () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/screens/MeetingListScreen.android.tsx'), 'utf8');
  const file = ts.createSourceFile('MeetingListScreen.android.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let owner;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'confirmEmptyRecycleBin') owner = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(owner);
  const code = ts.transpileModule(`const confirm = ${owner.getText(file)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText + '\nreturn confirm;';
  for (const fails of [false, true]) {
    const dialogs = [], deletions = [], busy = [], refresh = [];
    const running = { current: false };
    const confirm = new Function('retentionDays', 'recycleBinEntries', 'recycleBinLoading', 'recycleBinError',
      'restoringMeetingId', 'permanentlyDeletingMeetingId', 'recycleBinEmptyingRef', 'showDialog',
      'setRecycleBinEmptying', 'permanentlyDeleteDeletedMeeting', 'refreshRecycleBin', code)(
      30, [{ meetingId: 'own' }, { meetingId: 'own' }], false, '', null, null, running,
      value => dialogs.push(value), value => busy.push(value), async id => {
        deletions.push(id); if (fails) throw Error('cannot delete');
      }, async value => { refresh.push(value); return true; },
    );
    confirm();
    assert.equal(dialogs.length, 1);
    assert.equal(deletions.length, 0, 'destruction waits for the user confirmation');
    assert.ok(dialogs[0].actions.some(action => action.role === 'cancel'));
    await dialogs[0].actions.find(action => action.role === 'destructive').onPress();
    assert.deepEqual(deletions, ['own']);
    assert.deepEqual(refresh, [false]);
    assert.deepEqual(busy, [true, false]);
    assert.equal(running.current, false);
    assert.equal(dialogs.length, fails ? 2 : 1, 'success cannot create an acknowledgement-only second modal');
    if (fails) assert.equal(dialogs[1].tone, 'warning');
  }
});

test('settings groups retain their layout footprint while skin surfaces change', async () => {
  const f = fixture();
  const { SettingsGroup } = f.load('SettingsGroup.tsx');
  const tree = () => React.createElement(SettingsGroup, { testID: 'existing-group' }, React.createElement('existing-row'));
  let root;
  await act(async () => { root = create(tree()); });
  try {
    const group = byId(root, 'view', 'existing-group');
    const row = group.findByType('existing-row');
    const footprint = node => Object.fromEntries(['marginTop', 'marginHorizontal', 'borderWidth',
      'borderTopWidth', 'borderBottomWidth'].map(key => [key, style(node)[key]]));
    const expected = footprint(group);
    for (const skin of ['vivid', 'paper', 'midnight', 'neutral']) {
      f.setTheme(skin); await act(async () => root.update(tree()));
      assert.equal(byId(root, 'view', 'existing-group'), group);
      assert.deepEqual(footprint(group), expected);
      assert.equal(group.findByType('existing-row'), row);
      assert.equal(style(group).elevation ?? 0, 0, 'clipped settings groups stay in the content drawing plane');
    }
    assert.equal(style(group).borderColor, 'transparent');
  } finally { await act(async () => root.unmount()); }
});

test('applying a skin updates the existing provider tree without any runtime restart', async () => {
  const file = path.resolve(__dirname, '../../src/theme/ThemeProvider.tsx');
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText;
  const saved = [];
  const m = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => {
    if (name === 'react') return React;
    if (name === 'react-native') return { View: 'view', ActivityIndicator: 'spinner', AccessibilityInfo: {
      isReduceMotionEnabled: async () => false, addEventListener: () => ({ remove() {} }),
    } };
    if (name.endsWith('/colors')) return {
      Colors: {}, getColorsForTheme: id => ({ primary: `${id}:primary` }),
      getThemeAppearance: id => ({ fontFamily: `font:${id}` }),
    };
    if (name.endsWith('/uiTokens')) return { getUiTokens: (_, id) => ({ colors: { primary: `${id}:primary` } }) };
    if (name.endsWith('/themeIds')) return { DEFAULT_THEME_ID: 'neutral' };
    if (name.endsWith('/nativeTheme')) return new Proxy({ getSynchronousThemeId: () => 'paper' }, {
      get: (target, key) => {
        assert.notEqual(key, 'restartNativeActivity', 'a skin update must not own the app lifecycle');
        return target[key];
      },
    });
    if (name.endsWith('/themePreferences')) return {
      loadThemePreference: async () => 'paper', saveThemePreference: async id => { saved.push(id); },
    };
    throw Error(`Unmocked provider dependency: ${name}`);
  }, m, m.exports);
  let current, setDraft, mounts = 0, unmounts = 0;
  function ExistingRoute() {
    current = m.exports.useTheme();
    const [draft, update] = React.useState('周五读书交流'); setDraft = update;
    React.useEffect(() => { mounts++; return () => { unmounts++; }; }, []);
    return React.createElement('route', { name: '会议', draft, fontFamily: current.appearance.fontFamily });
  }
  let root;
  await act(async () => { root = create(React.createElement(m.exports.ThemeProvider, {}, React.createElement(ExistingRoute))); });
  try {
    const route = root.root.findByType('route');
    await act(async () => setDraft('保留输入中的日程草稿'));
    for (const skin of ['vivid', 'midnight', 'neutral', 'paper']) {
      await act(async () => current.setTheme(skin));
      assert.equal(root.root.findByType('route'), route);
      assert.equal(route.props.name, '会议'); assert.equal(route.props.draft, '保留输入中的日程草稿');
      assert.equal(route.props.fontFamily, `font:${skin}`);
      assert.equal(current.colors.primary, `${skin}:primary`);
      assert.equal(current.tokens.colors.primary, `${skin}:primary`);
      assert.equal(mounts, 1); assert.equal(unmounts, 0);
    }
    assert.deepEqual(saved, ['vivid', 'midnight', 'neutral', 'paper']);
    for (const file of ['src/theme/nativeTheme.ts', 'modules/laoji-native-platform/src/index.ts',
      'modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/LaojiNativePlatformModule.kt',
      'plugins/withLaojiNativePlatform.js']) {
      const source = fs.readFileSync(path.resolve(__dirname, '../..', file), 'utf8');
      assert.doesNotMatch(source, /restartActivity|reloadReactRuntime|THEME_RECREATE/);
    }
  } finally { await act(async () => root.unmount()); }
});

test('theme gallery header follows the current font while previews keep their own skin fonts and selection', async () => {
  const f = fixture();
  const { ThemePickerSheet } = f.load('ThemePickerSheet.tsx');
  let selected = 'neutral';
  const tree = () => React.createElement(ThemePickerSheet, { visible: true, selected, onSelect() {}, onClose() {} });
  let root;
  await act(async () => { root = create(tree()); });
  try {
    const title = root.root.findAllByType('text').find(node => node.props.children === '主题');
    const panel = byId(root, 'animated-view', 'theme-picker-sheet');
    const openedAnimation = [...f.animationEvents];
    for (const id of ['neutral', 'vivid', 'paper', 'midnight']) {
      f.setTheme(id); selected = id;
      await act(async () => root.update(tree()));
      assert.equal(root.root.findAllByType('text').find(node => node.props.children === '主题'), title);
      assert.equal(style(title).fontFamily, `font:${id}`);
      assert.equal(byId(root, 'animated-view', 'theme-picker-sheet'), panel);
      assert.deepEqual(f.animationEvents, openedAnimation, 'selecting a skin must not restart the open panel entrance');
      const cards = root.root.findAll(node => node.type === 'motion-button' && node.props.accessibilityRole === 'radio');
      assert.equal(cards.length, 4);
      assert.equal(cards.filter(node => node.props.accessibilityState.selected).length, 1);
      assert.equal(cards.find(node => node.props.accessibilityState.selected).props.testID, `theme-option-${id}`);
      for (const card of cards) {
        const ownId = card.props.testID.replace('theme-option-', '');
        assert.ok(card.findAllByType('text').every(node => style(node).fontFamily === `font:${ownId}`));
      }
    }
  } finally { await act(async () => root.unmount()); }
});

test('an open menu and checked switch adopt every theme without replacing controls or changing geometry', async () => {
  const f = fixture();
  const { AppActionSheet } = f.load('AppActionSheet.tsx');
  const { CalendarSwitch } = f.load('CalendarSwitch.tsx');
  const tree = () => React.createElement(React.Fragment, {},
    React.createElement(AppActionSheet, { visible: true, title: '会议操作', items: [{ key: 'delete', label: '删除', onPress() {} }], onClose() {} }),
    React.createElement(CalendarSwitch, { checked: true, onChange() {}, accessibilityLabel: '提醒', testID: 'switch' }));
  let root;
  await act(async () => { root = create(tree()); });
  try {
    const panel = byId(root, 'view', 'app-action-sheet-panel');
    const control = byId(root, 'button', 'switch');
    const bounds = style(control);
    for (const id of ['neutral', 'vivid', 'paper', 'midnight']) {
      f.setTheme(id);
      await act(async () => root.update(tree()));
      assert.equal(byId(root, 'view', 'app-action-sheet-panel'), panel);
      assert.equal(style(panel).backgroundColor, `${id}:body`);
      assert.equal(style(byId(root, 'text', 'app-action-sheet-title')).fontFamily, `font:${id}`);
      assert.equal(byId(root, 'button', 'switch'), control);
      assert.deepEqual(style(control), bounds);
      assert.equal(control.props.accessibilityState.checked, true);
      assert.equal(style(byId(root, 'view', 'switch-track')).backgroundColor, `${id}:primary`);
      assert.equal(style(byId(root, 'animated-view', 'switch-thumb')).backgroundColor, `${id}:body`);
    }
  } finally { await act(async () => root.unmount()); }
});

test('an open media import retains the edited title and chosen event while all sheet text adopts the skin', async () => {
  const f = fixture();
  const { MeetingImportSheet } = f.load('MeetingImportSheet.tsx');
  const event = { id: 'read', title: '读书讨论会', startDate: '2026-10-28', startTime: '15:00' };
  let validationError = null;
  const props = { visible: true, requestKey: 'one-file', fileName: '讨论录音.m4a', mimeType: 'audio/mp4', byteSize: 2048,
    initialTitle: '讨论录音', initialRecordedAtMs: new Date('2026-10-28T15:00:00').getTime(),
    events: [event], meetings: [], allowExistingMeeting: false, onClose() {}, onValidate: async () => validationError, onImport() {} };
  let root;
  await act(async () => { root = create(React.createElement(MeetingImportSheet, props)); });
  const button = label => {
    const buttons = root.root.findAll(node => node.type === 'pressable');
    const match = buttons.find(node => node.props.accessibilityLabel === label);
    assert.ok(match, `Missing ${label}; present: ${buttons.map(node => node.props.accessibilityLabel).join(' / ')}`);
    return match;
  };
  try {
    await act(async () => root.root.findByType('input').props.onChangeText('十月读书讨论'));
    await act(async () => button('关联日程，不关联').props.onPress());
    await act(async () => button('读书讨论会，10月28日 15:00').props.onPress());
    // Choosing a nested page intentionally unmounts the form; retheming the
    // same form must not. Both must preserve the draft value.
    const field = root.root.findByType('input');
    assert.equal(field.props.value, '十月读书讨论');
    for (const id of ['neutral', 'vivid', 'paper', 'midnight', 'neutral']) {
      f.setTheme(id);
      await act(async () => root.update(React.createElement(MeetingImportSheet, props)));
      assert.ok(root.root.findByType('input') === field, 'theme cannot replace the editable owner');
      assert.equal(field.props.value, '十月读书讨论');
      assert.equal(style(field).fontFamily, `font:${id}`);
      assert.equal(style(field).color, `${id}:textTitle`);
      assert.ok(button('关联日程，读书讨论会'), 'selection survives the same theme change');
      for (const text of root.root.findAllByType('text')) assert.equal(style(text).fontFamily, `font:${id}`);
    }
    const heading = byId(root, 'text', 'meeting-import-heading');
    const submit = button('导入会议录音');
    validationError = '该会议正在录音，请稍后再试';
    await act(async () => { submit.props.onPress(); });
    assert.ok(byId(root, 'text', 'meeting-import-heading') === heading);
    assert.ok(button('导入会议录音') === submit);
    assert.equal(heading.props.children, validationError);
    assert.equal(root.root.findAll(node => node.type === 'text' && node.props.children === validationError).length, 1);
    assert.equal(field.props.value, '十月读书讨论');
  } finally { await act(async () => root.unmount()); }
});

test('an existing dialog keeps its state and action while palette and font update', async () => {
  const f = fixture();
  const { AppDialogProvider, useAppDialog } = f.load('AppDialog.tsx');
  let dialog;
  function Owner() { dialog = useAppDialog(); return null; }
  const tree = () => React.createElement(AppDialogProvider, {}, React.createElement(Owner));
  let root;
  await act(async () => { root = create(tree()); });
  try {
    await act(async () => dialog.showDialog({ title: '删除录音', actions: [{ text: '删除', role: 'destructive' }] }));
    const card = byId(root, 'animated-view', 'app-dialog-card');
    const action = byId(root, 'button', 'app-dialog-action-0');
    for (const id of ['neutral', 'vivid', 'paper', 'midnight']) {
      f.setTheme(id);
      await act(async () => root.update(tree()));
      assert.equal(byId(root, 'animated-view', 'app-dialog-card'), card);
      assert.equal(style(card).backgroundColor, `${id}:card`);
      assert.equal(byId(root, 'button', 'app-dialog-action-0'), action);
      assert.equal(action.props.disabled, false);
      const label = action.findByType('text');
      assert.equal(label.props.children, '删除');
      assert.equal(style(label).fontFamily, `font:${id}`);
      assert.equal(style(label).color, `${id}:red`);
    }
  } finally { await act(async () => root.unmount()); }
});

test('shared calendar and meeting title bars update in place instead of capturing the initial skin', async () => {
  const f = fixture();
  const { BackHeader } = f.load('Common.tsx');
  const { MinutesDetailTitleBar } = f.load('MinutesDetailTitleBar.tsx');
  const { CommonTextTitleBar, CalendarDetailTitleBar } = f.load('CalendarTitleBar.tsx');
  const tree = () => React.createElement(React.Fragment, {},
    React.createElement(BackHeader, { title: '录音', onBack() {} }),
    React.createElement(MinutesDetailTitleBar, { title: '项目进展', onBack() {}, onMore() {} }),
    React.createElement(CommonTextTitleBar, { title: '日期', onLeft() {}, testID: 'date-title' }),
    React.createElement(CalendarDetailTitleBar, { title: '读书讨论会', onBack() {} }));
  let root;
  await act(async () => { root = create(tree()); });
  try {
    const header = byId(root, 'view', 'app-back-header');
    const backTitle = byId(root, 'text', 'app-back-title');
    const metrics = { height: style(header).height, fontSize: style(backTitle).fontSize };
    for (const id of ['neutral', 'vivid', 'paper', 'midnight']) {
      f.setTheme(id);
      await act(async () => root.update(tree()));
      assert.equal(byId(root, 'view', 'app-back-header'), header);
      assert.equal(byId(root, 'text', 'app-back-title'), backTitle);
      assert.equal(style(header).backgroundColor, `${id}:body`);
      assert.equal(style(backTitle).fontFamily, `font:${id}`);
      assert.equal(style(byId(root, 'text', 'date-title-title')).fontFamily, `font:${id}`);
      assert.equal(style(byId(root, 'animated-text', 'calendar-detail-collapsed-title')).color, `${id}:text`);
      assert.deepEqual({ height: style(header).height, fontSize: style(backTitle).fontSize }, metrics);
      assert.ok(root.root.findAll(node => node.type === 'text' && node.props.children === '项目进展')
        .every(node => style(node).fontFamily === `font:${id}`));
    }
  } finally { await act(async () => root.unmount()); }
});
