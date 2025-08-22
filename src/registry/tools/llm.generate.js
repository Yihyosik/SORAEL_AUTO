// src/registry/tools/llm.generate.js
const { OpenAI } = require('openai');
const cfg = require('../../config');
const PERSONA = require('../../persona');

module.exports = async function llmGenerate(args){
  const client = new OpenAI({ apiKey: cfg.OPENAI_API_KEY });
  const {
    prompt = '',
    temperature = cfg.OPENAI_TEMPERATURE,
    model = cfg.OPENAI_MODEL,
    max_tokens = Math.min(cfg.OPENAI_MAX_TOKENS || 1024, 1024) // 과도 길이 방지
  } = args || {};

  const STYLE = `
${PERSONA}

[대화 규칙 — Telegram 최적화]
- 반드시 **짧고 명확**하게 답합니다.
- 불릿/번호로 **최대 5줄**까지만 요약합니다.
- 코드/마크다운 블록은 **가급적 피합니다**(파싱 오류 방지).
- 더 자세한 자료가 필요하면 **한 줄 제안(Q1~Q3)** 만 덧붙입니다.
`;

  const r = await client.chat.completions.create({
    model, temperature, max_tokens,
    messages: [
      { role: 'system', content: STYLE },
      { role: 'user', content: prompt }
    ]
  });

  return r.choices?.[0]?.message?.content || '';
};
