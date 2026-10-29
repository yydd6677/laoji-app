const test=require('node:test');const assert=require('node:assert/strict');
const vm=require('node:vm');
const {runtimeModuleExpression,selectRuntimeTarget}=require('../hardware/runtime_module.cjs');
function runtime(entries){
  const calls=[];const context={__r:id=>{calls.push(id);return{id}}};
  context.__r.getModules=()=>new Map(entries);
  return{context,calls,read:path=>vm.runInNewContext(runtimeModuleExpression(path),context)};
}
test('only the exact module is selected, never a matching basename',()=>{
  const r=runtime([[1,{verboseName:'other/hardware.ts'}],[2,{verboseName:'modules/hardware.ts'}]]);
  assert.equal(r.read('modules/hardware.ts').id,2);assert.deepEqual(r.calls,[2]);
});
test('missing, ambiguous and unavailable registries do not execute a guessed module',()=>{
  const r=runtime([[1,{verboseName:'one'}],[2,{verboseName:'one'}]]);
  assert.throws(()=>r.read('two'),/one exact/);assert.throws(()=>r.read('one'),/one exact/);
  assert.deepEqual(r.calls,[]);
  assert.throws(()=>vm.runInNewContext(runtimeModuleExpression('one'),{}),/unavailable/);
});
test('each invocation resolves the current generation rather than caching a stale ID',()=>{
  const r=runtime([[1,{verboseName:'one'}]]);assert.equal(r.read('one').id,1);
  r.context.__r.getModules=()=>new Map([[25,{verboseName:'one'}]]);
  assert.equal(r.read('one').id,25);assert.deepEqual(r.calls,[1,25]);
});
test('quotes and punctuation in a module name remain data',()=>{
  const path='a";globalThis.unexpected=true;//';const r=runtime([[5,{verboseName:path}]]);
  assert.equal(r.read(path).id,5);assert.equal(r.context.unexpected,undefined);
});
test('another app or ambiguous emulator targets are never selected by list order',()=>{
  const own={appId:'com.laoji.app',deviceName:'sdk_gphone64_x86_64 - 15'};
  const other={appId:'other.app',deviceName:own.deviceName};
  assert.equal(selectRuntimeTarget([other,own]),own);
  assert.throws(()=>selectRuntimeTarget([other]),/unambiguous/);
  assert.throws(()=>selectRuntimeTarget([own,{...own}]),/unambiguous/);
});
