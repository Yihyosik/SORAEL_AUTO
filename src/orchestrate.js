const { OpenAI } = require('openai');
const cfg = require('./config');

const client = new OpenAI({ apiKey: cfg.OPENAI_API_KEY });
const SYSTEM = 'You are a planner. Output STRICT JSON: {ok, planId, steps:[{tool, args, saveAs?}]}. Tools: llm.generate, http.fetch, pipeline.run. Use $ref like "$ref:prev" to refer to saved variables.';

async function orchestrate(instruction, context){
  const planId = require('crypto').randomUUID();
  const user = `Instruction: ${instruction}\nContext: ${JSON.stringify(context||{})}`;
  const r = await client.chat.completions.create({
    model: cfg.OPENAI_MODEL, temperature: 0.2,
    messages:[ { role:'system', content: SYSTEM }, { role:'user', content: user } ],
    response_format: { type:'json_object' }
  });
  const content = r.choices?.[0]?.message?.content || '{}';
  const plan = JSON.parse(content);
  plan.ok = true; plan.planId = planId; if(!Array.isArray(plan.steps)) plan.steps=[];
  return plan;
}

module.exports = { orchestrate };
