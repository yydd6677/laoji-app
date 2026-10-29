const test=require('node:test');const assert=require('node:assert/strict');
const {once}=require('node:events');const crypto=require('node:crypto');
const WebSocket=require('ws');const WebSocketServer=WebSocket.Server;
const {startProxy,audioMetadata}=require('../hardware/realtime_fault_proxy.cjs');
const nonce='1234567890abcdef1234567890abcdef';
const path='/api/device/v2/realtime/hwrt-556c751f-38fe-3c63-a8f9-ed94b2de1db1';
const headers={authorization:'Bearer PRIVATE_TEST_TOKEN','x-laoji-device-id':'test-device','x-laoji-epoch-id':'test-epoch'};
function frame(){
  const pcm=Buffer.alloc(64,37),header=Buffer.from(JSON.stringify({chunk_seq:0,start_ms:0,end_ms:2,ignored:'PRIVATE_EXTRA'}));
  const prefix=Buffer.alloc(7);prefix.write('LJPC');prefix[4]=2;prefix.writeUInt16BE(header.length,5);
  return Buffer.concat([prefix,header,pcm]);
}
test('frame observations retain only real counts and actual payload hash',()=>{
  assert.equal(audioMetadata(Buffer.from('private text')),null);
  const data=frame(),value=audioMetadata(data);
  assert.equal(value.audio_bytes,64);assert.equal(value.sequence,0);
  assert.equal(value.sha256,crypto.createHash('sha256').update(Buffer.alloc(64,37)).digest('hex'));
  assert.equal(JSON.stringify(value).includes('PRIVATE'),false);
});
test('transparent relay forwards real bytes, drops once, reconnects and never logs body or credentials',async()=>{
  const audit=[],payloads=[];let count=0;
  const upstream=new WebSocketServer({host:'127.0.0.1',port:0,perMessageDeflate:false});
  await once(upstream,'listening');
  upstream.on('connection',(socket,request)=>{
    assert.equal(request.headers.authorization,headers.authorization);assert.equal(request.url,path);count++;
    socket.on('message',(data,isBinary)=>{
      const binary=typeof isBinary==='boolean'?isBinary:typeof data!=='string';
      payloads.push(Buffer.from(data));
      if(binary)socket.send(JSON.stringify({contract_revision:'transcript.stream.v2',event_kind:'stable',
        event_sequence:1,text:'PRIVATE_SPEECH'}));
      else socket.send(JSON.stringify({type:'session.ready',last_contiguous_chunk_seq:0,last_durable_event_seq:count-1}));
    });
  });
  const proxy=await startProxy({port:0,token:nonce,audit:row=>audit.push(row),
    upstreamOrigin:'ws://127.0.0.1:'+upstream.address().port});
  const clients=[];
  const open=async()=>{
    const socket=new WebSocket('ws://127.0.0.1:'+proxy.port+'/probe/'+nonce+path,{headers});clients.push(socket);
    const messages=[],waiters=[];
    socket.on('message',data=>{const waiter=waiters.shift();if(waiter)waiter(data);else messages.push(data);});
    socket.next=()=>messages.length?Promise.resolve(messages.shift()):new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('relay message not observed')),2000);
      waiters.push(data=>{clearTimeout(timer);resolve(data);});
    });
    await once(socket,'open');return socket;
  };
  try{
    const first=await open();const opened=JSON.stringify({type:'session.open',after_event_seq:0,private:'PRIVATE_SOURCE'});
    first.send(opened);assert.equal(JSON.parse(await first.next()).type,'session.ready');
    const closed=once(first,'close');first.send(frame());
    assert.equal(JSON.parse(await first.next()).text,'PRIVATE_SPEECH');await closed;
    const second=await open();second.send(opened);assert.equal(JSON.parse(await second.next()).type,'session.ready');
    second.send(frame());assert.equal(JSON.parse(await second.next()).text,'PRIVATE_SPEECH');
    assert.equal(payloads[0].toString(),opened);assert.deepEqual(payloads[1],frame());
    assert.equal(audit.filter(row=>row.event==='injected_disconnect').length,1);
    assert.equal(audit.filter(row=>row.event==='connection').length,2);
    assert.equal(JSON.stringify(audit).includes('PRIVATE'),false);
    const wrong=new WebSocket('ws://127.0.0.1:'+proxy.port+'/probe/'+'0'.repeat(32)+path,{headers});
    clients.push(wrong);await assert.rejects(once(wrong,'open'),/403/);assert.equal(count,2);
  }finally{
    for(const socket of clients)socket.terminate();await proxy.close();
    for(const socket of upstream.clients)socket.terminate();await new Promise(resolve=>upstream.close(resolve));
  }
});
