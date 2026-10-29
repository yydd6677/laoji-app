const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('the existing build continuity entry rejects an isolated broken composer', () => {
  const root = path.resolve(__dirname, '../..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'laoji-ui-negative-'));
  try {
    const source = fs.readFileSync(path.join(root, 'src/components/MeetingQuestionSheet.tsx'), 'utf8');
    const changed = source.replace('editable={!closing && !historyVisible && !session?.readOnly}', 'editable={false}');
    assert.notEqual(changed, source, 'negative mutation must actually alter the tested owner');
    const fixture = path.join(temp, 'MeetingQuestionSheet.tsx');
    fs.writeFileSync(fixture, changed);
    const env = { ...process.env, LAOJI_QUESTION_COMPONENT_FIXTURE: fixture };
    // Node's child-v8 test protocol is not a CLI build invocation.
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['tools/verify-ui-continuity-contract.cjs'], {
      cwd: root, encoding: 'utf8', timeout: 30_000,
      env,
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /false !== true/);
  } finally { fs.rmSync(temp, { recursive: true }); }
});
