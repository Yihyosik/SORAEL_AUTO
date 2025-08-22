// src/orchestrate.js
const { OpenAI } = require('openai');
const cfg = require('./config');
const PERSONA = require('./persona');

const client = new OpenAI({ apiKey: cfg.OPENAI_API_KEY });

const PLANNER_RULES = `
당신은 '소라엘'의 두뇌(Orchestrator)입니다.
아래 스키마를 100% 준수하여 계획을 출력하세요(STRICT JSON).
출력: {"ok":true, "planId":"...", "steps":[{ "tool": "...", "args": {...}, "saveAs":"..." }]}
도구 목록: "llm.generate" | "http.fetch" | "pipeline.run"
규칙:
- 도구 인자는 최소/정확하게. 불필요한 필드 금지.
- 이전 결과 참조는 {"$ref":"변수명"} 형태.
- 웹 검색/뉴스/링크/URL이 언급되면 기본 검색 엔진은 Google CSE를 우선한다.
- 마지막 유용한 결과엔 반드시 saveAs 부여.
- 예시/가짜 도메인(example.com 등) 금지. 인증 필요한 외부 API는 피하고 CSE로 대체.
`;

function baseSystemPrompt() {
  return `${PERSONA}\n\n${PLANNER_RULES}`;
}

async function makePlan(input) {
  const planId = require('crypto').randomUUID();
  const { instruction, context } = input || {};
  const sys = baseSystemPrompt();
  const user = `지시문: ${instruction}\n컨텍스트: ${JSON.stringify(context||{})}`;

  const r = await client.chat.completions.create({
    model: cfg.OPENAI_MODEL,
    temperature: 0.2,
    messages: [
      { role:'system', content: sys },
      { role:'user', content: user }
    ],
    response_format: { type:'json_object' }
  });

  const content = r.choices?.[0]?.message?.content || '{}';
  const plan = JSON.parse(content);
  plan.ok = true;
  plan.planId = planId;
  if(!Array.isArray(plan.steps)) plan.steps = [];
  return plan;
}

module.exports = { orchestrate: makePlan };
