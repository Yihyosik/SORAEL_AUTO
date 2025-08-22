const fs = require('fs');
const path = require('path');
const pino = require('pino');
const cfg = require('./config');

const logDir = path.join(__dirname,'..','logs');
const runsDir = path.join(__dirname,'..','runs');
const metricsDir = path.join(__dirname,'..','metrics');
[logDir, runsDir, metricsDir].forEach(d=>{ if(!fs.existsSync(d)) fs.mkdirSync(d,{recursive:true}); });

function mask(obj){
  if(!obj || typeof obj!=='object') return obj;
  const sens=['password','token','key','secret','authorization','api_key','apikey'];
  const out=Array.isArray(obj)?[]:{};
  for(const k in obj){
    const v=obj[k]; const lk=k.toLowerCase();
    if(sens.some(s=>lk.includes(s))) out[k]='***REDACTED***';
    else out[k]=typeof v==='object'?mask(v):v;
  }
  return out;
}

const logger=pino({ level: cfg.LOG_LEVEL },
  pino.destination(path.join(logDir,`soraiel-${new Date().toISOString().slice(0,10)}.log`)));

class Metrics{
  constructor(){ this.counters={}; this.timers={}; }
  inc(name){ this.counters[name]=(this.counters[name]||0)+1; }
  time(name,ms){ (this.timers[name] ||= []).push(ms); }
  flush(){ const ts=Date.now(); const data={ ts, counters:this.counters, timers:this.timers };
    fs.writeFileSync(path.join(metricsDir,`metrics-${ts}.json`), JSON.stringify(data,null,2));
    this.counters={}; this.timers={}; return data; }
}
const metrics=new Metrics();
setInterval(()=>metrics.flush(),60_000);

async function logRun(planId,data){
  const file=path.join(runsDir,`${planId}.json`);
  const payload={ ...mask(data), planId, ts:new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(payload,null,2));
  logger.info({ planId, steps: data.steps?.length||0 }, '[RUN] plan executed');
}

function logError(ctx,err,meta={}){ logger.error({ ctx, err:err?.message, ...mask(meta) }, '[ERR]'); }
function logInfo(ctx,msg,meta={}){ logger.info({ ctx, ...mask(meta) }, msg); }
function logWarn(ctx,msg,meta={}){ logger.warn({ ctx, ...mask(meta) }, msg); }

module.exports={ logger, metrics, logRun, logError, logInfo, logWarn, mask };