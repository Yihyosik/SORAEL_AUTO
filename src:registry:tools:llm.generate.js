const { OpenAI } = require('openai');
const cfg = require('../../config');

module.exports = async function llmGenerate(args){
  const client = new OpenAI({ apiKey: cfg.OPENAI_API_KEY });
  const system = args.system || 'You are helpful.';
  const prompt = args.prompt || '';
  const model = args.model || cfg.OPENAI_MODEL;
  const temperature = args.temperature ?? cfg.OPENAI_TEMPERATURE;
  const max_tokens = args.max_tokens ?? cfg.OPENAI_MAX_TOKENS;
  const r = await client.chat.completions.create({
    model, temperature, max_tokens,
    messages:[ { role:'system', content: system }, { role:'user', content: prompt } ]
  });
  return r.choices?.[0]?.message?.content || '';
};