const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function load(family) {
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/components/MeetingQuestionSheet.tsx'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.React, esModuleInterop: true,
  } }).outputText;
  const react = { createElement: (type, props, ...children) => ({ type, props, children }), useState: () => [false, () => {}] };
  const m = { exports: {} };
  new Function('require', 'module', 'exports', code + ';module.exports.probe={Text,QuestionTurnView,PendingQuestionView,styles};')(
    name => {
      if (name === 'react') return react;
      if (name === 'react-native') return { Text: 'native-text', StyleSheet: { create: x => x, hairlineWidth: 1 } };
      if (name.endsWith('/colors')) return { Appearance: { fontFamily: family } };
      if (name.endsWith('/ThemeProvider')) return { useTheme: () => ({ tokens: { colors: {} }, appearance: { fontFamily: family } }) };
      if (name.endsWith('/uiTokens')) return { getUiTokens: () => ({ colors: {} }) };
      return {};
    }, m, m.exports);
  return m.exports.probe;
}

for (const theme of ['Neutral', 'Vivid', 'Paper', 'Midnight']) {
  test(`Q&A ${theme} measures and renders all text with the same theme font`, () => {
    const family = `LaojiTheme${theme}`;
    const probe = load(family);
    const tree = probe.QuestionTurnView({ turn: { ordinal: 0, question: 'What is the final unit price?', answer: '二十元。', citations: [] } });
    let textCount = 0;
    const visit = node => {
      if (!node || typeof node !== 'object') return;
      if (node.type === probe.Text) {
        textCount++;
        const rendered = probe.Text(node.props);
        assert.equal(rendered.type, 'native-text');
        assert.equal(rendered.props.style[0].fontFamily, family);
      }
      node.children?.flat(Infinity).forEach(visit);
    };
    visit(tree);
    assert.equal(textCount, 2);
    visit(probe.PendingQuestionView({ question: '正在提交的完整问题' }));
    assert.equal(probe.styles.input.fontFamily, undefined, 'theme font is resolved at render, not captured in a module style');
    assert.equal(probe.styles.questionText.numberOfLines, undefined);
    assert.equal(probe.styles.questionBubble.height, undefined);
  });
}
