#!/usr/bin/env node
'use strict';

// UI-ROUTES-001 / UI-ANDROID-DEVICE-ACCEPTANCE-001: create and remove the
// disposable authenticated data needed to reach account-only Android routes.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_ENV_FILE = path.join(PROJECT_ROOT, '.env.local');

function parseDotEnv(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    values[match[1]] = value;
  }
  return values;
}

function loadConfiguration(envFile = DEFAULT_ENV_FILE) {
  const fileValues = fs.existsSync(envFile) ? parseDotEnv(fs.readFileSync(envFile, 'utf8')) : {};
  const get = name => process.env[name] || fileValues[name] || '';
  const laojiApiBase = normalizeBaseUrl(get('EXPO_PUBLIC_LAOJI_API_BASE'), 'EXPO_PUBLIC_LAOJI_API_BASE');
  const meetingApiBase = normalizeBaseUrl(get('EXPO_PUBLIC_MEETING_API_BASE'), 'EXPO_PUBLIC_MEETING_API_BASE');
  return { laojiApiBase, meetingApiBase };
}

function normalizeBaseUrl(value, name) {
  if (!value) throw new Error(`${name} is not configured`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${name} must use HTTP or HTTPS`);
  return value.replace(/\/+$/, '');
}

function fixtureCredentials(now = Date.now(), entropy = crypto.randomBytes(6).toString('hex')) {
  return {
    account: `laoji-route-${now}-${entropy}@example.com`,
    password: `Route!${entropy}Aa9`,
  };
}

function safeErrorDetail(data) {
  const value = data?.detail ?? data?.message ?? data?.error;
  if (typeof value === 'string') return value.slice(0, 300);
  if (Array.isArray(value)) {
    return value.map(item => item?.msg).filter(Boolean).join('; ').slice(0, 300);
  }
  return '';
}

async function requestJson(url, options, label) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { detail: text.slice(0, 300) };
    }
  }
  if (!response.ok) {
    const detail = safeErrorDetail(data);
    const error = new Error(`${label} failed (${response.status})${detail ? `: ${detail}` : ''}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function jsonHeaders(accessToken) {
  return {
    'Content-Type': 'application/json',
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  };
}

async function registerFixtureAccount(config, credentials) {
  const session = await requestJson(
    `${config.laojiApiBase}/api/auth/register`,
    {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        account: credentials.account,
        password: credentials.password,
        nickname: 'Route Fixture',
      }),
    },
    'fixture registration',
  );
  if (!session?.access_token || !session?.user?.id) throw new Error('fixture registration returned an incomplete session');
  return session;
}

async function createFixtureMeeting(config, accessToken, requestId) {
  const title = `RouteFixtureMeeting-${requestId}`;
  const meeting = await requestJson(
    `${config.meetingApiBase}/api/laoji/meetings`,
    {
      method: 'POST',
      headers: jsonHeaders(accessToken),
      body: JSON.stringify({
        title,
        description: 'Disposable route acceptance fixture',
        participants: [],
        mode: 'realtime',
        client_request_id: `device-route-${requestId}`,
      }),
    },
    'fixture meeting creation',
  );
  if (!meeting?.id) throw new Error('fixture meeting creation returned no id');
  return { meeting, title };
}

async function finalizeFixtureMeeting(config, accessToken, meeting) {
  const finalized = await requestJson(
    `${config.meetingApiBase}/api/laoji/meetings/${encodeURIComponent(meeting.id)}`,
    {
      method: 'PATCH',
      headers: jsonHeaders(accessToken),
      body: JSON.stringify({ status: 'completed' }),
    },
    'fixture meeting finalization',
  );
  if (finalized?.status !== 'completed') {
    throw new Error(`fixture meeting finalization returned unexpected status: ${String(finalized?.status ?? 'missing')}`);
  }
  return finalized;
}

async function deleteFixtureAccount(config, fixture) {
  let accessToken = fixture.accessToken;
  try {
    await requestJson(
      `${config.laojiApiBase}/api/auth/me`,
      {
        method: 'DELETE',
        headers: jsonHeaders(accessToken),
        body: JSON.stringify({ current_password: fixture.password, confirmation: '删除账号' }),
      },
      'fixture account deletion',
    );
    return;
  } catch (error) {
    if (error.status !== 401) throw error;
  }

  const session = await requestJson(
    `${config.laojiApiBase}/api/auth/login`,
    {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ account: fixture.account, password: fixture.password }),
    },
    'fixture reauthentication',
  );
  accessToken = session?.access_token;
  if (!accessToken) throw new Error('fixture reauthentication returned no access token');
  await requestJson(
    `${config.laojiApiBase}/api/auth/me`,
    {
      method: 'DELETE',
      headers: jsonHeaders(accessToken),
      body: JSON.stringify({ current_password: fixture.password, confirmation: '删除账号' }),
    },
    'fixture account deletion',
  );
}

function parseCli(argv) {
  const command = argv[2];
  const options = {};
  for (let index = 3; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${arg}`);
    options[arg.slice(2)] = value;
    index += 1;
  }
  return { command, options };
}

async function createCommand(options) {
  const output = options.output ? path.resolve(options.output) : '';
  if (!output) throw new Error('create requires --output');
  const config = loadConfiguration(options.env ? path.resolve(options.env) : DEFAULT_ENV_FILE);
  const credentials = fixtureCredentials();
  const requestId = crypto.randomBytes(6).toString('hex');
  const session = await registerFixtureAccount(config, credentials);
  try {
    const { meeting, title } = await createFixtureMeeting(config, session.access_token, requestId);
    const finalizedMeeting = await finalizeFixtureMeeting(config, session.access_token, meeting);
    const fixture = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      laojiApiBase: config.laojiApiBase,
      meetingApiBase: config.meetingApiBase,
      account: credentials.account,
      password: credentials.password,
      accessToken: session.access_token,
      userId: session.user.id,
      meetingId: String(finalizedMeeting.id),
      meetingTitle: title,
      meetingStatus: finalizedMeeting.status,
    };
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(fixture, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(output, 0o600);
    process.stdout.write(`${JSON.stringify({ created: true, account: fixture.account, meetingId: fixture.meetingId, meetingTitle: title })}\n`);
  } catch (error) {
    await deleteFixtureAccount(config, { ...credentials, accessToken: session.access_token }).catch(() => {});
    throw error;
  }
}

async function cleanupCommand(options) {
  const input = options.input ? path.resolve(options.input) : '';
  if (!input || !fs.existsSync(input)) throw new Error('cleanup requires an existing --input fixture file');
  const fixture = JSON.parse(fs.readFileSync(input, 'utf8'));
  const config = {
    laojiApiBase: normalizeBaseUrl(fixture.laojiApiBase, 'fixture laojiApiBase'),
    meetingApiBase: normalizeBaseUrl(fixture.meetingApiBase, 'fixture meetingApiBase'),
  };
  await deleteFixtureAccount(config, fixture);
  fs.rmSync(input, { force: true });
  process.stdout.write(`${JSON.stringify({ deleted: true, account: fixture.account })}\n`);
}

async function main(argv = process.argv) {
  const { command, options } = parseCli(argv);
  if (command === 'create') return createCommand(options);
  if (command === 'cleanup') return cleanupCommand(options);
  throw new Error('Usage: device_route_fixture.js create --output <file> | cleanup --input <file>');
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  finalizeFixtureMeeting,
  fixtureCredentials,
  loadConfiguration,
  normalizeBaseUrl,
  parseCli,
  parseDotEnv,
  requestJson,
};
