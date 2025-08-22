const fetch = require('node-fetch');

async function sendTelegramMessage(chatId, text, opts = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not set');

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    parse_mode: opts.parse_mode || 'HTML',
    disable_web_page_preview: true
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(`telegram send failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

module.exports = { sendTelegramMessage };
