const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const ts=require('typescript');
const m={exports:{}};
new Function('require','module','exports',ts.transpileModule(fs.readFileSync(path.resolve(__dirname,
  '../../src/services/hardwareCatalogPresentation.ts'),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText)(()=>({}),m,m.exports);
const order=m.exports.orderHardwareCatalog;
const rows=m.exports.hardwareDeviceRows;
test('native verified connection survives page re-entry even without an advertising result',()=>{
  const connected={phase:'ready',transport:'ble',deviceId:'board-one',locator:'ble:one',model:'语音备忘录'};
  const result=rows([],connected);
  assert.equal(result.length,1);assert.equal(result[0].locator,'ble:one');
  assert.equal(result[0].productName,'语音备忘录');assert.equal('rssi' in result[0],false);
  for(const phase of ['connecting','handshaking','disconnected','retryable_error']){
    assert.deepEqual(rows([],{...connected,phase}),[]);
  }
  const discovered={locator:'ble:one',transport:'ble',rssi:-50,productName:'设备名称',compatible:true};
  assert.deepEqual(rows([discovered],connected),[discovered]);
  assert.deepEqual(rows([discovered],null),[discovered]);
});
test('new recordings lead without mutating source identities or input order',()=>{
  const entries=[{recordingId:'old.wav',createdEpochMs:100},{recordingId:'new.wav',createdEpochMs:300},
    {recordingId:'middle.wav',createdEpochMs:200}];
  const result=order(entries);
  assert.deepEqual(result.map(e=>e.recordingId),['new.wav','middle.wav','old.wav']);
  assert.equal(result[0],entries[1]);assert.equal(entries[0].recordingId,'old.wav');
});
test('equal and unknown times stay stable; rename is not a recency event',()=>{
  const a={recordingId:'Z.wav',createdEpochMs:100},b={recordingId:'A.wav',createdEpochMs:100};
  const unknown=[null,0,NaN,undefined].map((createdEpochMs,i)=>({recordingId:String(i),createdEpochMs}));
  assert.deepEqual(order([...unknown,a,b]),[a,b,...unknown]);
  assert.deepEqual(order([{...a,recordingId:'renamed.wav'},b]).map(e=>e.recordingId),['renamed.wav','A.wav']);
});
