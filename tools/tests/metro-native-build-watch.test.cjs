const assert = require('node:assert/strict');
const test = require('node:test');
const config = require('../../metro.config');
const blocked = filename => config.resolver.blockList.some(rule => rule.test(filename));
test('native generated build directories are excluded on Linux and Windows', () => {
  for (const root of ['/home/dev/LaoJi/', 'C:\\projects\\LaoJi\\']) {
    const separator = root.includes('\\') ? '\\' : '/';
    const directory = ['modules', 'laoji-native-platform', 'android'].join(separator);
    for (const generated of ['build', '.gradle', '.kotlin']) {
      assert.equal(blocked(root + directory + separator + generated + separator + 'snapshot'), true);
    }
    assert.equal(blocked(root + directory + separator + 'src' + separator + 'main' + separator + 'source.kt'), false);
  }
});
