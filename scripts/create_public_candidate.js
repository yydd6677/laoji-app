#!/usr/bin/env node

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const destinationArg = process.argv[2];

if (!destinationArg) {
  console.error('Usage: node scripts/create_public_candidate.js <empty-destination>');
  process.exit(2);
}

const destination = path.resolve(destinationArg);
const relativeDestination = path.relative(root, destination);
if (!relativeDestination.startsWith('..') && !path.isAbsolute(relativeDestination)) {
  console.error('Destination must be outside the source repository');
  process.exit(2);
}

if (fs.existsSync(destination) && fs.readdirSync(destination).length > 0) {
  console.error(`Destination is not empty: ${destination}`);
  process.exit(2);
}

execFileSync(
  process.execPath,
  [path.join(root, 'scripts/check_publication_boundary.js'), '--require-gitleaks'],
  { cwd: root, stdio: 'inherit' },
);

const output = execFileSync(
  'git',
  ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { encoding: 'buffer' },
);
const files = output
  .toString('utf8')
  .split('\0')
  .filter(Boolean)
  .filter(relativePath => fs.existsSync(path.join(root, relativePath)))
  .sort();

fs.mkdirSync(destination, { recursive: true });
for (const relativePath of files) {
  const source = path.join(root, relativePath);
  const stat = fs.statSync(source);
  if (!stat.isFile()) continue;
  const target = path.join(destination, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  fs.chmodSync(target, stat.mode & 0o777);
}

console.log(JSON.stringify({ destination, files: files.length }));
