---

## 1-5) `src/index.js`  *(핫픽스 반영 — bodyParser verify로 raw body 캡처)*
```js
const express = require('express');
const bodyParser = require('body-parser');
const cfg = require('./config');
const { applySecurity, requestId } = require('./security');
const { orchestrate } = require('./orchestrate');
const { execute } = require('./execute');
const { registerCron, handleWebhook } = require('./rta');

const app = express();

// raw body 캡처를 body-parser의 verify 훅에서 처리 (스트림 중복 소비 방지)
app.use(bodyParser.json({ limit: '2mb', verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));
app.use(requestId);
applySecurity(app);

function requireAdmin(req,res,next){
  const tok = (req.headers['authorization']||'').replace('Bearer ','');
  if(tok && tok===cfg.ADMIN_TOKEN) return next();
  res.status(401).json({ ok:false, error:'unauthorized' });
}

app.get('/healthz', (_req,res)=> res.json({ ok:true, env: cfg.NODE_ENV, version:'v1.1.1' }));
app.get('/readyz', (_req,res)=> res.json({ ok:true }));

app.post('/orchestrate', requireAdmin, async (req,res)=>{
  const { instruction, context } = req.body||{};
  const plan = await orchestrate(instruction, context);
  res.json(plan);
});

app.post('/execute', requireAdmin, async (req,res)=>{
  const { planId, steps } = req.body||{};
  const out = await execute({ planId, steps });
  res.json(out);
});

app.post('/deploy', requireAdmin, async (_req,res)=>{
  // v1.1: 도구 핫리로드는 깃/배포로 관리. (/deploy 계약은 후속 버전에서 확장)
  res.json({ ok:true, msg:'Hot-reload tools by updating src/registry/tools and re-deploying' });
});

app.post('/rta/webhook', handleWebhook);

registerCron(app);

app.listen(cfg.PORT, ()=> console.log(`soraiel v1.1.1 on :${cfg.PORT}`));

얘는 파일 이름이 뭐야?