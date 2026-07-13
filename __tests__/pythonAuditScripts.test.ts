import { spawnSync } from 'child_process';
import path from 'path';

describe('Python audit entrypoints', () => {
  it('passes the self-cleaning summary lifecycle audit tests', () => {
    const projectRoot = path.resolve(__dirname, '..');
    const command = process.platform === 'win32' ? 'py' : 'python3';
    const args = process.platform === 'win32'
      ? ['-3', '-m', 'unittest', 'scripts.tests.test_audit_summary_task_lifecycle']
      : ['-m', 'unittest', 'scripts.tests.test_audit_summary_task_lifecycle'];
    const result = spawnSync(command, args, {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 15_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('OK');
  });
});
