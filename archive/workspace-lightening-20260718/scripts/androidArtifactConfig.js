const net = require('net');
const { isPlaceholderProductionHost } = require('../config/deploymentMode');

function isDomainName(hostname) {
  const clean = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!clean.includes('.') || clean.length > 253 || net.isIP(clean) !== 0) return false;
  return clean.split('.').every(label => (
    label.length > 0
    && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  ));
}

function validateSecureUrl(name, value, rejectPlaceholders) {
  let parsed;
  try {
    parsed = new URL(String(value || ''));
  } catch {
    throw new Error(`${name} is missing or invalid in embedded app.config.`);
  }
  if (parsed.protocol !== 'https:'
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
      || !isDomainName(parsed.hostname)) {
    throw new Error(`${name} must be a credential-free HTTPS domain in embedded app.config.`);
  }
  if (rejectPlaceholders && isPlaceholderProductionHost(parsed.hostname)) {
    throw new Error(`${name} contains a reserved or placeholder production domain.`);
  }
}

function validateEmbeddedAppConfig(appConfig, mode) {
  if (!['production', 'rehearsal'].includes(mode)) return;
  const extra = appConfig?.extra;
  if (!extra || typeof extra !== 'object') {
    throw new Error('Embedded app.config is missing the extra deployment configuration.');
  }

  const expectedEnv = mode === 'production' ? 'production' : 'production-rehearsal';
  if (extra.appEnv !== expectedEnv) {
    throw new Error(`Embedded app.config appEnv must be ${expectedEnv}, received ${String(extra.appEnv)}.`);
  }

  const rejectPlaceholders = mode === 'production';
  for (const [name, value] of [
    ['laojiApiBase', extra.laojiApiBase],
    ['meetingApiBase', extra.meetingApiBase],
    ['privacyPolicyUrl', extra.privacyPolicyUrl],
    ['termsOfServiceUrl', extra.termsOfServiceUrl],
    ['accountDeletionUrl', extra.accountDeletionUrl],
  ]) {
    validateSecureUrl(name, value, rejectPlaceholders);
  }

  const realtimeHost = String(extra.realtimeAsrHost || '').trim();
  const realtimePort = Number(extra.realtimeAsrPort);
  if (!isDomainName(realtimeHost)
      || extra.realtimeAsrSecure !== true
      || !Number.isInteger(realtimePort)
      || realtimePort < 1
      || realtimePort > 65535) {
    throw new Error('Embedded realtime ASR config must use a secure domain and valid port.');
  }
  if (rejectPlaceholders && isPlaceholderProductionHost(realtimeHost)) {
    throw new Error('realtimeAsrHost contains a reserved or placeholder production domain.');
  }
  if (!['whisper', 'qwen'].includes(String(extra.realtimeAsrProvider || ''))) {
    throw new Error('Embedded realtimeAsrProvider must be whisper or qwen.');
  }
}

module.exports = { validateEmbeddedAppConfig };
