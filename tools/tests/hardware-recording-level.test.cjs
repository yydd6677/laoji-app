const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function fixture(props) {
  const target = {exports:{}}; let effect, listener, removed = false; const writes = [];
  const react = {memo: f=>f, useState:()=>[0,value=>writes.push(value)], useEffect:f=>{effect=f;},
    createElement:(...args)=>args};
  const compiled=ts.transpileModule(fs.readFileSync(path.resolve(__dirname,'../../src/components/HardwareRecordingLevel.tsx'),'utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true,target:ts.ScriptTarget.ES2022},
  }).outputText;
  new Function('require','module','exports',compiled)(name=>{
    if(name==='react')return react;
    if(name==='react-native')return {View:'View',StyleSheet:{create:v=>v}};
    if(name==='laoji-native-platform')return {addHardwareLevelListener:f=>{listener=f;return{remove(){removed=true;}}}};
    throw Error(name);
  },target,target.exports);
  const tree=target.exports.HardwareRecordingLevel({sessionId:'capture-one',foreground:true,trackColor:'gray',fillColor:'blue',...props});
  const cleanup=effect();
  return {tree,writes,get listener(){return listener;},cleanup,get removed(){return removed;}};
}
test('only current finite levels update the isolated meter, late events are fenced',()=>{
  const f=fixture();assert.deepEqual(f.writes,[0]);
  f.listener({sessionId:'old-capture',normalized:.7});
  f.listener({sessionId:'capture-one',normalized:NaN});assert.deepEqual(f.writes,[0]);
  for(const value of [.4,-2,5])f.listener({sessionId:'capture-one',normalized:value});
  assert.deepEqual(f.writes,[0,.4,0,1]);
  f.cleanup();assert.equal(f.removed,true);
  f.listener({sessionId:'capture-one',normalized:.9});assert.equal(f.writes.length,4);
  assert.equal(f.tree[0],'View');assert.equal(f.tree[2][0],'View');
});
test('an unfocused or absent capture has no level subscription',()=>{
  for(const props of [{foreground:false},{sessionId:null}]){
    const f=fixture(props);assert.equal(f.listener,undefined);assert.deepEqual(f.writes,[0]);
  }
});
test('device catalog no longer owns the high-rate level subscription',()=>{
  const source=fs.readFileSync(path.resolve(__dirname,'../../src/screens/HardwareDevicesScreen.tsx'),'utf8');
  assert.equal(source.includes('addHardwareLevelListener'),false);
  assert.equal(source.includes('<HardwareRecordingLevel'),true);
});
