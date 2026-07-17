#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ts = require('typescript');

const EVIDENCE_ID = /^(?:CAL|MIN|UI)-[A-Z0-9-]+-[0-9]{3}$/;
const CONTROL_NAMES = new Set([
  'Button',
  'Pressable',
  'Switch',
  'TextInput',
  'TouchableHighlight',
  'TouchableNativeFeedback',
  'TouchableOpacity',
  'TouchableWithoutFeedback',
]);
const VISUAL_PROPERTIES = /^(?:width|height|minWidth|minHeight|maxWidth|maxHeight|padding|paddingHorizontal|paddingVertical|paddingTop|paddingBottom|paddingLeft|paddingRight|margin|marginHorizontal|marginVertical|marginTop|marginBottom|marginLeft|marginRight|gap|rowGap|columnGap|fontSize|lineHeight|borderRadius|borderWidth|elevation|shadowRadius|shadowOpacity|opacity|color|backgroundColor)$/;
const ANIMATION_NAMES = new Set([
  'Animated',
  'Easing',
  'LayoutAnimation',
  'useAnimatedStyle',
  'useSharedValue',
  'withDecay',
  'withSpring',
  'withTiming',
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function literalValue(expression) {
  if (expression && (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))) {
    return expression.text;
  }
  return null;
}

function evidenceFromAttributes(attributes) {
  for (const attribute of attributes.properties) {
    if (ts.isJsxAttribute(attribute)) {
      const name = attribute.name.getText();
      if (name !== 'feishuEvidence' && name !== 'nativeID') continue;
      if (attribute.initializer && ts.isStringLiteral(attribute.initializer)) {
        const raw = attribute.initializer.text;
        const parts = raw.startsWith('feishu:') ? raw.split(':').slice(1) : [raw];
        return { id: parts[0] || null, semanticKey: parts[1] || null };
      }
      if (attribute.initializer && ts.isJsxExpression(attribute.initializer)) {
        const expression = attribute.initializer.expression;
        const direct = literalValue(expression);
        if (direct) return { id: direct, semanticKey: null };
        if (expression && ts.isCallExpression(expression)) {
          const id = literalValue(expression.arguments[0]);
          const semanticKey = literalValue(expression.arguments[1]);
          if (id) return { id, semanticKey };
        }
      }
    }
    if (ts.isJsxSpreadAttribute(attribute) && ts.isCallExpression(attribute.expression)) {
      if (attribute.expression.expression.getText() !== 'feishuEvidence') continue;
      const id = literalValue(attribute.expression.arguments[0]);
      const semanticKey = literalValue(attribute.expression.arguments[1]);
      if (id) return { id, semanticKey };
    }
  }
  return null;
}

function scanSource(sourceText, fileName) {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const result = {
    controls: [],
    listeners: [],
    animations: [],
    visualConstants: [],
    routes: [],
    navigationCalls: [],
  };

  function visit(node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const component = node.tagName.getText(sourceFile);
      const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
      const propNames = attributes.map(attribute => attribute.name.getText());
      const listeners = propNames.filter(name => /^on[A-Z]/.test(name));
      const baseComponent = component.split('.').pop();
      if (CONTROL_NAMES.has(baseComponent) || listeners.length > 0) {
        const evidence = evidenceFromAttributes(node.attributes);
        const control = { component, line: lineOf(sourceFile, node), evidence, listeners };
        result.controls.push(control);
        for (const listener of listeners) {
          result.listeners.push({ component, prop: listener, line: control.line, evidence });
        }
      }

      if (component === 'Stack.Screen') {
        const nameAttribute = attributes.find(attribute => attribute.name.getText() === 'name');
        const componentAttribute = attributes.find(attribute => attribute.name.getText() === 'component');
        const routeName = nameAttribute && nameAttribute.initializer && ts.isStringLiteral(nameAttribute.initializer)
          ? nameAttribute.initializer.text
          : null;
        const routeComponent = componentAttribute
          && componentAttribute.initializer
          && ts.isJsxExpression(componentAttribute.initializer)
          ? componentAttribute.initializer.expression?.getText(sourceFile) || null
          : null;
        if (routeName) {
          result.routes.push({ name: routeName, component: routeComponent, line: lineOf(sourceFile, node) });
        }
      }
    }

    if (ts.isCallExpression(node)) {
      const expressionText = node.expression.getText(sourceFile);
      const rootName = expressionText.split('.')[0];
      if (ANIMATION_NAMES.has(rootName)) {
        result.animations.push({ expression: expressionText, line: lineOf(sourceFile, node) });
      }
      if (/\.navigate$/.test(expressionText)) {
        result.navigationCalls.push({
          route: literalValue(node.arguments[0]),
          expression: expressionText,
          line: lineOf(sourceFile, node),
        });
      }
    }

    if (ts.isPropertyAssignment(node) && VISUAL_PROPERTIES.test(node.name.getText(sourceFile))) {
      if (ts.isNumericLiteral(node.initializer) || ts.isStringLiteral(node.initializer)) {
        result.visualConstants.push({
          property: node.name.getText(sourceFile),
          value: node.initializer.text,
          line: lineOf(sourceFile, node),
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return result;
}

function activeAndroidTsxFiles(repoRoot) {
  const srcRoot = path.join(repoRoot, 'src');
  const files = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.name.endsWith('.tsx')) files.push(absolute);
    }
  }
  walk(srcRoot);
  const rootApp = path.join(repoRoot, 'App.tsx');
  if (fs.existsSync(rootApp)) files.push(rootApp);
  const androidBases = new Set(
    files
      .filter(file => file.endsWith('.android.tsx'))
      .map(file => file.replace(/\.android\.tsx$/, '.tsx')),
  );
  return files
    .filter(file => file.endsWith('.android.tsx') || !androidBases.has(file))
    .sort();
}

function runAudit(repoRoot) {
  const scannerSource = fs.readFileSync(__filename, 'utf8');
  const manifestPath = path.join(repoRoot, 'evidence/feishu/manifest.json');
  const manifestSource = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestSource);
  const productScopePath = path.join(repoRoot, manifest.product_scope);
  const productScopeSource = fs.readFileSync(productScopePath, 'utf8');
  const productScope = JSON.parse(productScopeSource);
  const knownEvidence = new Set(manifest.evidence.map(entry => entry.id));
  const files = activeAndroidTsxFiles(repoRoot).map(absolute => {
    const relative = path.relative(repoRoot, absolute).split(path.sep).join('/');
    const source = fs.readFileSync(absolute, 'utf8');
    return { path: relative, sourceSha256: sha256(source), ...scanSource(source, relative) };
  });
  const errors = [];

  for (const file of files) {
    const semanticKeys = new Set();
    for (const control of file.controls) {
      if (!control.evidence || !EVIDENCE_ID.test(control.evidence.id || '')) {
        errors.push({
          code: 'TS_CONTROL_UNMAPPED',
          path: file.path,
          line: control.line,
          component: control.component,
        });
        continue;
      }
      if (!knownEvidence.has(control.evidence.id)) {
        errors.push({
          code: 'TS_EVIDENCE_UNKNOWN',
          path: file.path,
          line: control.line,
          evidenceId: control.evidence.id,
        });
      }
      if (!control.evidence.semanticKey) {
        errors.push({
          code: 'TS_SEMANTIC_KEY_MISSING',
          path: file.path,
          line: control.line,
          evidenceId: control.evidence.id,
        });
      } else if (semanticKeys.has(control.evidence.semanticKey)) {
        errors.push({
          code: 'TS_SEMANTIC_KEY_DUPLICATE',
          path: file.path,
          line: control.line,
          semanticKey: control.evidence.semanticKey,
        });
      } else {
        semanticKeys.add(control.evidence.semanticKey);
      }
    }
  }

  const routeMap = new Map();
  for (const file of files) {
    for (const route of file.routes) {
      const existing = routeMap.get(route.name);
      if (existing && existing.component !== route.component) {
        errors.push({ code: 'TS_ROUTE_DUPLICATE_OWNER', route: route.name });
      } else {
        routeMap.set(route.name, { ...route, path: file.path });
      }
    }
  }
  const expectedRoutes = new Set(productScope.root_routes);
  for (const route of [...expectedRoutes].filter(value => !routeMap.has(value)).sort()) {
    errors.push({ code: 'TS_ROUTE_MISSING', route });
  }
  for (const route of [...routeMap.keys()].filter(value => !expectedRoutes.has(value)).sort()) {
    errors.push({ code: 'TS_ROUTE_UNAPPROVED', route });
  }

  return {
    schemaVersion: 1,
    kind: 'typescript-ast',
    scanner: {
      path: path.relative(repoRoot, __filename).split(path.sep).join('/'),
      sha256: sha256(scannerSource),
      typescriptVersion: ts.version,
    },
    manifest: {
      path: 'evidence/feishu/manifest.json',
      sha256: sha256(manifestSource),
    },
    productScope: {
      path: path.relative(repoRoot, productScopePath).split(path.sep).join('/'),
      sha256: sha256(productScopeSource),
    },
    files,
    routes: [...routeMap.values()].sort((left, right) => left.name.localeCompare(right.name)),
    errors,
  };
}

function main() {
  const command = process.argv[2];
  if (!['check', 'report'].includes(command)) {
    console.error('usage: feishu_ui_ast_gate.js <check|report> [--output path]');
    process.exit(2);
  }
  const repoRoot = path.resolve(__dirname, '..');
  const result = runAudit(repoRoot);
  const outputIndex = process.argv.indexOf('--output');
  if (outputIndex >= 0) {
    const output = path.resolve(repoRoot, process.argv[outputIndex + 1]);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  }
  if (command === 'report') {
    console.log(JSON.stringify({
      files: result.files.length,
      controls: result.files.reduce((sum, file) => sum + file.controls.length, 0),
      listeners: result.files.reduce((sum, file) => sum + file.listeners.length, 0),
      animations: result.files.reduce((sum, file) => sum + file.animations.length, 0),
      visualConstants: result.files.reduce((sum, file) => sum + file.visualConstants.length, 0),
      routes: result.routes.length,
      errors: result.errors.length,
    }));
    return;
  }
  for (const error of result.errors) {
    console.error(`ERROR ${error.code}: ${JSON.stringify(error)}`);
  }
  if (result.errors.length) process.exit(1);
  console.log(`Feishu TypeScript AST gate passed (${result.files.length} active Android TSX files).`);
}

module.exports = { activeAndroidTsxFiles, scanSource, runAudit, sha256 };
if (require.main === module) main();
