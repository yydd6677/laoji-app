// Metro admits one debugger per runtime. A second observer otherwise closes
// the first observer's live connection; it is not an app/network failure.
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {randomUUID}=require('node:crypto');
async function acquireInspectionLock({file=path.join(os.tmpdir(),`laoji-cdp-${process.getuid?.()??'local'}-8083.lock`),timeoutMs=60000}={}){
  const deadline=Date.now()+timeoutMs,token=randomUUID();
  while(true){
    try{
      const descriptor=fs.openSync(file,'wx',0o600);
      try{fs.writeFileSync(descriptor,JSON.stringify({schema:1,pid:process.pid,token}));}
      catch(error){fs.closeSync(descriptor);fs.unlinkSync(file);throw error;}
      fs.closeSync(descriptor);
      const release=()=>{
        try{const owner=JSON.parse(fs.readFileSync(file,'utf8'));
          if(owner.token===token&&owner.pid===process.pid)fs.unlinkSync(file);
        }catch{}
        process.removeListener('exit',release);
      };
      process.once('exit',release);return release;
    }catch(error){
      if(error.code!=='EEXIST')throw error;
      // Recover only this tool's stopped owner, not an unknown/live lock.
      try{
        const raw=fs.readFileSync(file,'utf8'),owner=JSON.parse(raw),stat=fs.lstatSync(file);
        if(stat.isFile()&&(!process.getuid||stat.uid===process.getuid())&&owner.schema===1
          &&Number.isSafeInteger(owner.pid)&&owner.pid>0&&/^[0-9a-f-]{36}$/.test(owner.token)){
          let stopped=false;try{process.kill(owner.pid,0);}catch(e){stopped=e.code==='ESRCH';}
          if(stopped&&fs.readFileSync(file,'utf8')===raw){fs.unlinkSync(file);continue;}
        }
      }catch{}
      if(Date.now()>=deadline)throw Error('Another inspection is active or unverifiable; native work may still be running');
      await new Promise(resolve=>setTimeout(resolve,Math.min(50,Math.max(1,deadline-Date.now()))));
    }
  }
}
module.exports={acquireInspectionLock};
