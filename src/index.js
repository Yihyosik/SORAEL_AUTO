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

function requireAdmin(req, res, next) {
  const tok = (req.headers['authorization'] || '').replace('Bearer ', '');
  if (tok && tok === cfg.ADMIN_TOKEN) return next();
  res.status(401).json({ ok: false, error: 'unauthorized' });
}

app.get('/healthz', (_req, res) => res.json({ ok: true, env: cfg.NODE_ENV, version: 'v1.1.1' }));
app.get('/readyz', (_req, res) => res.json({ ok: true }));

app.post('/orchestrate', requireAdmin, async (req, res) => {
  const { instruction, context } = req.body || {};
  const plan = await orchestrate(instruction, context);
  res.json(plan);
});

app.post('/execute', requireAdmin, async (req, res) => {
  const { planId, steps } = req.body || {};
  const out = await execute({ planId, steps });
  res.json(out);
});

app.post('/deploy', requireAdmin, async (_req, res) => {
  res.json({ ok: true, msg: 'Hot-reload tools by updating src/registry/tools and re-deploying' });
});

app.post('/rta/webhook', handleWebhook);
registerCron(app);

/** ───────── Telegram Webhook: 대화 → (필요 시) 검색 → 요약 ───────── */
const processedUpdateIds = new Set();
const DEDUPE_TTL_MS = 5 * 60 * 1000;
setInterval(() => {
  // 메모리 청소 (간단)
  processedUpdateIds.clear();
}, DEDUPE_TTL_MS);

function looksLikeSearch(text = '') {
  const t = text.toLowerCase();
  return /(검색|search|뉴스|news|http:|https:)/.test(t);
}

function formatOutputs(outputs) {
  try {
    if (!outputs) return '결과가 비어 있습니다.';
    if (typeof outputs === 'string') return outputs;
    if (outputs['llm.generate'] && typeof outputs['llm.generate'] === 'string') {
      return outputs['llm.generate'];
    }
    for (const v of Object.values(outputs)) if (typeof v === 'string') return v;
    const txt = JSON.stringify(outputs);
    return txt.length > 1500 ? txt.slice(0, 1500) + '\n…(생략)' : txt;
  } catch { return '결과 포맷 중 오류가 발생했습니다.'; }
}

app.post('/integrations/telegram/webhook', async (req, res) => {
  try {
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET || '';
    const got = req.headers['x-telegram-bot-api-secret-token'];
    if (secret && got !== secret) return res.status(401).json({ ok: false });

    const update = req.body || {};
    const chatId = update?.message?.chat?.id || update?.edited_message?.chat?.id;
    const text = (update?.message?.text || update?.edited_message?.text || '').trim();

    // 빠른 200
    res.status(200).json({ ok: true });

    // 중복 방지
    const id = update.update_id;
    if (processedUpdateIds.has(id)) return;
    processedUpdateIds.add(id);

    if (!chatId) return;

    if (!text || text.startsWith('/start')) {
      await sendTelegramMessage(chatId,
        '안녕하세요, 소라엘입니다. 원하는 지시를 자연어로 보내주세요.\n예) "Google CSE로 최신 AI 뉴스 3개 요약"');
      return;
    }

    // 기본 정책: 일반 대화 → LLM만. 검색/뉴스/URL 포함 → CSE 우선
    const context = { source: 'telegram', chatId, language: 'ko' };
    if (looksLikeSearch(text)) context.engine = 'google.cse';

    try {
      const plan = await orchestrate(text, context);
      const out = await execute({ planId: plan.planId, steps: plan.steps });
      await sendTelegramMessage(chatId, formatOutputs(out.outputs));
    } catch (e) {
      // 예시/차단 호스트 등 네트워크 오류를 사람말로 안내
      const msg = String(e?.message || e);
      if (/DNS resolution failed|blocked:/.test(msg)) {
        await sendTelegramMessage(
          chatId,
          '요청 중 외부 API 주소가 유효하지 않아서 실패했어요.\n' +
          '검색/뉴스를 원하시면 "Google CSE로 ..."처럼 말씀해 주세요.'
        );
      } else {
        await sendTelegramMessage(chatId, '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
      }
      console.error('[tg.webhook]', e);
    }
  } catch (e) {
    console.error('[tg.webhook]', e);
    try {
      const chatId = req?.body?.message?.chat?.id;
      if (chatId) await sendTelegramMessage(chatId, '처리 중 문제가 발생했어요.');
    } catch {}
  }
});

app.listen(cfg.PORT, () => console.log(`soraiel v1.1.1 on :${cfg.PORT}`));
