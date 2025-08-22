const express = require('express');
const bodyParser = require('body-parser');
const cfg = require('./config');
const { applySecurity, requestId } = require('./security');
const { orchestrate } = require('./orchestrate');
const { execute } = require('./execute');
const { registerCron, handleWebhook } = require('./rta');
const { sendTelegramMessage } = require('./integrations/telegram');

const app = express();

/**
 * Render/Cloudflare 등 Reverse Proxy 뒤에서 실제 클라이언트 IP를 신뢰하도록 설정
 */
app.set('trust proxy', 1);

// raw body 캡처 (HMAC 서명 검증용)
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

// ───── Health Checks ─────
app.get('/healthz', (_req, res) =>
  res.json({ ok: true, env: cfg.NODE_ENV, version: 'v1.1.1' })
);
app.get('/readyz', (_req, res) => res.json({ ok: true }));

// ───── Core Orchestration ─────
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
  res.json({
    ok: true,
    msg: 'Hot-reload tools by updating src/registry/tools and re-deploying'
  });
});

// ───── RTA (자동화) ─────
app.post('/rta/webhook', handleWebhook);
registerCron(app);

// ───── Telegram Webhook ─────
app.post('/integrations/telegram/webhook', async (req, res) => {
  try {
    // 보안: secret token 검증 (setWebhook 시 함께 등록)
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET || '';
    const got = req.headers['x-telegram-bot-api-secret-token'];
    if (secret && got !== secret) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const update = req.body || {};
    const msg = update.message || update.edited_message;
    const chatId = msg?.chat?.id;
    const text = msg?.text || '';

    if (chatId) {
      const reply = text
        ? `소라엘이 받았어요:\n\n${text}`
        : '소라엘이 웹훅을 받았어요.';
      await sendTelegramMessage(chatId, reply);
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[tg.webhook]', e);
    return res.status(200).json({ ok: true }); // TG는 항상 200 응답이 안전
  }
});

// ───── Start Server ─────
app.listen(cfg.PORT, () => console.log(`soraiel v1.1.1 on :${cfg.PORT}`));
