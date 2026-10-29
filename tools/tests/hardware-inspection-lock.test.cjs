const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {acquireInspectionLock}=require('../hardware/inspection_lock.cjs');
test('a second observer waits for the live owner, without replacing its lease',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'laoji-inspection-test-')),file=path.join(root,'lock');
  let release,second;
  try{
    release=await acquireInspectionLock({file});const original=fs.readFileSync(file,'utf8');
    await assert.rejects(acquireInspectionLock({file,timeoutMs:60}),/inspection is active/);
    assert.equal(fs.readFileSync(file,'utf8'),original);
    const waiting=acquireInspectionLock({file,timeoutMs:1000});release();
    second=await waiting;assert.notEqual(fs.readFileSync(file,'utf8'),original);
    release();assert.equal(fs.existsSync(file),true);second();assert.equal(fs.existsSync(file),false);
  }finally{release?.();second?.();fs.rmSync(root,{recursive:true});}
});
test('unknown owner metadata is never removed or interpreted as idle',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'laoji-inspection-test-')),file=path.join(root,'lock');
  try{fs.writeFileSync(file,'unknown');await assert.rejects(acquireInspectionLock({file,timeoutMs:30}));
    assert.equal(fs.readFileSync(file,'utf8'),'unknown');}
  finally{fs.rmSync(root,{recursive:true});}
});
