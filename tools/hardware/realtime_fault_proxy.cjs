// One local test connection path; forwards real service bytes unchanged.
// No fabricated ready/ack/transcript and no body, token, title or URL in audit.
const http=require('node:http');const crypto=require('node:crypto');
const fs=require('node:fs');const WebSocket=require('ws');const WebSocketServer=WebSocket.Server;
const sequence=value=>Number.isSafeInteger(value)&&value>=-1?value:null;

function audioMetadata(data){
  if(data.length<8||data.subarray(0,4).toString()!=='LJPC'||data[4]!==2)return null;
  const length=data.readUInt16BE(5);
  if(length<1||length>2048||data.length<=7+length)return null;
  let header;try{header=JSON.parse(data.subarray(7,7+length));}catch{return null;}
  if(![header.chunk_seq,header.start_ms,header.end_ms].every(Number.isSafeInteger))return null;
  return{sequence:header.chunk_seq,start_ms:header.start_ms,end_ms:header.end_ms,
    audio_bytes:data.length-7-length,sha256:crypto.createHash('sha256').update(data.subarray(7+length)).digest('hex')};
}

async function startProxy({port=18024,token,audit,upstreamOrigin='wss://laoji.cloud'}){
  if(!/^[0-9a-f]{32}$/.test(token))throw Error('Explicit 128-bit probe nonce required');
  const server=http.createServer((_,response)=>response.writeHead(404).end());
  const wsServer=new WebSocketServer({noServer:true,maxPayload:2*1024*1024,perMessageDeflate:false});
  const pairs=new Set();let boundPath=null,connection=0,faultUsed=false,faultArmed=false;
  server.on('upgrade',(request,socket,head)=>{
    socket.on('error',()=>{}); // A rejected handshake can be reset by its peer.
    const url=new URL(request.url,'http://127.0.0.1');
    const prefix='/probe/'+token;
    const path=url.pathname.startsWith(prefix)?url.pathname.slice(prefix.length):'';
    const valid=/^\/api\/device\/v2\/realtime\/(?:hwrt-)?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(path)
      &&!url.search&&(!boundPath||boundPath===path);
    if(!valid){audit({event:'probe_path_rejected'});socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
    const headers={};
    for(const name of ['authorization','x-laoji-device-id','x-laoji-epoch-id']){
      const value=request.headers[name];
      if(typeof value!=='string'||!value||value.length>8192){socket.destroy();return;}
      headers[name]=value;
    }
    boundPath=path;
    wsServer.handleUpgrade(request,socket,head,down=>{
      const index=++connection;
      const up=new WebSocket(upstreamOrigin+path,{headers,handshakeTimeout:15000,
        maxPayload:2*1024*1024,perMessageDeflate:false});
      const pair={down,up};pairs.add(pair);
      let ended=false,queued=[],queuedBytes=0,timer=null;
      audit({event:'connection',connection:index});
      function finish(){
        if(ended)return;ended=true;pairs.delete(pair);
        if(timer){clearTimeout(timer);timer=null;if(!faultUsed)faultArmed=false;}
        down.terminate();up.terminate();queued=[];queuedBytes=0;
      }
      function forward(target,data,binary){
        if(ended)return;
        if(target.bufferedAmount>1024*1024){audit({event:'probe_backpressure',connection:index});finish();return;}
        target.send(data,{binary},error=>{if(error)finish();});
      }
      up.on('open',()=>{
        audit({event:'upstream_open',connection:index});
        for(const [data,binary]of queued)forward(up,data,binary);
        queued=[];queuedBytes=0;
      });
      down.on('message',(raw,isBinary)=>{
        const binary=typeof isBinary==='boolean'?isBinary:typeof raw!=='string';
        const data=Buffer.from(raw);
        if(binary){const metadata=audioMetadata(data);if(metadata)audit({event:'audio',connection:index,...metadata});}
        else{
          let message;try{message=JSON.parse(data);}catch{}
          if(message?.type==='session.open')audit({event:'session_open',connection:index,after_event_seq:sequence(message.after_event_seq)});
          if(message?.type==='session.finalize')audit({event:'finalize',connection:index});
        }
        if(up.readyState===WebSocket.OPEN)forward(up,data,binary);
        else if(up.readyState===WebSocket.CONNECTING){
          queuedBytes+=data.length;
          if(queuedBytes>1024*1024){audit({event:'probe_backpressure',connection:index});finish();return;}
          queued.push([data,binary]);
        }
      });
      up.on('message',(raw,isBinary)=>{
        const binary=typeof isBinary==='boolean'?isBinary:typeof raw!=='string';
        const data=Buffer.from(raw);let message;
        if(!binary)try{message=JSON.parse(data);}catch{}
        if(message?.type==='session.ready')audit({event:'ready',connection:index,
          last_chunk_ack:sequence(message.last_contiguous_chunk_seq),last_event_seq:sequence(message.last_durable_event_seq)});
        const stable=message?.contract_revision==='transcript.stream.v2'&&message.event_kind==='stable';
        if(stable)audit({event:'stable',connection:index,sequence:sequence(message.event_sequence)});
        if(message?.type==='session.complete')audit({event:'complete',connection:index});
        forward(down,data,binary);
        if(stable&&!faultUsed&&!faultArmed){
          faultArmed=true;
          timer=setTimeout(()=>{
            timer=null;faultArmed=false;
            if(ended)return;
            faultUsed=true;audit({event:'injected_disconnect',connection:index});finish();
          },200);
        }
      });
      for(const stream of [up,down]){
        stream.on('error',()=>{audit({event:'stream_error',connection:index});finish();});
        stream.on('close',code=>{audit({event:'stream_closed',connection:index,code});finish();});
      }
    });
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return{port:server.address().port,close:()=>new Promise(resolve=>{
    for(const pair of pairs){pair.down.terminate();pair.up.terminate();}
    server.close(()=>{wsServer.close();resolve();});
  })};
}

if(require.main===module){
  const [port,token,path]=process.argv.slice(2);
  if(!path)throw Error('port, nonce and private audit path required');
  const audit=row=>fs.appendFileSync(path,JSON.stringify({at_epoch_ms:Date.now(),...row})+'\n');
  startProxy({port:Number(port),token,audit}).then(proxy=>{
    console.log(JSON.stringify({listening:true,port:proxy.port,boundary:'own emulator proxy; real upstream'}));
    process.once('SIGTERM',()=>proxy.close().then(()=>process.exit(0)));
    process.once('SIGINT',()=>proxy.close().then(()=>process.exit(0)));
  }).catch(error=>{console.error(error.code||error.name);process.exitCode=1;});
}
module.exports={startProxy,audioMetadata};
