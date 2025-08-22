const { getRegistry } = require('./registry');
const { logRun } = require('./logging');

function deref(obj, bag){
  if(!obj || typeof obj!=='object') return obj;
  if(typeof obj==='string' && obj.startsWith('$ref:')) return bag[obj.slice(5)];
  if(Array.isArray(obj)) return obj.map(v=>deref(v,bag));
  const out={}; for(const [k,v] of Object.entries(obj))
    out[k]= typeof v==='string' && v.startsWith('$ref:') ? bag[v.slice(5)] : deref(v,bag);
  return out;
}

async function execute({ planId, steps }){
  const reg = getRegistry();
  const ctx = {}; const outputs={};
  const started=Date.now();
  for(const s of steps){
    const handler = reg[s.tool];
    if(!handler) throw new Error(`unknown-tool:${s.tool}`);
    const args = deref(s.args||{}, ctx);
    let result = await handler(args, ctx);
    if(s.saveAs) ctx[s.saveAs]=result;
    outputs[s.name||s.tool]=result;
  }
  const took = Date.now()-started;
  await logRun(planId||`adhoc-${Date.now()}`, { steps, outputs, duration: took, success: true });
  return { ok:true, outputs, tookMs: took };
}

module.exports={ execute };
