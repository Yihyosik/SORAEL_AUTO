// =======================
// index.js — Soraiel v9 FULL (Agent/Orchestrator Chat 포함)
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

const {
  OPENAI_API_KEY,
  MAKE_API_KEY,
  GOOGLE_API_KEY,
  GOOGLE_CSE_ID,
  SUPABASE_URL,
  SUPABASE_KEY,
  RENDER_KEY
} = process.env;

const { ChatOpenAI } = require('@langchain/openai');
const { ChatPromptTemplate, MessagesPlaceholder } = require('@langchain/core/prompts');
const { SystemMessage } = require('@langchain/core/messages');
const { BufferMemory } = require('langchain/memory');
const { LLMChain } = require('langchain/chains');

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

너는 단순히 대답만 하는 것이 아니라, 외부 툴과 API를 직접 사용할 수 있다.
사용 가능한 기능:
- /search : Google 검색
- /memory/import, /memory/search : Supabase 기억 저장 및 검색
- /crm/add, /crm/list : CRM 고객 관리
- /execute : 툴 실행
- /deploy : 새로운 툴 추가
사용자의 요청에 따라 적절한 툴을 선택하여 실행하고, 그 결과를 답변에 포함시켜라.
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
  }
};

// ===== /chat (에이전트 모드) =====
app.post('/chat', async (req, res) => {
  try {
    const userMessage = req.body.message;
    // LLM에 "어떤 툴을 써야 할지" 판단시키기
    const decision = await llm.invoke(`
      사용자의 요청: "${userMessage}"
      선택지: [ "chat-only", "search", "memory-import", "memory-search", "crm", "execute", "deploy" ]
      위 중 하나를 반드시 선택하고, 이유도 간단히 설명하라.
    `);

    let tool = "chat-only";
    if (decision.content.includes("search")) tool = "search";
    else if (decision.content.includes("memory-import")) tool = "memory-import";
    else if (decision.content.includes("memory-search")) tool = "memory-search";
    else if (decision.content.includes("crm")) tool = "crm";
    else if (decision.content.includes("execute")) tool = "execute";
    else if (decision.content.includes("deploy")) tool = "deploy";

    let aiResponse = "";
    if (tool === "chat-only") {
      const result = await chatChain.call({ input: userMessage });
      aiResponse = result?.text?.trim() || "응답 실패";
    }
    else if (tool === "search") {
      const resp = await axios.get("https://www.googleapis.com/customsearch/v1", {
        params: { key: GOOGLE_API_KEY, cx: GOOGLE_CSE_ID, q: userMessage }
      });
      aiResponse = JSON.stringify(resp.data.items?.slice(0, 3) || []);
    }
    else if (tool === "memory-import") {
      await axios.post(`${SUPABASE_URL}/rest/v1/memory`, [{ query: userMessage, embedding: "[]" }], {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Prefer: "return=minimal" }
      });
      aiResponse = "기억에 저장했습니다.";
    }
    else if (tool === "memory-search") {
      const { data } = await axios.post(`${SUPABASE_URL}/rest/v1/rpc/search_memory`, { query: userMessage }, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
      });
      aiResponse = JSON.stringify(data);
    }
    else {
      const result = await chatChain.call({ input: userMessage });
      aiResponse = result?.text?.trim() || "응답 실패";
    }

    conversationHistory.push({ user: userMessage, ai: aiResponse });
    await saveHistory();
    res.json({ response: aiResponse, tool });
  } catch (err) {
    console.error("❌ Chat 오류:", err);
    res.status(500).json({ error: "Chat 실패", detail: err.message });
  }
});

// ===== /search =====
app.post('/search', async (req, res) => {
  try {
    const { query } = req.body;
    const resp = await axios.get("https://www.googleapis.com/customsearch/v1", {
      params: { key: GOOGLE_API_KEY, cx: GOOGLE_CSE_ID, q: query }
    });
    res.json({ result: resp.data });
  } catch (err) { res.status(500).json({ error: "검색 실패", detail: err.message }); }
});

// ===== /memory =====
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

// ===== /execute =====
app.post('/execute', async (req, res) => {
  const { steps = [] } = req.body;
  const results = {};
  try {
    for (const step of steps) {
      if (!registry[step.tool]) throw new Error(`❌ Unknown tool: ${step.tool}`);
      results[step.saveAs] = await registry[step.tool](step.args);
    }
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
      const context = { console, axios, module: {} };
      vm.createContext(context);
      const fn = vm.runInContext(add_tool.code, context);
      const toolFn = context.module.exports || fn;
      if (typeof toolFn !== "function") throw new Error("함수가 아닙니다.");
      await toolFn({ test: true }); // Dry-run
      registry[add_tool.name] = toolFn;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "deploy 실패", detail: err.message });
  }
});

// ===== /health =====
app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ===== 서버 시작 =====
const PORT = process.env.PORT || 3000;
(async () => {
  await initializeChatChain();
  await loadHistory();
  app.listen(PORT, () => console.log(`🚀 Soraiel v9 FULL 실행 중: 포트 ${PORT}`));
})();
