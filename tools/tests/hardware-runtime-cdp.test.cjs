const test = require('node:test');const assert=require('node:assert/strict');
const {openCdp}=require('../hardware/runtime_cdp.cjs');
class Socket extends EventTarget {
  static last;
  constructor(){super();Socket.last=this;this.readyState=0;this.sent=[];
    queueMicrotask(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));});}
  send(value){this.sent.push(JSON.parse(value));}
  response(id,value){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id,result:value})}));}
  close(){this.readyState=3;this.dispatchEvent(new Event('close'));}
}
test('out of order replies resolve only their own inspection, not a newer operation',async()=>{
  const c=await openCdp(Socket,'unused');const s=Socket.last;
  const a=c.evaluate('first'),b=c.evaluate('second');s.response(2,'two');s.response(1,'one');
  assert.equal((await a).result,'one');assert.equal((await b).result,'two');c.close();
});
test('missing reply times out without sending a cancellation or restart command',async()=>{
  const c=await openCdp(Socket,'unused',{requestMs:12});const s=Socket.last;
  await assert.rejects(c.evaluate('native work'),/native work may still be running/);
  assert.equal(s.sent.length,1);assert.equal(s.sent[0].method,'Runtime.evaluate');c.close();
});
test('socket loss rejects pending observation promptly',async()=>{
  const c=await openCdp(Socket,'unused');const p=c.evaluate('native work');Socket.last.close();
  await assert.rejects(p,/native work may still be running/);assert.equal(c.isOpen(),false);c.close();
});
test('unopened connection is bounded and closed',async()=>{
  class Never extends EventTarget {constructor(){super();Never.last=this;this.readyState=0;}close(){this.readyState=3;this.dispatchEvent(new Event('close'));}}
  await assert.rejects(openCdp(Never,'unused',{connectMs:12}),/did not open/);
  assert.equal(Never.last.readyState,3);
});
