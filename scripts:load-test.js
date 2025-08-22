const axios = require('axios');
const { performance } = require('perf_hooks');
const crypto = require('crypto');

const BASE_URL = process.env.SORAIEL_URL || 'http://localhost:8080';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test_token';
const RTA_WEBHOOK_SECRET = process.env.RTA_WEBHOOK_SECRET || 'webhook_secret';

class LoadTester {
  constructor(cfg = {}) {
    this.config = { concurrent: cfg.concurrent || 10, duration: cfg.duration || 60_000, rampUp: cfg.rampUp || 5_000 };
    this.stats = { requests: 0, errors: 0, latencies: [], startTime: null, endTime: null };
    this.api = axios.create({
      baseURL: BASE_URL,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ADMIN_TOKEN}` },
      timeout: 12_000, validateStatus: () => true
    });
  }

  async runTest() {
    console.log('🚀 Starting Load Test');
    console.log(`  Concurrent: ${this.config.concurrent}\n`);
    this.stats.startTime = Date.now();
    const gap = this.config.rampUp / this.config.concurrent;
    const workers = [];
    for (let i = 0; i < this.config.concurrent; i++) { await this.sleep(gap); workers.push(this.worker(i)); }
    await Promise.all(workers);
    this.stats.endTime = Date.now();
    this.printResults();
  }

  async worker() {
    const until = this.stats.startTime + this.config.duration;
    while (Date.now() < until) {
      const pick = Math.random();
      if (pick < 0.6) await this.measure(() => this.scenarioOrchestrateExecute());
      else if (pick < 0.8) await this.measure(() => this.scenarioHealth());
      else await this.measure(() => this.scenarioWebhook());
      await this.sleep(Math.random() * 800);
    }
  }

  async measure(fn) {
    const t0 = performance.now();
    try {
      const res = await fn();
      const dt = performance.now() - t0;
      this.stats.requests++; this.stats.latencies.push(dt);
      if (res.status >= 400) this.stats.errors++;
    } catch { this.stats.errors++; this.stats.latencies.push(performance.now() - t0); }
  }

  scenarioHealth() { return this.api.get('/healthz'); }

  async scenarioOrchestrateExecute() {
    const plan = await this.api.post('/orchestrate', { instruction: 'Load test ' + Math.random(), context: { test: true } });
    return this.api.post('/execute', { planId: plan.data.planId, steps: plan.data.steps });
  }

  async scenarioWebhook() {
    const body = { topic: 'load', instruction: 'ping', context: { n: Math.random() } };
    const raw = JSON.stringify(body);
    const ts = Date.now().toString();
    const sig = crypto.createHmac('sha256', RTA_WEBHOOK_SECRET).update(`${ts}.${raw}`).digest('hex');
    return axios.post(`${BASE_URL}/rta/webhook`, raw, { headers: { 'x-timestamp': ts, 'x-signature': sig, 'Content-Type': 'application/json' } });
  }

  sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  printResults() {
    const dur = (this.stats.endTime - this.stats.startTime) / 1000;
    const rps = this.stats.requests / dur;
    const errRate = (this.stats.errors / Math.max(1, this.stats.requests)) * 100;
    const sorted = this.stats.latencies.sort((a, b) => a - b);
    const pick = p => sorted[Math.floor(sorted.length * p)] || 0;
    const avg = sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length);
    console.log('\n==============================');
    console.log('📊 LOAD TEST RESULTS');
    console.log('==============================');
    console.log(`Duration: ${dur.toFixed(2)}s  |  Total: ${this.stats.requests}  |  RPS: ${rps.toFixed(1)}  |  Errors: ${this.stats.errors} (${errRate.toFixed(2)}%)`);
    console.log(`Latency (ms): avg ${avg.toFixed(1)}  p50 ${pick(0.5).toFixed(1)}  p95 ${pick(0.95).toFixed(1)}  p99 ${pick(0.99).toFixed(1)}`);
  }
}

async function main() {
  console.log('🌌 Soraiel Load Test\n');
  try { await axios.get(`${BASE_URL}/healthz`); console.log('✅ Server healthy\n'); }
  catch { console.error('❌ Server not responding'); process.exit(1); }
  const tester = new LoadTester({
    concurrent: parseInt(process.argv[2] || '10', 10),
    duration: parseInt(process.argv[3] || '60000', 10),
    rampUp: parseInt(process.argv[4] || '5000', 10)
  });
  await tester.runTest();
}

if (require.main === module) main().catch(e => { console.error('Load test failed:', e.response?.data || e.message); process.exit(1); });
module.exports = LoadTester;