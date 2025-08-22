// src/integrations/telegram.js
const fetch = require('node-fetch');

const TG_LIMIT = 4096;         // 텔레그램 최대 길이
const SAFE_CHUNK = 3900;       // 여유 잡고 안전 청크

function splitMessage(text) {
  if (!text) return [''];
  if (text.length <= SAFE_CHUNK) return [text];

  const out = [];
  let buf = '';
  const lines = String(text).split(/\n/);
  for (const line of lines) {
    if ((buf + '\n' + line).length > SAFE_CHUNK) {
      out.push(buf);
      buf = line;
    } else {
      buf = buf ? buf + '\n' + line : line;
    }
  }
  if (buf) out.push(buf);
  // 최후 방어: 여전히 길면 하드 컷
  return out.flatMap(chunk => {
    if (chunk.length <= SAFE_CHUNK) return [chunk];
    const arr = [];
    for (let i = 0; i < chunk.length; i += SAFE_CHUNK) {
      arr.push(chunk.slice(i, i + SAFE_CHUNK));
    }
    return arr;
  });
}

/**
 * 순수 텍스트 전송 (parse_mode 사용 안 함)
 * - Markdown/HTML 파싱 오류 방지
 * - 자동 청크 전송
 */
async function sendTelegramMessage(chatId, text, opts = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not set');
  if (!chatId) throw new Error('telegram: chatId required');

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const chunks = splitMessage(String(text));

  for (const part of chunks) {
    const body = {
      chat_id: chatId,
      text: part,
      disable_web_page_preview: true, // 미리보기 비활성화
      // parse_mode: 사용하지 않음 (Markdown/HTML 파싱 오류 방지)
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
  }
  return { ok: true, sent: chunks.length };
}

module.exports = { sendTelegramMessage };
