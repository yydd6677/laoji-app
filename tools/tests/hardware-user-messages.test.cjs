const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const target = { exports: {} };
const compiled = ts.transpileModule(fs.readFileSync(require('node:path').resolve(__dirname,
  '../../src/services/hardwareUserMessages.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
new Function('require', 'module', 'exports', compiled)(() => ({}), target, target.exports);
const message = target.exports.hardwareUserMessage;
const needsWifiSettings = target.exports.hardwareNeedsWifiSettings;
test('device capture failure never diagnoses the phone disk', () => {
  assert.equal(message({code:'device_storage_failed'}), '录音设备未能保存录音，请检查存储卡。');
  for (const code of ['device_audio_failed','device_recording_interrupted']) {
    assert.equal(message({code,message:'private source details'}), '录音设备录音中断，可重新录制。');
  }
  assert.equal(message({code:'storage_failed'}), '录音暂时无法保存，请检查本机存储空间。');
});
test('a mid-body network loss keeps its specific recovery through native wrapping', () => {
  for (const error of [{ code: 'wifi_transfer_interrupted' },
    { message: "Call to function 'receiveDeviceRecording' has been rejected. → Caused by: 设备录音接收中断，请重试。" },
    { message: "Call to function 'receiveDeviceRecording' has been rejected. → Caused by: 录音接收中断，请重试。" },
    { message: "Call to function 'receiveDeviceRecording' has been rejected. → Caused by: 录音设备的传输连接已断开。" }]) {
    assert.equal(message(error), '录音接收中断，请重试。');
    assert.equal(needsWifiSettings(error), false);
  }
});
test('disabled WLAN has a precise recovery, including Expo wrapped errors', () => {
  for (const error of [{ code: 'wifi_disabled' }, { errorCode: 'wifi_disabled' },
    { message: "Call to function 'receiveDeviceRecording' has been rejected. → Caused by: 无线网络已关闭。" }]) {
    assert.equal(message(error), '无线网络已关闭。');
    assert.equal(needsWifiSettings(error), true);
  }
  assert.equal(needsWifiSettings({ code: 'wifi_unavailable' }), false);
  assert.equal(needsWifiSettings({ code: 'checksum_mismatch' }), false);
});
test('integrity failure has one actionable Chinese outcome through the native wrapper', () => {
  for (const error of [{ code: 'checksum_mismatch' },
    { message: "Call to function 'receiveDeviceRecording' has been rejected. → Caused by: 录音校验未通过，请重新接收。" }]) {
    assert.equal(message(error), '录音校验未通过，请重新接收。');
  }
});
test('unavailable Wi-Fi callback keeps its outcome through the Expo wrapper', () => {
  for (const error of [{ code: 'wifi_unavailable' },
    { message: "Call to function 'receiveDeviceRecording' has been rejected. → Caused by: 未能连接录音设备的传输网络。" }]) {
    assert.equal(message(error), '未能连接录音设备的传输网络。');
    assert.equal(needsWifiSettings(error), false);
  }
});
test('changed generation requests refresh and unknown internal errors stay private', () => {
  assert.equal(message({ code: 'resume_mismatch' }), '设备录音已变化，请刷新后重试。');
  assert.equal(message({ message: 'java.lang.IllegalStateException: internal secret' }), '外接录音设备暂时无法完成这项操作。');
});

test('only a fresh same-device recognized outcome may own the error without a second modal', () => {
  const owns = target.exports.hardwareConnectionOwnsError;
  const attempt = { locator: 'ble:one', afterMs: 100 };
  const state = { locator: 'ble:one', updatedAtMs: 110, errorCode: 'transport_lost',
    errorMessage: '无线录音设备连接超时。' };
  const error = { message: "Call to function 'pauseCapture' has been rejected. → Caused by: 无线录音设备连接超时。" };
  assert.equal(owns(error, state, attempt), true);
  assert.equal(owns(error, { ...state, updatedAtMs: 99 }, attempt), false);
  assert.equal(owns(error, { ...state, locator: 'ble:another' }, attempt), false);
  assert.equal(owns(error, { ...state, errorMessage: null }, attempt), false);
  assert.equal(owns(error, null, attempt), false);
  assert.equal(owns(error, state, { ...attempt, locator: null }), false);
  assert.equal(owns({ code: 'checksum_mismatch' }, state, attempt), false);
  assert.equal(owns({ message: 'unknown implementation' }, { ...state, errorMessage: 'another implementation' }, attempt), false);
});
