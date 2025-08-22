const cron = require('node-cron');
const { verifyHmac } = require('./utils/hmac');
const { orchestrate } = require('./orchestrate');
const { execute } = require('./execute');
const cfg = require('./config');

function registerCron(app){
  // 여기서는 매 분 동작 확인 로그만 남김 (외부 스케줄러 사용 권장)
  cron.schedule('* * * * *', async ()=>{ app.log && app.log.info('tick'); });
}

async function handleWebhook(req,res){
  const raw = req.rawBody || JSON.stringify(req.body||{});
  const sig = req.headers['x-signature'];
  const ts = req.headers['x-timestamp'];
  if(!verifyHmac(raw, cfg.RTA_WEBHOOK_SECRET, sig, ts)) return res.status(401).json({ ok:false });
  const instruction = req.body?.instruction || 'webhook-triggered';
  const context = req.body?.context || {};
  const plan = await orchestrate(instruction, context);
  const out = await execute({ planId: plan.planId, steps: plan.steps });
  res.json({ ok:true, planId: plan.planId, out });
}

module.exports={ registerCron, handleWebhook };
