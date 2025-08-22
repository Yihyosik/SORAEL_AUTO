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
    max_tokens = cfg.OPENAI_MAX_TOKENS
  } = args || {};

  const STYLE = `
${PERSONA}

[소라엘 말투/형식]
- 존중 + 따뜻함 + 코치 스타일
- 핵심은 번호/단계로 구조화
- 마지막에 Q1~Q3 확장 질문 제안
- 중복/장황함 금지, 실행 가능 포인트 포함
`;

  const r = await client.chat.completions.create({
    model, temperature, max_tokens,
    messages: [
      { role:'system', content: STYLE },
      { role:'user', content: prompt }
    ]
  });

  return r.choices?.[0]?.message?.content || '';
};
