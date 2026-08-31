#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const failures = [];

function requireText(source, value, rule) {
  if (!source.includes(value)) failures.push(`missing:${rule}`);
}

function forbidText(source, value, rule) {
  if (source.includes(value)) failures.push(`forbidden:${rule}`);
}

function count(source, value) {
  return source.split(value).length - 1;
}

const settings = read('src/screens/PrivacyScreen.tsx');
const version = read('src/screens/LegalDocumentScreen.tsx');
const rows = read('src/components/SettingsGroup.tsx');
const navigationState = read('src/services/navigationState.ts');

// These are deterministic tests for observed regressions, not a claim that a
// script can understand every form of semantically duplicated UI information.
forbidText(settings, 'APP_VERSION_LABEL', 'settings-combined-version-build');
forbidText(version, 'APP_VERSION_LABEL', 'about-combined-version-build');
forbidText(settings, 'currentVersionCode', 'settings-build-number-duplicate');
requireText(settings, '? `${APP_VERSION} · 有更新`', 'settings-version-name-only');
requireText(version, '<Text style={s.aboutVersionLine} numberOfLines={1} testID="legal-about-version">\n              {`老记 ${APP_VERSION}`}\n            </Text>', 'about-version-single-owner');
forbidText(version, 'style={s.aboutName}', 'about-version-nested-name');
forbidText(version, 'style={s.aboutVersion}', 'about-version-nested-value');
requireText(version, "aboutVersionLine: { width: '100%'", 'about-version-full-width');
requireText(version, 'label="构建编号" value={String(APP_BUILD_NUMBER', 'single-build-row-owner');
if (count(version, 'label="构建编号"') !== 1) failures.push('count:single-build-row-owner');

requireText(version, '`正在下载 ${downloadPercent}%`', 'download-percent-notice-owner');
forbidText(version, '`${Math.round(update.progress * 100)}%`', 'download-percent-value-duplicate');
requireText(version, "const updateValue = update.status === 'up_to_date'", 'update-value-terminal-only');
requireText(version, 'testID="legal-update-install"', 'update-action-notice-owner');
requireText(version, '{!showUpdateNotice ? (', 'update-check-row-hidden-when-action-notice-visible');
if (count(version, 'testID="legal-update-install"') !== 1) failures.push('count:update-action-notice-owner');
forbidText(version, "label={updateLabel}", 'duplicate-update-action-row-owner');

requireText(rows, 'value: {\n    flex: 1,\n    minWidth: 0,', 'settings-value-flex-lane');
requireText(rows, "textAlign: 'right'", 'settings-value-right-align');
forbidText(rows, 'value: {\n    flexShrink: 0,', 'settings-value-intrinsic-width');

// The update installer replaces the package while Version Information is in
// front. That tool route must never become the next cold-start destination.
requireText(navigationState, "const NON_RESTORABLE_LEGAL_KINDS = new Set(['version']);", 'version-page-transient-navigation');
requireText(navigationState, 'NON_RESTORABLE_LEGAL_KINDS.has(route.params.kind)', 'version-page-not-restored');

if (failures.length) {
  for (const failure of failures) process.stderr.write(`FAIL ${failure}\n`);
  process.exit(1);
}

process.stdout.write('PASS LaoJi known UI regression checks\n');
