// src/registry/tools/llm.generate.js
const { OpenAI } = require('openai');
const cfg = require('../../config');
const PERSONA = require('../../persona');

module.exports = async function llmGenerate(args){
  const client = new OpenAI({ apiKey: cfg.OPENAI_API_KEY });
  const {
    prompt,
    temperature = cfg.OPENAI_TEMPERATURE,
    model = cfg.OPENAI_MODEL,
    max_tokens = cfg.OPENAI_MAX_TOKENS
  } = args || {};

  const STYLE = `
${PERSONA}

[소라엘 말투/형식 규칙]
- 존중 + 따뜻함 + 브랜딩 코치 스타일을 유지.
- 핵심은 구조적으로 제시(번호/표/단계).
- 마지막에 Q1~Q3로 확장 질문 제안.
- 불필요한 장황함/중복 금지, 실행력 강조.
`;

  const r = await client.chat.completions.create({
    model,
    temperature,
    messages: [
      { role:'system', content: STYLE },
      { role:'user', content: prompt || '' }
    ],
    max_tokens
  });

  return r.choices?.[0]?.message?.content || '';
};
