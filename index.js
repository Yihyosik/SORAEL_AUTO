// =======================
// index.js — Soraiel v8 FULL (GOOGLE_CSE_ID 적용, 완전본)
// =======================
require('dotenv').config();
const fs = require('fs/promises');
const path = require('path');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const { exec } = require('child_process');
const vm = require("vm");
const esprima = require("esprima");

// ===== 환경변수 체크 =====
const requiredEnv = [
  "OPENAI_API_KEY",
  "MAKE_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_CSE_ID",   // ✅ Render 환경변수 이름 맞춤
  "SUPABASE_URL",
  "SUPABASE_KEY",
  "RENDER_KEY"
];
requiredEnv.forEach(v => {
  if (!process.env[v]) {
    console.error(`❌ 필수 환경변수 누락: ${v}`);
    process.exit(1);
  }
});

const {
  OPENAI_API_KEY,
  MAKE_API_KEY,
  GOOGLE_API_KEY,
  GOOGLE_CSE_ID,   // ✅ Render 변수 이름 반영
  SUPABASE_URL,
  SUPABASE_KEY,
  RENDER_KEY
} = process.env;

const { ChatOpenAI } = require('@langchain/openai');
const { LLMChain } = require('langchain/chains');
const { ChatPromptTemplate, MessagesPlaceholder } = require('@langchain/core/prompts');
const { SystemMessage } = require('@langchain/core/messages');
const { BufferMemory } = require('langchain/memory');

const app = express();
app.use(express.json());
app.use(cors());

// ===== 정적 페이지 =====
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));
app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// ===== 대화 기록 =====
const HISTORY_FILE = path.join(__dirname, 'history.json');
let conversationHistory = [];
async function loadHistory() {
  try {
    const data = await fs.readFile(HISTORY_FILE, 'utf-8');
    conversationHistory = JSON.parse(data);
  } catch { conversationHistory = []; }
}
async function saveHistory() {
  try { await fs.writeFile(HISTORY_FILE, JSON.stringify(conversationHistory, null, 2)); }
  catch (err) { console.error("❌ 대화 기록 저장 실패:", err); }
}

// ===== 프롬프트 =====
const SORAIEL_IDENTITY = `
당신은 "소라엘"이라는 이름의 AI 비서입니다.
실무형·정확·단호한 어조를 유지합니다.
정확하지 않은 정보는 반드시 "없다"고 말합니다.
불필요한 접두사·군더더기 표현은 제거합니다.
`;

const llm = new ChatOpenAI({
  apiKey: OPENAI_API_KEY,
  temperature: 0.4,
  modelName: 'gpt-4o'
});

const chatPrompt = ChatPromptTemplate.fromMessages([
  new SystemMessage(SORAIEL_IDENTITY),
  new MessagesPlaceholder("chat_history"),
  ["human", "{input}"]
]);

const memory = new BufferMemory({ returnMessages: true, memoryKey: "chat_history" });

let chatChain;
async function initializeChatChain() {
  chatChain = new LLMChain({ llm, prompt: chatPrompt, memory });
  console.log("✅ ChatChain initialized");
}

// ===== Registry =====
let registry = {
  "llm.generate": async ({ prompt }) => {
    const resp = await llm.invoke(prompt);
    return resp?.content || "";
  },
  "http.fetch": async ({ url, method = "GET", data }) => {
    const resp = await axios({ url, method, data });
    return resp.data;
  },
  "pipeline.run": async ({ steps }) => {
    const results = [];
    for (const step of steps) {
      if (registry[step.tool]) results.push(await registry[step.tool](step.args));
    }
    return results;
  }
};

// ===== /chat =====
app.post('/chat', async (req, res) => {
  try {
    const result = await chatChain.call({ input: req.body.message });
    const aiResponse = result?.text?.trim() || "응답 실패";
    conversationHistory.push({ user: req.body.message, ai: aiResponse });
    await saveHistory();
    res.json({ response: aiResponse });
  } catch (err) {
    console.error("❌ Chat 오류:", err);
    res.status(500).json({ error: "Chat 실패", detail: err.message });
  }
});

// ===== /search (Google) =====
app.post('/search', async (req, res) => {
  try {
    const { query } = req.body;
    const resp = await axios.get("https://www.googleapis.com/customsearch/v1", {
      params: { key: GOOGLE_API_KEY, cx: GOOGLE_CSE_ID, q: query }  // ✅ 수정됨
    });
    res.json({ result: resp.data });
  } catch (err) { res.status(500).json({ error: "검색 실패", detail: err.message }); }
});

// ===== /make =====
app.post('/make/run', async (req, res) => {
  try {
    const { hookUrl, payload } = req.body;
    if (!hookUrl) throw new Error("hookUrl 누락");
    const resp = await axios.post(hookUrl, payload || {});
    res.json({ ok: true, result: resp.data });
  } catch (err) { res.status(500).json({ error: "Make Webhook 실패", detail: err.message }); }
});
app.post('/make/api/run', async (req, res) => {
  try {
    const { scenarioId, data } = req.body;
    if (!scenarioId) throw new Error("scenarioId 누락");
    const resp = await axios.post(
      `https://api.make.com/v2/scenarios/${scenarioId}/run`,
      data || {},
      { headers: { Authorization: `Token ${MAKE_API_KEY}` } }
    );
    res.json({ ok: true, result: resp.data });
  } catch (err) { res.status(500).json({ error: "Make API 실패", detail: err.message }); }
});

// ===== /memory (Supabase) =====
app.post('/memory/import', async (req, res) => {
  try {
    const { records } = req.body;
    await axios.post(`${SUPABASE_URL}/rest/v1/memory`, records, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Prefer: "return=minimal" }
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: "memory import 실패", detail: err.message }); }
});
app.post('/memory/search', async (req, res) => {
  try {
    const { query } = req.body;
    const { data } = await axios.post(`${SUPABASE_URL}/rest/v1/rpc/search_memory`, { query }, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
    });
    res.json({ results: data });
  } catch (err) { res.status(500).json({ error: "memory search 실패", detail: err.message }); }
});

// ===== /crm =====
const crmDB = new sqlite3.Database('./crm.db');
crmDB.serialize(() => {
  crmDB.run("CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT)");
});
app.post('/crm/add', async (req, res) => {
  try {
    const { name, email } = req.body;
    crmDB.run("INSERT INTO customers (name, email) VALUES (?, ?)", [name, email], function (err) {
      if (err) return res.status(500).json({ error: "추가 실패" });
      res.json({ ok: true, id: this.lastID });
    });
  } catch { res.status(500).json({ error: "CRM 추가 실패" }); }
});
app.get('/crm/list', async (_req, res) => {
  crmDB.all("SELECT * FROM customers", [], (err, rows) => {
    if (err) return res.status(500).json({ error: "조회 실패" });
    res.json({ customers: rows });
  });
});

// ===== /video =====
app.post('/video', (req, res) => {
  const input = req.body.input || "input.mp4";
  const output = `output_${Date.now()}.mp4`;
  const cmd = `ffmpeg -i ${input} -t 10 -c copy ${output}`;
  exec(cmd, (err) => {
    if (err) return res.status(500).json({ error: "영상 처리 실패", detail: err.message });
    res.json({ ok: true, file: output });
  });
});

// ===== /ebook =====
app.post('/ebook', async (req, res) => {
  const { title, content } = req.body;
  const file = `ebook_${Date.now()}.md`;
  await fs.writeFile(file, `# ${title}\n\n${content}`);
  res.json({ ok: true, file });
});

// ===== /build & /run =====
app.post('/build', async (req, res) => {
  const instruction = req.body.instruction || "";
  const planId = Date.now().toString();
  const plan = {
    planId,
    steps: [
      { tool: "generate_image", args: { prompt: instruction }, saveAs: "image" },
      { tool: "write_blog", args: { topic: instruction }, saveAs: "blog" }
    ]
  };
  res.json(plan);
});
app.post('/run', async (req, res) => {
  try {
    const topic = req.body.topic || "제목 없음";
    const imagePrompt = req.body.prompt || topic;
    const imgResp = await axios.post("https://api.openai.com/v1/images/generations", {
      prompt: imagePrompt, model: "gpt-image-1", size: "512x512"
    }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } });
    const image_url = imgResp.data?.data?.[0]?.url;

    const blogResp = await axios.post("https://api.openai.com/v1/chat/completions", {
      model: "gpt-4o",
      messages: [
        { role: "system", content: "주어진 주제로 블로그 글 작성" },
        { role: "user", content: topic }
      ]
    }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } });
    const blog_post = blogResp.data?.choices?.[0]?.message?.content;

    res.json({ image_url, blog_post });
  } catch (err) { res.status(500).json({ error: "실행 실패", detail: err.message }); }
});

// ===== /orchestrate =====
app.post('/orchestrate', async (req, res) => {
  const { goal = "" } = req.body;
  const planId = Date.now().toString();
  const plan = {
    planId,
    steps: [
      { tool: "llm.generate", args: { prompt: goal }, saveAs: "text" },
      { tool: "http.fetch", args: { url: "https://example.com" }, saveAs: "data" }
    ]
  };
  res.json(plan);
});

// ===== /execute =====
app.post('/execute', async (req, res) => {
  const { steps = [] } = req.body;
  const planId = Date.now().toString();
  const results = {};
  const start = Date.now();
  let successCount = 0, failCount = 0;

  try {
    await Promise.all(steps.map(async step => {
      if (!registry[step.tool]) throw new Error(`❌ Unknown tool: ${step.tool}`);
      let attempt = 0, success = false, lastError;
      while (attempt < 2 && !success) {
        try {
          const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 10000));
          const execPromise = registry[step.tool](step.args);
          results[step.saveAs] = await Promise.race([execPromise, timeout]);
          success = true;
          successCount++;
        } catch (err) {
          lastError = err; attempt++;
          await new Promise(r => setTimeout(r, 500 * attempt));
        }
      }
      if (!success) { failCount++; throw lastError; }
    }));

    const duration = Date.now() - start;
    await fs.writeFile(`runs_${planId}.json`, JSON.stringify({ steps, results, duration, successCount, failCount }, null, 2));
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ error: "execute 실패", detail: err.message });
  }
});

// ===== /deploy =====
app.post('/deploy', async (req, res) => {
  try {
    const { add_tool } = req.body;
    if (add_tool) {
      esprima.parseScript(add_tool.code);
      const context = { console, axios };
      vm.createContext(context);
      const fn = vm.runInContext(add_tool.code, context);

      let testResult;
      try { testResult = await fn({ test: true }); }
      catch (e) { throw new Error("Dry-run 실패: " + e.message); }

      const backup = { ...registry };
      try { registry[add_tool.name] = fn; }
      catch (err) { registry = backup; throw err; }
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: "deploy 실패", detail: err.message }); }
});

// ===== /rta/webhook =====
setInterval(() => {}, 60000);
app.post('/rta/webhook', async (req, res) => {
  try {
    const signature = req.headers["x-signature"];
    const body = JSON.stringify(req.body);
    const expected = crypto.createHmac("sha256", MAKE_API_KEY).update(body).digest("hex");
    if (signature !== expected) throw new Error("서명 검증 실패");
    const plan = await llm.invoke(req.body.goal || "자동화");
    res.json({ ok: true, plan });
  } catch (err) { res.status(400).json({ error: "Webhook 실패", detail: err.message }); }
});

// ===== /health =====
app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ===== 서버 시작 =====
const PORT = process.env.PORT || 3000;
(async () => {
  await initializeChatChain();
  await loadHistory();
  app.listen(PORT, () => console.log(`🚀 Soraiel v8 FULL (GOOGLE_CSE_ID) 실행 중: 포트 ${PORT}`));
})();
