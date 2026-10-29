const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '../..');
test('the small catalog points to production owners and real runners, not copied preview screens', () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'design-system/catalog.json'), 'utf8'));
  assert.equal(catalog.schemaVersion, 1);
  const seen = new Set();
  for (const item of catalog.patterns) {
    assert.equal(seen.has(item.patternId), false); seen.add(item.patternId);
    assert.ok(item.stateCases.length && item.themeCases.length);
    for (const file of [...item.implementationPaths, ...item.runnerPaths]) {
      assert.ok(!path.isAbsolute(file) && !file.includes('..'));
      assert.ok(fs.statSync(path.join(root, file)).isFile(), file);
    }
    for (const file of item.implementationPaths) assert.ok(!file.includes('/androidTest/') && !file.includes('/output/'));
  }
});
