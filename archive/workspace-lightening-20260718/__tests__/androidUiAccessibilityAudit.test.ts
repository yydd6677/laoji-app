import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const checker = path.resolve(__dirname, '../scripts/check_android_ui_accessibility.py');

function xmlNode(attributes: string): string {
  return `<?xml version="1.0"?><hierarchy><node ${attributes} /></hierarchy>`;
}

describe('Android UI accessibility dump audit', () => {
  const directories: string[] = [];

  afterEach(() => {
    while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
  });

  function fixture(xml: string): string {
    const directory = mkdtempSync(path.join(tmpdir(), 'laoji-ui-a11y-test-'));
    directories.push(directory);
    writeFileSync(path.join(directory, 'screen.xml'), xml, 'utf8');
    return directory;
  }

  it('accepts a human-readable accessibility description', () => {
    const directory = fixture(xmlNode(
      'clickable="true" enabled="true" text="" content-desc="打开个人资料" bounds="[0,0][10,10]"',
    ));

    const output = execFileSync('python3', [checker, directory], { encoding: 'utf8' });

    expect(output).toContain('accessibility audit passed');
  });

  it('rejects an icon glyph without echoing it', () => {
    const directory = fixture(xmlNode(
      'clickable="true" enabled="true" text="" content-desc="&#xf454;" bounds="[0,0][10,10]"',
    ));

    const result = spawnSync('python3', [checker, directory], { encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unlabeled clickable control');
    expect(result.stderr).not.toContain('\uf454');
  });
});
