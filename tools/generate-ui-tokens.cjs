#!/usr/bin/env node
// Small supported DTCG subset, not a general-purpose token compiler. No network
// or platform shell dependencies; --check never changes the workspace.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const sourcePath = 'design-system/tokens/core.tokens.json';
const source = fs.readFileSync(path.join(root, sourcePath), 'utf8');
const fingerprint = crypto.createHash('sha256').update(source).digest('hex');
const groups = JSON.parse(source);
const check = process.argv.includes('--check');
if (process.argv.slice(2).some(arg => arg !== '--check')) throw Error('Only --check is supported');
const outputs = {};
const constants = {};
const palettes = {};
for (const [theme, tokens] of Object.entries(groups.palette ?? {})) {
  if (theme.startsWith('$')) continue;
  if (tokens.$type !== 'color') throw Error(`Invalid palette ${theme}`);
  palettes[theme] = {};
  for (const [name, token] of Object.entries(tokens)) {
    if (name.startsWith('$')) continue;
    const value = token.$value;
    if (!/^#[0-9a-f]{6}$/i.test(value) && !/^rgba\(\d{1,3},\d{1,3},\d{1,3},(?:0(?:\.\d+)?|1)\)$/.test(value)) {
      throw Error(`Unsupported color ${theme}.${name}`);
    }
    palettes[theme][name] = value;
  }
}
if (Object.keys(palettes).sort().join() !== 'midnight,neutral,paper,vivid') throw Error('Theme palette coverage changed');
const colorKeys = Object.keys(palettes.neutral);
for (const [theme, values] of Object.entries(palettes)) {
  if (Object.keys(values).sort().join() !== [...colorKeys].sort().join()) throw Error(`Incomplete palette ${theme}`);
}
function androidColor(value) {
  if (value.startsWith('#')) return `0xff${value.slice(1).toLowerCase()}.toInt()`;
  const channels = value.slice(5, -1).split(',').map(Number);
  if (channels.slice(0, 3).some(c => c < 0 || c > 255)) throw Error(`Invalid RGB color ${value}`);
  return `0x${[Math.round(channels[3] * 255), ...channels.slice(0, 3)].map(c => c.toString(16).padStart(2, '0')).join('')}.toInt()`;
}
for (const [group, tokens] of Object.entries(groups)) {
  if (group.startsWith('$') || group === 'palette') continue;
  const type = tokens.$type;
  const values = {};
  for (const [name, token] of Object.entries(tokens)) {
    if (name.startsWith('$')) continue;
    const value = token.$value;
    if (type === 'fontFamily' && typeof value === 'string' && /^[A-Za-z0-9]+$/.test(value)) values[name] = value;
    else if ((type === 'dimension' || type === 'duration') && Number.isFinite(value?.value)
      && value.value >= 0 && value.unit === (type === 'duration' ? 'ms' : 'px')) values[name] = value.value;
    else throw Error(`Unsupported/invalid token ${group}.${name}`);
  }
  constants[group] = values;
}
if (Object.keys(constants.fontFamily).sort().join() !== 'midnight,neutral,paper,vivid') throw Error('Theme font coverage changed');
const header = `Generated from ${sourcePath}; SHA-256 ${fingerprint}. DO NOT EDIT.`;
outputs['src/theme/generatedUiTokens.ts'] = `// ${header}\n` + Object.entries(constants).map(([group, values]) =>
  `export const GENERATED_${group.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()} = Object.freeze(${JSON.stringify(values, null, 2)} as const);\n`).join('\n');
outputs['src/theme/generatedUiTokens.ts'] += '\nexport const GENERATED_PALETTES = Object.freeze({\n' + Object.entries(palettes).map(([theme, values]) =>
  `  ${theme}: Object.freeze(${JSON.stringify(values, null, 2)} as const),`).join('\n') + '\n});\n';
const native = ['// ' + header, 'package com.laoji.nativeplatform.ui', '', 'internal object GeneratedUiTokens {'];
for (const [group, values] of Object.entries(constants)) for (const [name, value] of Object.entries(values)) {
  native.push(`  const val ${group}_${name} = ${typeof value === 'string' ? JSON.stringify(value) : group === 'motion' ? `${value}L` : `${value.toFixed(1)}f`}`);
}
native.push('', '  data class ThemePalette(', ...colorKeys.map(key => `    val ${key}: Int,`), '  )', '');
for (const [theme, values] of Object.entries(palettes)) {
  native.push(`  private val ${theme}Palette = ThemePalette(`, ...colorKeys.map(key => `    ${key} = ${androidColor(values[key])},`), '  )');
}
native.push('', '  fun palette(theme: String): ThemePalette = when (theme) {', ...Object.keys(palettes).filter(id => id !== 'neutral').map(id => `    "${id}" -> ${id}Palette`), '    else -> neutralPalette', '  }', '}', '');
outputs['modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/ui/GeneratedUiTokens.kt'] = native.join('\n');
let failures = 0;
for (const [file, content] of Object.entries(outputs)) {
  const absolute = path.join(root, file);
  if (check) {
    if (!fs.existsSync(absolute) || fs.readFileSync(absolute, 'utf8') !== content) {
      process.stderr.write(`Outdated generated UI tokens: ${file}\n`); failures++;
    }
  } else {
    fs.mkdirSync(path.dirname(absolute), { recursive: true }); fs.writeFileSync(absolute, content);
  }
}
if (failures) process.exit(1);
process.stdout.write(`${check ? 'Verified' : 'Generated'} shared UI tokens ${fingerprint}\n`);
