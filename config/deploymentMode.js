const PRODUCTION = 'production';
const PRODUCTION_REHEARSAL = 'production-rehearsal';

const RESERVED_EXACT_HOSTS = new Set([
  'example.com',
  'example.net',
  'example.org',
  'localhost',
]);

const RESERVED_SUFFIXES = [
  '.example.com',
  '.example.net',
  '.example.org',
  '.example',
  '.invalid',
  '.test',
  '.localhost',
  '.local',
  '.localdomain',
  '.lan',
  '.internal',
  '.home.arpa',
];

const PLACEHOLDER_LABELS = new Set([
  'changeme',
  'dummy',
  'example',
  'placeholder',
  'replace-me',
  'test',
  'your-domain',
]);

function normalizeMode(value) {
  return String(value || '').trim().toLowerCase();
}

function resolveDeploymentMode(env = process.env) {
  const appEnv = normalizeMode(env.APP_ENV);
  const easProfile = normalizeMode(env.EAS_BUILD_PROFILE);
  if (appEnv === PRODUCTION || easProfile === PRODUCTION) return PRODUCTION;
  if (appEnv === PRODUCTION_REHEARSAL || easProfile === PRODUCTION_REHEARSAL) {
    return PRODUCTION_REHEARSAL;
  }
  return appEnv || easProfile || 'development';
}

function isSecureDeploymentMode(mode) {
  const normalized = normalizeMode(mode);
  return normalized === PRODUCTION || normalized === PRODUCTION_REHEARSAL;
}

function isSubmissionDeploymentMode(mode) {
  return normalizeMode(mode) === PRODUCTION;
}

function isPlaceholderProductionHost(hostname) {
  const clean = String(hostname || '').trim().toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (!clean || RESERVED_EXACT_HOSTS.has(clean)) return true;
  if (RESERVED_SUFFIXES.some(suffix => clean.endsWith(suffix))) return true;
  return clean.split('.').some(label => PLACEHOLDER_LABELS.has(label));
}

module.exports = {
  PRODUCTION,
  PRODUCTION_REHEARSAL,
  isPlaceholderProductionHost,
  isSecureDeploymentMode,
  isSubmissionDeploymentMode,
  resolveDeploymentMode,
};
