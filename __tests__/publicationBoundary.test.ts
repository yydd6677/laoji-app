import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const checker = path.resolve(__dirname, '../scripts/check_publication_boundary.js');

function git(root: string, ...args: string[]): void {
  execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
}

function createRepository(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'laoji-publication-test-'));
  git(root, 'init', '--quiet');
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(root, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
  git(root, 'add', '-A');
  return root;
}

function runChecker(root: string) {
  return spawnSync(process.execPath, [checker], { cwd: root, encoding: 'utf8' });
}

describe('publication boundary checker', () => {
  const repositories: string[] = [];

  afterEach(() => {
    while (repositories.length > 0) rmSync(repositories.pop()!, { recursive: true, force: true });
  });

  function repository(files: Record<string, string>): string {
    const root = createRepository(files);
    repositories.push(root);
    return root;
  }

  it('accepts documentation-only hosts, IPs, and credential rejection fixtures', () => {
    const root = repository({
      '.env.example': 'API=https://api.example.com\n',
      'src/config.ts': [
        "const loopback = '127.0.0.1';",
        "const documentation = '203.0.113.10';",
        "const rejectedFixture = 'https://user:secret@api.example.com';",
      ].join('\n'),
    });

    const result = runChecker(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Publication boundary audit passed');
  });

  it.each([
    [
      'public address',
      `export const endpoint = 'http://${['8', '8', '8', '8'].join('.')}';`,
      'non-documentation IPv4 address',
    ],
    [
      'local path',
      `export const source = '${['', 'home', 'zhong', 'service'].join('/')}';`,
      'local home path',
    ],
    [
      'credential URL',
      `export const url = '${'https://'}${'admin:secret'}${'@service.invalid'}';`,
      'embedded URL credentials',
    ],
  ])('rejects %s without echoing the sensitive value', (_label, source, expectedMessage) => {
    const root = repository({ 'src/config.ts': source });

    const result = runChecker(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(expectedMessage);
    expect(result.stderr).not.toContain(source);
  });

  it('rejects internal paths even when someone force-adds them', () => {
    const root = repository({ 'docs/collaboration/private.md': 'internal topology\n' });

    const result = runChecker(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('denied publication path');
  });

  it('ignores an index entry deleted from the working tree', () => {
    const root = repository({ 'removed.json': '{}\n', 'src/index.ts': 'export {};\n' });
    rmSync(path.join(root, 'removed.json'));

    const result = runChecker(root);

    expect(result.status).toBe(0);
  });
});
