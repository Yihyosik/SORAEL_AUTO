const express = require('express');
const bodyParser = require('body-parser');
const cfg = require('./config');
const { applySecurity, requestId } = require('./security');
const { orchestrate } = require('./orchestrate');
const { execute } = require('./execute');
const { registerCron, handleWebhook } = require('./rta');
const { sendTelegramMessage } = require('./integrations/telegram');

const app = express();
app.set('trust proxy', 1);

app.use(bodyParser.json({
  limit: '2mb',
  verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); }
}));

app.use(requestId);
applySecurity(app);

/* ───────── 공용 ───────── */
function requireAdmin(req, res, next) {
  const tok = (req.headers['authorization'] || '').replace('Bearer ', '');
  if (tok && tok === cfg.ADMIN_TOKEN) return next();
  return res.status(401).json({ ok:false, error:'unauthorized' });
}

app.get('/healthz', (_req,res)=> res.json({ ok:true, env:cfg.NODE_ENV, version:'v1.1.1' }));
app.get('/readyz', (_req,res)=> res.json({ ok:true }));

app.post('/orchestrate', requireAdmin, async (req,res)=>{
  const { instruction, context } = req.body || {};
  const plan = await orchestrate(instruction, context);
  res.json(plan);
});

app.post('/execute', requireAdmin, async (req,res)=>{
  const { planId, steps } = req.body || {};
  const out = await execute({ planId, steps });
  res.json(out);
});

app.post('/deploy', requireAdmin, async (_req,res)=>{
  res.json({ ok:true, msg:'Hot-reload tools by updating src/registry/tools and re-deploying' });
});

app.post('/rta/webhook', handleWebhook);
registerCron(app);

/* ───────── 텔레그램 대화: 자연어 → (필요 시) 검색 → 요약 ───────── */

const processedUpdateIds = new Set();
const DEDUPE_TTL_MS = 5 * 60 * 1000;
setInterval(()=> processedUpdateIds.clear(), DEDUPE_TTL_MS);

function looksLikeSearch(text='') {
  const t = text.toLowerCase();
  return /(검색|search|뉴스|news|http:\/\/|https:\/\/|링크|기사|최신)/.test(t);
}

function formatOutputs(outputs) {
  try {
    if (!outputs) return '결과가 비어 있습니다.';
    if (typeof outputs === 'string') return outputs;
    if (outputs['llm.generate'] && typeof outputs['llm.generate'] === 'string')
      return outputs['llm.generate'];
    for (const v of Object.values(outputs))
      if (typeof v === 'string') return v;
    const txt = JSON.stringify(outputs);
    return txt.length > 1400 ? txt.slice(0,1400) + '\n…(생략)' : txt;
  } catch { return '결과 포맷 중 오류가 발생했습니다.'; }
}

app.post('/integrations/telegram/webhook', async (req, res) => {
  try {
    // 보안: Webhook secret 검증
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET || '';
    const got = req.headers['x-telegram-bot-api-secret-token'];
    if (secret && got !== secret) return res.status(401).json({ ok:false });

    const update = req.body || {};
    const upId = update.update_id;
    // 빠른 200 (TG는 응답 지연 시 재시도)
    res.status(200).json({ ok:true });

    // 중복 업데이트 방지
    if (processedUpdateIds.has(upId)) return;
    processedUpdateIds.add(upId);

    const msg = update.message || update.edited_message || {};
    const chatId = msg?.chat?.id;
    const text = (msg?.text || '').trim();
    if (!chatId) return;

    // 기본 안내/시작
    if (!text || text === '/start') {
      await sendTelegramMessage(chatId,
        '안녕하세요, 저는 **소라엘**입니다.\n' +
        '그냥 자연어로 말씀해 주세요. 예)\n' +
        '• Google CSE로 AI 뉴스 3개 요약\n' +
        '• “내일 일정 요약해”\n' +
        '• “이 문장 다듬어줘: …”'
      );
      return;
    }

    // 이름/자기소개 같은 소규모 대화는 LLM만 사용
    const smallTalk = /(이름|누구|소개|안녕|반가)/.test(text);

    // 컨텍스트 구성: 검색 필요시 엔진 지정
    const context = {
      source: 'telegram',
      chatId,
      language: 'ko',
      ...(looksLikeSearch(text) && !smallTalk ? { engine: 'google.cse' } : {})
    };

    try {
      const plan = await orchestrate(text, context);
      const out  = await execute({ planId: plan.planId, steps: plan.steps });
      await sendTelegramMessage(chatId, formatOutputs(out.outputs));
    } catch (err) {
      // 네트워크/키 이슈 등 사용자 친화적 안내
      const m = String(err?.message || err);
      if (/DNS resolution failed|blocked:|apiKeyInvalid|401/.test(m)) {
        await sendTelegramMessage(
          chatId,
          '요청 처리 중 외부 데이터 소스에서 문제가 발생했어요.\n' +
          '“Google CSE로 …”라고 말씀해 주시면 검색 기반으로 다시 시도할게요.'
        );
      } else {
        await sendTelegramMessage(chatId, '처리 중 문제가 발생했어요. 잠시 후 다시 시도해 주세요.');
      }
      console.error('[tg.webhook]', err);
    }
  } catch (e) {
    console.error('[tg.webhook fatal]', e);
    // TG에는 이미 200을 돌려서 추가 응답은 생략
  }
});

/* ───────── Start ───────── */
app.listen(cfg.PORT, ()=> console.log(`soraiel v1.1.1 on :${cfg.PORT}`));
