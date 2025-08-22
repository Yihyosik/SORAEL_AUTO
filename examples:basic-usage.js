// Soraiel Basic Usage Examples (v1.1.1-compatible)
const axios = require('axios');
const crypto = require('crypto');

const BASE_URL = process.env.SORAIEL_URL || 'http://localhost:8080';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'your_admin_token';
const RTA_WEBHOOK_SECRET = process.env.RTA_WEBHOOK_SECRET || 'webhook_secret_change_this';

const api = axios.create({
  baseURL: BASE_URL,
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ADMIN_TOKEN}` },
  timeout: 20000
});

async function orchestrateAndExecute(instruction, context = {}) {
  const plan = await api.post('/orchestrate', { instruction, context }).then(r => r.data);
  const out = await api.post('/execute', { planId: plan.planId, steps: plan.steps }).then(r => r.data);
  return { plan, out };
}

async function simpleChatExample() {
  console.log('📝 Example 1: Simple Chat');
  const { plan, out } = await orchestrateAndExecute(
    '안녕하세요라고 인사하고, 오늘 날짜와 날씨에 대해 물어보세요',
    { language: 'korean' }
  );
  console.log('planId:', plan.planId);
  console.log('outputs:', out.outputs);
}

async function searchAndSummarize() {
  console.log('\n🔍 Example 2: Search and Summarize');
  const { out } = await orchestrateAndExecute(
    '최신 AI 뉴스를 검색하고 한국어로 3줄 요약해줘',
    { maxResults: 5, language: 'korean' }
  );
  console.log('outputs:', out.outputs);
}

async function webhookTriggerExample() {
  console.log('\n🔗 Example 3: Webhook Trigger');
  const bodyObj = { topic: 'news.daily', instruction: '오늘 AI 톱3 기사 요약', context: { lang: 'ko' } };
  const bodyStr = JSON.stringify(bodyObj);
  const ts = Date.now().toString();
  const sig = crypto.createHmac('sha256', RTA_WEBHOOK_SECRET).update(`${ts}.${bodyStr}`).digest('hex'); // ts.body 서명

  const res = await axios.post(`${BASE_URL}/rta/webhook`, bodyStr, {
    headers: { 'Content-Type': 'application/json', 'x-timestamp': ts, 'x-signature': sig },
    timeout: 20000
  });
  console.log('webhook result:', res.data);
}

async function parallelExecution() {
  console.log('\n⚡ Example 4: Parallel Execution');
  const tasks = [
    { instruction: 'Bitcoin 현재 가격 확인', context: { currency: 'KRW' } },
    { instruction: 'Ethereum 현재 가격 확인', context: { currency: 'KRW' } },
    { instruction: 'AI 관련 주식 TOP 5', context: { market: 'NASDAQ' } }
  ];
  const plans = await Promise.all(tasks.map(t => api.post('/orchestrate', t).then(r => r.data)));
  const results = await Promise.all(plans.map(p => api.post('/execute', { planId: p.planId, steps: p.steps }).then(r => r.data)));
  results.forEach((r, i) => console.log(`Task ${i + 1}:`, r.outputs));
}

async function main() {
  console.log('🌌 Soraiel Examples Starting…\n');
  const health = await api.get('/healthz').then(r => r.data);
  console.log('System Status:', health);
  console.log('---\n');

  await simpleChatExample();
  await searchAndSummarize();
  await webhookTriggerExample();
  await parallelExecution();

  console.log('\n✅ All examples completed successfully!');
}

if (require.main === module) { main().catch(e => { console.error('❌ Error:', e.response?.data || e.message); process.exit(1); }); }

module.exports = { simpleChatExample, searchAndSummarize, webhookTriggerExample, parallelExecution };