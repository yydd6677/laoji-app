const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const ts=require('typescript');
const m={exports:{}};
const source=fs.readFileSync(path.resolve(__dirname,'../../src/screens/HardwareDevicesScreen.tsx'),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,
  esModuleInterop:true,target:ts.ScriptTarget.ES2022}}).outputText;
new Function('require','module','exports',code+';module.exports.styles=createStyles;')(
  name=>name==='react-native'?{StyleSheet:{create:value=>value,hairlineWidth:1}}:{},m,m.exports);
test('hardware controls keep label lanes wider than glyph advances at supported font scales',()=>{
  for(const scale of [1,1.3,1.5,2]){
    const s=m.exports.styles('theme-font',scale);
    for(const [style,count,size] of [[s.secondaryButtonText,2,14],[s.primaryButtonText,4,14],
      [s.compactButtonText,3,13],[s.importButtonText,4,13]]){
      assert.ok(style.minWidth>=Math.ceil(count*size*scale)+4);
      assert.equal(style.textAlign,'center');assert.equal(style.fontFamily,'theme-font');
    }
    assert.ok(s.importButton.minWidth>=s.importButtonText.minWidth+24);
    assert.ok(s.importButton.height>=20*scale+8);
    assert.ok(s.primaryButton.height>=20*scale+8);
  }
});
