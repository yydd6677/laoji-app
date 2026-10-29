const test = require('node:test');
const assert = require('node:assert/strict');
const { debugInstallCommands, releaseInstallCommands } = require('../android-build.cjs');

test('debug install targets one serial and launches the exact selected Metro', () => {
  for (const file of ['/tmp/a folder/app.apk', 'C:\\my project\\app.apk']) {
    const commands = debugInstallCommands('emulator-5562', file, '8083');
    assert.deepEqual(commands[0], ['-s', 'emulator-5562', 'install', '-r', file]);
    assert.deepEqual(commands[1], ['-s', 'emulator-5562', 'reverse', 'tcp:8083', 'tcp:8083']);
    const link = new URL(commands[2].at(-1));
    assert.equal(link.protocol, 'laoji:');
    assert.equal(link.searchParams.get('url'), 'http://127.0.0.1:8083');
    assert.equal(commands.every(args => args[0] === '-s' && args[1] === 'emulator-5562'), true);
    assert.equal(commands.some(args => args.includes('uninstall') || args.includes('clear') || args.includes('kill-server')), false);
  }
});
test('invalid port or missing target cannot start a partial debug install', () => {
  for (const port of ['0', '65536', 'a', '8083;echo', '1.5']) {
    assert.throws(() => debugInstallCommands('emulator-5562', 'app.apk', port));
  }
  assert.throws(() => debugInstallCommands('', 'app.apk', 8083));
});

test('release measurement installs only on 5562, without Metro or a destructive reset', () => {
  const commands = releaseInstallCommands('emulator-5562', '/an actual path/app.apk');
  assert.deepEqual(commands, [
    ['-s', 'emulator-5562', 'install', '-r', '/an actual path/app.apk'],
    ['-s', 'emulator-5562', 'shell', 'am', 'start', '-n', 'com.laoji.app/.MainActivity'],
  ]);
  for (const serial of ['emulator-5560', '825f509d', '']) assert.throws(() => releaseInstallCommands(serial, 'app.apk'));
});
