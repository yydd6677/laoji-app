// Resolve only the exact module in this active dev runtime. Never reuse IDs
// from an old bundle or download tens of MB just to inspect a small state.
function runtimeModuleExpression(modulePath) {
  return `(()=>{
    if(typeof __r!=='function'||typeof __r.getModules!=='function')throw Error('Inspectable Metro module registry unavailable');
    const matches=[];
    for(const [id,entry] of __r.getModules())if(entry.verboseName===${JSON.stringify(modulePath)})matches.push(id);
    if(matches.length!==1)throw Error('Expected one exact active runtime module');
    return __r(matches[0]);
  })()`;
}
function selectRuntimeTarget(targets) {
  const candidates=targets.filter(t=>t.appId==='com.laoji.app'&&t.deviceName?.startsWith('sdk_gphone64_x86_64'));
  if(candidates.length!==1)throw Error('Expected one unambiguous LaoJi emulator runtime');
  return candidates[0];
}
module.exports={runtimeModuleExpression,selectRuntimeTarget};
