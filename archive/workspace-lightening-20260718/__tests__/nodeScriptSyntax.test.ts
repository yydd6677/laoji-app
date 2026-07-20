import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

function javascriptFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(entryPath);
    return entry.isFile() && entry.name.endsWith('.js') ? [entryPath] : [];
  });
}

const files = ['config', 'plugins', 'scripts']
  .flatMap(directory => javascriptFiles(path.resolve(__dirname, '..', directory)))
  .sort();

describe('Node build and audit entrypoints', () => {
  it.each(files)('parses %s', file => {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });
});
