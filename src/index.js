const express = require('express');
const bodyParser = require('body-parser');
const cfg = require('./config');
const { applySecurity, requestId } = require('./security');
const { orchestrate } = require('./orchestrate');
const { execute } = require('./execute');
const { registerCron, handleWebhook } = require('./rta');
const { sendTelegramMessage } = require('./integrations/telegram');

const app = express();

/** Render/Cloudflare 프록시 뒤 실 IP 인식 (rate-limit/로깅용) */
app.set('trust proxy', 1);

/** raw body 캡처 (HMAC 검증/디버그용) */
app.use(bodyParser.json({
  limit: '2mb',
  verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); }
}));

app.use(requestId);
applySecurity(app);

/** 관리자 토큰 검사 */
function requireAdmin(req, res, next) {
  const tok = (req.headers['authorization'] || '').replace('Bearer ', '');
  if (tok && tok === cfg.ADMIN_TOKEN) return next();
  res.status(401).json({ ok: false, error: 'unauthorized' });
}

/** Health */
app.get('/healthz', (_req, res) =>
  res.json({ ok: true, env: cfg.NODE_ENV, version: 'v1.1.1' })
);
app.get('/readyz', (_req, res) => res.json({ ok: true }));

/** Core: 계획 생성 */
app.post('/orchestrate', requireAdmin, async (req, res) => {
  const { instruction, context } = req.body || {};
  const plan = await orchestrate(instruction, context);
  res.json(plan);
});

/** Core: 실행 */
app.post('/execute', requireAdmin, async (req, res) => {
  const { planId, steps } = req.body || {};
  const out = await execute({ planId, steps });
  res.json(out);
});

/** 임시 /deploy 안내 */
app.post('/deploy', requireAdmin, async (_req, res) => {
  res.json({
    ok: true,
    msg: 'Hot-reload tools by updating src/registry/tools and re-deploying'
  });
});

/** RTA Webhook */
app.post('/rta/webhook', handleWebhook);
registerCron(app);

/* ──────────────────────────────────────────────────────────────
 * Telegram Webhook (대화형: 사용자가 보낸 텍스트 → 오케스트레이트 후 결과 회신)
 * - 에코가 아니라 LLM 계획/실행 결과를 요약해서 답변
 * - 중복 업데이트(텔레그램 재시도) 방지
 * ────────────────────────────────────────────────────────────── */
const processedUpdateIds = new Map(); // update_id -> timestamp (ms)
const DEDUPE_TTL_MS = 5 * 60 * 1000;  // 5분

function isDuplicate(update_id) {
  const now = Date.now();
  // TTL 지난 항목 정리 (가벼운 GC)
  for (const [k, t] of processedUpdateIds) {
    if (now - t > DEDUPE_TTL_MS) processedUpdateIds.delete(k);
  }
  if (processedUpdateIds.has(update_id)) return true;
  processedUpdateIds.set(update_id, now);
  return false;
}

/** 결과 포맷 helper */
function formatOutputs(outputs) {
  try {
    if (!outputs) return '결과가 비어 있습니다.';
    // 사람이 읽기 쉽게 가장 유용해 보이는 값을 추출
    if (typeof outputs === 'string') return outputs;
    // llm.generate 우선
    if (outputs['llm.generate'] && typeof outputs['llm.generate'] === 'string') {
      return outputs['llm.generate'];
    }
    // 첫 문자열 값
    for (const v of Object.values(outputs)) {
      if (typeof v === 'string') return v;
    }
    // JSON 요약
    const txt = JSON.stringify(outputs);
    return txt.length > 1500 ? txt.slice(0, 1500) + '\n…(생략)' : txt;
  } catch {
    return '결과 포맷 중 오류가 발생했습니다.';
  }
}

app.post('/integrations/telegram/webhook', async (req, res) => {
  try {
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET || '';
    const got = req.headers['x-telegram-bot-api-secret-token'];
    if (secret && got !== secret) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const update = req.body || {};
    const updateId = update.update_id;
    if (typeof updateId === 'number' && isDuplicate(updateId)) {
      // 텔레그램 재전송 중복 방지
      return res.status(200).json({ ok: true, dedupe: true });
    }

    const msg = update.message || update.edited_message || {};
    const chatId = msg?.chat?.id;
    const text = (msg?.text || '').trim();

    // Telegram은 빠른 200 선호 (처리는 비동기로)
    res.status(200).json({ ok: true });

    if (!chatId) return;

    // 명령 처리
    if (text.startsWith('/start')) {
      await sendTelegramMessage(
        chatId,
        '안녕하세요, 소라엘입니다. 원하는 작업을 자연어로 말씀해 주세요.\n예) "Google 검색으로 AI 최신 뉴스 3개 요약해줘"'
      );
      return;
    }

    if (!text) {
      await sendTelegramMessage(chatId, '빈 메시지를 받았어요. 내용을 입력해 주세요.');
      return;
    }

    // 핵심: 사용자의 텍스트를 그대로 지시문으로 사용
    // Google CSE를 기본 검색 엔진으로 강제하려면 context에 engine 지정
    const context = { source: 'telegram', chatId, engine: 'google.cse', language: 'ko' };

    const plan = await orchestrate(text, context);
    const out = await execute({ planId: plan.planId, steps: plan.steps });

    const reply = formatOutputs(out.outputs);
    await sendTelegramMessage(chatId, reply);
  } catch (e) {
    console.error('[tg.webhook]', e);
    try {
      const chatId = req?.body?.message?.chat?.id;
      if (chatId) await sendTelegramMessage(chatId, '처리 중 문제가 발생했어요. 다시 시도해 주세요.');
    } catch {}
    // 텔레그램에는 이미 200을 보냈거나, 여기서 추가 전송 실패해도 무시
  }
});

// ───── Start Server ─────
app.listen(cfg.PORT, () => console.log(`soraiel v1.1.1 on :${cfg.PORT}`));
