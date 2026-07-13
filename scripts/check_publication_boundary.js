const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = new Set(process.argv.slice(2));
const requireGitleaks = args.has('--require-gitleaks');
const root = path.resolve(process.cwd());

const deniedPathPatterns = [
  /^docs\/collaboration\//,
  /^docs\/evidence\//,
  /^dist\//,
  /^coverage\//,
  /^\.expo\//,
  /^android\/app\/build\//,
  /^ios\/build\//,
  /(^|\/)credentials\.properties$/i,
  /(^|\/)android-signing\.properties$/i,
  /\.(?:jks|keystore|p8|p12|pem|key|mobileprovision)$/i,
  /^\.env(?:\..+)?$/i,
];

const deniedTextPatterns = [
  { label: 'local home path', regex: /\/home\/(?:yydd|zhong)(?:\/|\b)/i },
  { label: 'private chat attachment path', regex: /(?:xwechat_files|wxid_[a-z0-9_]+)/i },
  { label: 'private key material', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

const selfPath = 'scripts/check_publication_boundary.js';

function prospectiveFiles() {
  const output = execFileSync(
    'git',
    ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'buffer' },
  );
  return output
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .filter(relativePath => fs.existsSync(path.join(root, relativePath)))
    .sort();
}

function isAllowedIpv4(value) {
  const octets = value.split('.').map(Number);
  if (octets.length !== 4 || octets.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  if (value === '0.0.0.0' || value === '127.0.0.1') return true;
  return (
    (octets[0] === 192 && octets[1] === 0 && octets[2] === 2)
    || (octets[0] === 198 && octets[1] === 51 && octets[2] === 100)
    || (octets[0] === 203 && octets[1] === 0 && octets[2] === 113)
  );
}

function inspectText(relativePath, content, failures) {
  for (const { label, regex } of deniedTextPatterns) {
    if (relativePath === selfPath && label === 'private chat attachment path') continue;
    if (regex.test(content)) failures.push(`${relativePath}: ${label}`);
  }

  const credentialUrls = content.match(/https?:\/\/[^\s/'"`]+:[^\s/@'"`]+@[^\s'"`]+/gi) || [];
  for (const value of credentialUrls) {
    try {
      const hostname = new URL(value).hostname.toLowerCase();
      const isDocumentationHost = ['example.com', 'example.org', 'example.net']
        .some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
      if (!isDocumentationHost) failures.push(`${relativePath}: embedded URL credentials`);
    } catch {
      failures.push(`${relativePath}: malformed URL with embedded credentials`);
    }
  }

  const ipv4Matches = content.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || [];
  for (const value of new Set(ipv4Matches)) {
    if (!isAllowedIpv4(value)) failures.push(`${relativePath}: non-documentation IPv4 address`);
  }
}

function copyForGitleaks(files) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'laoji-public-audit-'));
  for (const relativePath of files) {
    const source = path.join(root, relativePath);
    if (!fs.statSync(source).isFile()) continue;
    const destination = path.join(tempRoot, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  return tempRoot;
}

function runGitleaks(files, failures) {
  const probe = spawnSync('gitleaks', ['version'], { encoding: 'utf8' });
  if (probe.error && probe.error.code === 'ENOENT') {
    if (requireGitleaks) failures.push('gitleaks is required but was not found on PATH');
    else console.warn('warning: gitleaks not found; credential scan skipped');
    return;
  }
  if (probe.status !== 0) {
    failures.push('gitleaks is installed but could not run');
    return;
  }

  const tempRoot = copyForGitleaks(files);
  try {
    const result = spawnSync(
      'gitleaks',
      ['detect', '--no-banner', '--redact', '--no-git', '--source', tempRoot],
      { encoding: 'utf8' },
    );
    if (result.status !== 0) failures.push('gitleaks detected one or more credential candidates');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

const files = prospectiveFiles();
const failures = [];

for (const relativePath of files) {
  if (relativePath === '.env.example') {
    // The documentation-only environment template is intentionally public.
  } else if (deniedPathPatterns.some(pattern => pattern.test(relativePath))) {
    failures.push(`${relativePath}: denied publication path`);
    continue;
  }

  const absolutePath = path.join(root, relativePath);
  const stat = fs.statSync(absolutePath);
  if (!stat.isFile() || stat.size > 5 * 1024 * 1024) continue;
  const buffer = fs.readFileSync(absolutePath);
  if (buffer.includes(0)) continue;
  inspectText(relativePath, buffer.toString('utf8'), failures);
}

runGitleaks(files, failures);

if (failures.length > 0) {
  console.error('Publication boundary audit failed:');
  for (const failure of [...new Set(failures)].sort()) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Publication boundary audit passed (${files.length} prospective files).`);
