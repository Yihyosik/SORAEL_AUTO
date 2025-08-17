// =======================
// Soraiel — vFinal.2 (Self-Repair Edition, 완성본)
// Agent/Orchestrator + Execute + Self-Train + Memory + RTA + Security + Self-Rewrite
// =======================
require('dotenv').config();

// ===== Imports =====
const fs = require('fs/promises');
const path = require('path');
const express = require('express');
const cors = require('cors');
const axiosBase = require('axios');
const crypto = require('crypto');
const vm = require('vm');
const esprima = require('esprima');

const { ChatOpenAI, OpenAIEmbeddings } = require('@langchain/openai');
const { ChatPromptTemplate, MessagesPlaceholder } = require('@langchain/core/prompts');
const { SystemMessage } = require('@langchain/core/messages');
const { BufferMemory } = require('langchain/memory');
const { LLMChain } = require('langchain/chains');

// ===== Constants =====
const VERSION = 'vFinal.2';
const NODE_ENV = process.env.NODE_ENV || 'development';
const PORT = process.env.PORT || 3000;

// ===== Env =====
const {
  OPENAI_API_KEY,
  MAKE_API_KEY,
  GOOGLE_API_KEY,
  GOOGLE_CSE_ID,
  SUPABASE_URL,
  SUPABASE_KEY,
  RENDER_KEY,
  WEBHOOK_SECRET,
  ALLOWED_ORIGINS,
  ALLOWED_AXIOS_HOSTS,
  REWRITE_KEY,
} = process.env;

// ===== Basic Guards =====
function hasSupabase() {
  return !!(SUPABASE_URL && SUPABASE_KEY);
}
function assertAuthHeader(req) {
  const h = String(req.headers['authorization'] || '');
  const ok = h.startsWith('Bearer ') && h.slice(7) === String(RENDER_KEY || '');
  return ok;
}

// ===== Axios (5s timeout + Host whitelist) =====
const allowedHosts = new Set(
  (ALLOWED_AXIOS_HOSTS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);
if (allowedHosts.size === 0 && hasSupabase()) {
  try { allowedHosts.add(new URL(SUPABASE_URL).host); } catch {}
}
allowedHosts.add('www.googleapis.com');
allowedHosts.add('api.openai.com');

const axios = axiosBase.create({ timeout: 5000, maxContentLength: 1_000_000, maxBodyLength: 1_000_000 });
axios.interceptors.request.use((config) => {
  try {
    const url = new URL(config.url, config.baseURL || 'http://localhost');
    if (!allowedHosts.has(url.host)) throw new Error(`Blocked host: ${url.host}`);
  } catch (e) { throw new Error(`Invalid or blocked URL: ${config.url}`); }
  return config;
});

// ===== Metrics =====
const metrics = { startTs: Date.now(), requests: 0, perRoute: {}, llmCalls: 0, lastError: null };
function markRoute(route) { metrics.requests++; metrics.perRoute[route] = (metrics.perRoute[route] || 0) + 1; }

// ===== Rate Limiter (simple token bucket: 20 req/min/IP) =====
const buckets = new Map();
const RATE_CAP = 20; // tokens
const RATE_REFILL_MS = 60_000; // full per minute
function rateLimiter(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.toString().split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const b = buckets.get(ip) || { tokens: RATE_CAP, ts: now };
  const elapsed = now - b.ts;
  const refill = Math.min(RATE_CAP, b.tokens + (elapsed / RATE_REFILL_MS) * RATE_CAP);
  const tokens = refill - 1;
  if (tokens < 0) return res.status(429).json({ ok: false, code: 'RATE_LIMIT', message: 'Too Many Requests' });
  buckets.set(ip, { tokens, ts: now });
  next();
}

// ===== App Setup =====
const app = express();
app.use(express.json({ limit: '2mb' }));

// CORS: production → allowlist, dev → *
const allowlist = (ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // same-origin / curl
    if (NODE_ENV !== 'production') return cb(null, true);
    if (allowlist.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
  credentials: false,
}));

// ===== Static UI =====
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));
app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// ===== Auth (apply to API routes only) =====
function authGuard(req, res, next) {
  if (!assertAuthHeader(req)) return res.status(401).json({ ok: false, code: 'UNAUTHORIZED', message: 'Invalid token' });
  next();
}
app.use(rateLimiter);

// ===== LLM Setup =====
const SORAIEL_IDENTITY = `
당신은 "소라엘". 실무형·정확·단호. 추측 금지. 모르면 모른다.
툴 사용 가능: search, memory.import, memory.search, crm.add, http.fetch, execute, deploy.
항상 JSON 스키마만 출력.
`;
const llm = new ChatOpenAI({ apiKey: OPENAI_API_KEY, model: 'gpt-4o', temperature: 0.3 });
const chatPrompt = ChatPromptTemplate.fromMessages([
  new SystemMessage(SORAIEL_IDENTITY),
  new MessagesPlaceholder('chat_history'),
  ['human', '{input}'],
]);
const memory = new BufferMemory({ returnMessages: true, memoryKey: 'chat_history' });
let chatChain;
async function initializeChatChain() { chatChain = new LLMChain({ llm, prompt: chatPrompt, memory }); }

async function llmJSON(prompt) {
  metrics.llmCalls++;
  const wrapper = `아래 요구를 충족하는 **JSON만** 출력하라. 마크다운·설명 금지.\n\n${prompt}`;
  const r = await llm.invoke(wrapper);
  const raw = (Array.isArray(r.content) ? r.content.map(c => c.text || '').join('') : (r.content || '')).trim();
  const first = raw.indexOf('{'); const last = raw.lastIndexOf('}');
  if (first === -1 || last === -1) throw new Error('LLM_JSON_PARSE_FAIL');
  try { return JSON.parse(raw.slice(first, last + 1)); } catch { throw new Error('LLM_JSON_PARSE_FAIL'); }
}

// ===== Conversation History to Supabase =====
async function saveConversation(user, ai) {
  if (!hasSupabase()) return;
  try {
    await axios.post(`${SUPABASE_URL}/rest/v1/soraiel_history`, [{ ts: new Date().toISOString(), user, ai }], {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Prefer: 'return=minimal' },
    });
  } catch (e) { metrics.lastError = String(e?.message || e); }
}

// ===== Registry (Built-ins) =====
const registry = Object.create(null);
registry['llm.generate'] = async ({ prompt }) => { metrics.llmCalls++; const r = await llm.invoke(prompt); return Array.isArray(r.content) ? r.content.map(c => c.text || '').join('') : (r.content || ''); };
registry['http.fetch'] = async ({ url, method = 'GET', data }) => { const resp = await axios({ url, method, data }); return resp.data; };
registry['search'] = async ({ query, num = 3 }) => {
  if (!GOOGLE_API_KEY || !GOOGLE_CSE_ID) throw new Error('CSE_NOT_CONFIGURED');
  const { data } = await axios.get('https://www.googleapis.com/customsearch/v1', { params: { key: GOOGLE_API_KEY, cx: GOOGLE_CSE_ID, q: query } });
  return (data.items || []).slice(0, num).map(i => ({ title: i.title, link: i.link, snippet: i.snippet }));
};
registry['memory.import'] = async ({ text, meta = {} }) => {
  if (!hasSupabase()) throw new Error('SUPABASE_NOT_CONFIGURED');
  if (!OPENAI_API_KEY) throw new Error('OPENAI_NOT_CONFIGURED');
  const embedder = new OpenAIEmbeddings({ apiKey: OPENAI_API_KEY, model: 'text-embedding-3-small' });
  const [vector] = await embedder.embedDocuments([text]);
  await axios.post(`${SUPABASE_URL}/rest/v1/memory`, [{ text, meta, embedding: vector }], { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Prefer: 'return=minimal' } });
  return { ok: true };
};
registry['memory.search'] = async ({ query, topK = 5 }) => {
  if (!hasSupabase()) throw new Error('SUPABASE_NOT_CONFIGURED');
  const embedder = new OpenAIEmbeddings({ apiKey: OPENAI_API_KEY, model: 'text-embedding-3-small' });
  const [qv] = await embedder.embedDocuments([query]);
  const { data } = await axios.post(`${SUPABASE_URL}/rest/v1/rpc/search_memory`, { query_embedding: qv, match_count: topK }, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
  return data;
};
registry['crm.add'] = async ({ name, email }) => {
  if (!hasSupabase()) throw new Error('SUPABASE_NOT_CONFIGURED');
  await axios.post(`${SUPABASE_URL}/rest/v1/customers`, [{ name, email }], { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Prefer: 'return=minimal' } });
  return { ok: true };
};

// ===== Tool Decision =====
async function decideTool(userMessage) {
  const prompt = `사용자 요청을 보고 다음 JSON만 출력:
{
  "tool": "search|memory-import|memory-search|crm|execute|deploy|chat-only",
  "why": "짧게",
  "steps": [ { "tool": "...", "args": { }, "saveAs": "..." } ],
  "add_tool": { "name": "...", "code": "// JS function export" }
}`;
  try { return await llmJSON(`요청: ${userMessage}\n\n${prompt}`); } catch { return { tool: 'chat-only', why: 'parse-fallback' }; }
}

// ===== Execute Plan =====
async function executeSteps(steps = []) {
  const results = {};
  for (const step of steps) {
    const fn = registry[step.tool];
    if (!fn) throw new Error(`Unknown tool: ${step.tool}`);
    const out = await fn(step.args || {});
    if (step.saveAs) results[step.saveAs] = out;
  }
  return results;
}

// ===== /chat (Agent + Direct Wire to execute/deploy) =====
app.post('/chat', authGuard, async (req, res) => {
  markRoute('/chat');
  try {
    const userMessage = String(req.body.message || '');
    const decision = await decideTool(userMessage);

    let aiResponse = '';
    if (decision.tool === 'execute') {
      const results = await executeSteps(decision.steps || []);
      aiResponse = JSON.stringify({ ok: true, results });
    } else if (decision.tool === 'deploy') {
      const { add_tool } = decision; if (!add_tool?.name || !add_tool?.code) throw new Error('DEPLOY_PAYLOAD_MISSING');
      const ok = await deployTool(add_tool.name, add_tool.code);
      aiResponse = JSON.stringify({ ok, tool: add_tool.name });
    } else if (decision.tool === 'search') {
      aiResponse = JSON.stringify(await registry['search']({ query: userMessage }));
    } else if (decision.tool === 'memory-import') {
      aiResponse = JSON.stringify(await registry['memory.import']({ text: userMessage }));
    } else if (decision.tool === 'memory-search') {
      aiResponse = JSON.stringify(await registry['memory.search']({ query: userMessage }));
    } else if (decision.tool === 'crm') {
      const { name, email } = req.body; aiResponse = JSON.stringify(await registry['crm.add']({ name, email }));
    } else {
      const result = await chatChain.call({ input: userMessage }); aiResponse = String(result?.text || '').trim();
    }

    await saveConversation(userMessage, aiResponse);
    res.json({ ok: true, tool: decision.tool, response: aiResponse });
  } catch (err) {
    metrics.lastError = String(err?.message || err);
    res.status(500).json({ ok: false, code: 'CHAT_FAIL', message: 'Chat 실패', detail: metrics.lastError });
  }
});

// ===== /orchestrate (Goal → Plan JSON) =====
app.post('/orchestrate', authGuard, async (req, res) => {
  markRoute('/orchestrate');
  try {
    const goal = String(req.body.goal || '');
    const plan = await llmJSON(`다음 목표를 달성하기 위한 단계별 계획을 아래 JSON으로 작성하라.

목표: ${goal}

스키마:
{ "planId": "uuid", "steps": [ { "tool": "search|http.fetch|memory.import|memory.search|crm", "args": {}, "saveAs": "..." } ] }`);
    res.json({ ok: true, plan });
  } catch (e) { res.status(500).json({ ok: false, code: 'ORCHESTRATE_FAIL', message: '계획 생성 실패' }); }
});

// ===== /execute & alias /run =====
app.post('/execute', authGuard, async (req, res) => {
  markRoute('/execute');
  try {
    const { steps = [] } = req.body || {};
    const results = await executeSteps(steps);
    if (hasSupabase()) {
      await axios.post(`${SUPABASE_URL}/rest/v1/runs`, [{ ts: new Date().toISOString(), steps, results }], { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Prefer: 'return=minimal' } });
    }
    res.json({ ok: true, results });
  } catch (err) {
    metrics.lastError = String(err?.message || err);
    res.status(500).json({ ok: false, code: 'EXECUTE_FAIL', message: 'execute 실패', detail: metrics.lastError });
  }
});
app.post('/run', authGuard, async (req, res) => { markRoute('/run'); req.url = '/execute'; app._router.handle(req, res); });

// ===== /deploy (Sandboxed Tool Registration) =====
async function deployTool(name, code) {
  // 1) Syntax check
  esprima.parseScript(code);
  // 2) Sandbox
  const context = { console, module: { exports: undefined }, exports: undefined, require: undefined, axios, fetch: undefined, process: { env: {} }, setTimeout, clearTimeout };
  vm.createContext(context);
  // 3) Time limit (3s)
  const run = () => vm.runInContext(code, context, { timeout: 3000 });
  let fn = run(); fn = context.module.exports || fn;
  if (typeof fn !== 'function') throw new Error('Not a function export');
  // 4) Dry-run
  const dry = Promise.race([ Promise.resolve(fn({ test: true })).catch(() => ({})), new Promise((_, rej) => setTimeout(() => rej(new Error('DRYRUN_TIMEOUT')), 3000)) ]);
  await dry;
  // 5) Register
  registry[name] = fn; return true;
}

app.post('/deploy', authGuard, async (req, res) => {
  markRoute('/deploy');
  try {
    const { add_tool } = req.body || {};
    if (!add_tool?.name || !add_tool?.code) return res.status(400).json({ ok: false, code: 'BAD_REQUEST', message: 'name, code required' });
    const ok = await deployTool(add_tool.name, add_tool.code);
    res.json({ ok, name: add_tool.name });
  } catch (err) {
    metrics.lastError = String(err?.message || err);
    res.status(500).json({ ok: false, code: 'DEPLOY_FAIL', message: 'deploy 실패', detail: metrics.lastError });
  }
});

// ===== /self-train (Auto-growth Loop) =====
app.post('/self-train', authGuard, async (req, res) => {
  markRoute('/self-train');
  try {
    const { requirement = '사용자의 새로운 요구를 해결하는 툴' } = req.body || {};
    const spec = await llmJSON(`아래 요구를 해결하는 단일 JS 함수 툴을 설계하고 코드만 JSON으로.
요구: ${requirement}
스키마:{"name":"...","code":"// module.exports = async function(ctx){...}"}`);
    const ok = await deployTool(spec.name, spec.code);
    if (hasSupabase()) {
      await axios.post(`${SUPABASE_URL}/rest/v1/learned_tools`, [{ ts: new Date().toISOString(), name: spec.name, code: spec.code }], { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Prefer: 'return=minimal' } });
    }
    res.json({ ok, tool: spec.name });
  } catch (err) {
    metrics.lastError = String(err?.message || err);
    res.status(500).json({ ok: false, code: 'SELF_TRAIN_FAIL', message: 'self-train 실패', detail: metrics.lastError });
  }
});

// ===== Memory API =====
app.post('/memory/import', authGuard, async (req, res) => {
  markRoute('/memory/import');
  try {
    if (!hasSupabase()) return res.status(503).json({ ok: false, code: 'SUPABASE_OFF', message: 'Supabase 미구성' });
    const { text, meta = {} } = req.body || {};
    const out = await registry['memory.import']({ text, meta });
    res.json(out);
  } catch (err) { res.status(500).json({ ok: false, code: 'MEM_IMPORT_FAIL', message: 'memory import 실패', detail: String(err?.message || err) }); }
});
app.post('/memory/search', authGuard, async (req, res) => {
  markRoute('/memory/search');
  try {
    if (!hasSupabase()) return res.status(503).json({ ok: false, code: 'SUPABASE_OFF', message: 'Supabase 미구성' });
    const { query, topK = 5 } = req.body || {};
    const data = await registry['memory.search']({ query, topK });
    res.json({ ok: true, results: data });
  } catch (err) { res.status(500).json({ ok: false, code: 'MEM_SEARCH_FAIL', message: 'memory search 실패', detail: String(err?.message || err) }); }
});

// ===== CRM =====
app.post('/crm/add', authGuard, async (req, res) => {
  markRoute('/crm/add');
  try {
    if (!hasSupabase()) return res.status(503).json({ ok: false, code: 'SUPABASE_OFF', message: 'Supabase 미구성' });
    const { name, email } = req.body || {};
    const out = await registry['crm.add']({ name, email });
    res.json(out);
  } catch (err) { res.status(500).json({ ok: false, code: 'CRM_ADD_FAIL', message: 'CRM 추가 실패', detail: String(err?.message || err) }); }
});
app.get('/crm/list', authGuard, async (_req, res) => {
  markRoute('/crm/list');
  try {
    if (!hasSupabase()) return res.status(503).json({ ok: false, code: 'SUPABASE_OFF', message: 'Supabase 미구성' });
    const { data } = await axios.get(`${SUPABASE_URL}/rest/v1/customers?select=*`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
    res.json({ ok: true, customers: data });
  } catch (err) { res.status(500).json({ ok: false, code: 'CRM_LIST_FAIL', message: 'CRM 조회 실패', detail: String(err?.message || err) }); }
});

// ===== Content (ebook, video) — Minimal stubs powered by LLM =====
app.post('/ebook', authGuard, async (req, res) => {
  markRoute('/ebook');
  try {
    const { topic } = req.body || {};
    const outline = await registry['llm.generate']({ prompt: `전자책 목차 8개. 주제: ${topic}` });
    res.json({ ok: true, outline });
  } catch (err) { res.status(500).json({ ok: false, code: 'EBOOK_FAIL', message: 'ebook 실패', detail: String(err?.message || err) }); }
});
app.post('/video', authGuard, async (req, res) => {
  markRoute('/video');
  try {
    const { topic } = req.body || {};
    const script = await registry['llm.generate']({ prompt: `60초 영상 스크립트. 주제: ${topic}` });
    res.json({ ok: true, script });
  } catch (err) { res.status(500).json({ ok: false, code: 'VIDEO_FAIL', message: 'video 실패', detail: String(err?.message || err) }); }
});

// ===== RTA (cron rules + webhook with HMAC) =====
const rtaRules = new Map(); // id -> { intervalMs, steps }
app.post('/rta/cron', authGuard, async (req, res) => {
  markRoute('/rta/cron');
  try {
    const { id, intervalMs = 3600000, steps = [] } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, code: 'BAD_REQUEST', message: 'id required' });
    if (rtaRules.has(id)) clearInterval(rtaRules.get(id).timer);
    const timer = setInterval(async () => { try { await executeSteps(steps); } catch (e) { metrics.lastError = String(e?.message || e); } }, intervalMs);
    rtaRules.set(id, { timer, intervalMs, steps });
    res.json({ ok: true, id });
  } catch (err) { res.status(500).json({ ok: false, code: 'RTA_CRON_FAIL', message: 'rta/cron 실패', detail: String(err?.message || err) }); }
});
function verifyHMAC(req) {
  const sig = String(req.headers['x-signature'] || '');
  const body = JSON.stringify(req.body || {});
  const mac = crypto.createHmac('sha256', String(WEBHOOK_SECRET || '')).update(body).digest('hex');
  return sig && mac && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(mac));
}
app.post('/rta/webhook', authGuard, async (req, res) => {
  markRoute('/rta/webhook');
  try {
    if (!WEBHOOK_SECRET) return res.status(503).json({ ok: false, code: 'WEBHOOK_OFF', message: 'Webhook 비활성' });
    if (!verifyHMAC(req)) return res.status(401).json({ ok: false, code: 'BAD_SIGNATURE', message: '서명 불일치' });
    const { steps = [] } = req.body || {};
    const out = await executeSteps(steps);
    res.json({ ok: true, results: out });
  } catch (err) { res.status(500).json({ ok: false, code: 'RTA_WEBHOOK_FAIL', message: 'rta/webhook 실패', detail: String(err?.message || err) }); }
});

// ===== Self-Repair: /self-status, /self-rewrite, /self-rollback =====
function requireRewriteKey(req) {
  const { secret } = req.body || {}; if (!REWRITE_KEY) return 'REWRITE_KEY_NOT_SET';
  if (secret !== REWRITE_KEY) return 'FORBIDDEN'; return null;
}
app.get('/self-status', authGuard, async (_req, res) => {
  markRoute('/self-status');
  try {
    const file = path.join(__dirname, 'index.js');
    const backup = path.join(__dirname, 'index.backup.js');
    const cur = await fs.readFile(file, 'utf8');
    const curHash = crypto.createHash('sha256').update(cur).digest('hex');
    let backupHash = null; try { const b = await fs.readFile(backup, 'utf8'); backupHash = crypto.createHash('sha256').update(b).digest('hex'); } catch {}
    res.json({ ok: true, version: VERSION, hash: curHash, backupHash, hasBackup: !!backupHash });
  } catch (err) { res.status(500).json({ ok: false, code: 'SELF_STATUS_FAIL', message: String(err?.message || err) }); }
});
app.post('/self-rewrite', authGuard, async (req, res) => {
  markRoute('/self-rewrite');
  try {
    const keyErr = requireRewriteKey(req); if (keyErr) return res.status(keyErr === 'FORBIDDEN' ? 403 : 503).json({ ok: false, code: keyErr, message: '권한/설정 오류' });
    const { code } = req.body || {}; if (!code || typeof code !== 'string') return res.status(400).json({ ok: false, code: 'BAD_REQUEST', message: 'code required' });

    // 1) Syntax 검사
    esprima.parseScript(code);

    const file = path.join(__dirname, 'index.js');
    const backup = path.join(__dirname, 'index.backup.js');
    const next = path.join(__dirname, 'index.next.js');

    // 2) 새 파일 임시 저장
    await fs.writeFile(next, code, 'utf8');

    // 3) 백업 생성(덮어쓰기)
    try { await fs.copyFile(file, backup); } catch {}

    // 4) 본 파일 교체(원자적 교체 목적: write → rename)
    await fs.copyFile(next, file);

    // 5) 재시작(Platform이 재기동)
    res.json({ ok: true, message: 'rewrite applied, restarting' });
    process.nextTick(() => process.exit(0));
  } catch (err) {
    res.status(500).json({ ok: false, code: 'SELF_REWRITE_FAIL', message: String(err?.message || err) });
  }
});
app.post('/self-rollback', authGuard, async (req, res) => {
  markRoute('/self-rollback');
  try {
    const keyErr = requireRewriteKey(req); if (keyErr) return res.status(keyErr === 'FORBIDDEN' ? 403 : 503).json({ ok: false, code: keyErr, message: '권한/설정 오류' });
    const file = path.join(__dirname, 'index.js');
    const backup = path.join(__dirname, 'index.backup.js');
    await fs.copyFile(backup, file);
    res.json({ ok: true, message: 'rollback applied, restarting' });
    process.nextTick(() => process.exit(0));
  } catch (err) { res.status(500).json({ ok: false, code: 'SELF_ROLLBACK_FAIL', message: String(err?.message || err) }); }
});

// ===== Health & Metrics =====
app.get('/health', authGuard, (_req, res) => {
  markRoute('/health');
  res.json({ ok: true, version: VERSION, uptimeSec: Math.round((Date.now() - metrics.startTs) / 1000), keys: { OPENAI_API_KEY: !!OPENAI_API_KEY, GOOGLE_API_KEY: !!GOOGLE_API_KEY, GOOGLE_CSE_ID: !!GOOGLE_CSE_ID, SUPABASE_URL: !!SUPABASE_URL, SUPABASE_KEY: !!SUPABASE_KEY, RENDER_KEY: !!RENDER_KEY, REWRITE_KEY: !!REWRITE_KEY } });
});
app.get('/metrics', authGuard, (_req, res) => { markRoute('/metrics'); res.json({ ok: true, ...metrics }); });

// ===== Server Start =====
(async () => { await initializeChatChain(); app.listen(PORT, () => console.log(`🚀 Soraiel ${VERSION} 실행 중: 포트 ${PORT}`)); })();
