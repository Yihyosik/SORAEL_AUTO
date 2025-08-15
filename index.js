// index.js — Render 메인 서버 (L1 + L2 + UI 통합, Render 환경변수 기반)

const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const cors = require("cors");

// ===== ENV (Render Dashboard에서 세팅)
const PORT = process.env.PORT || 8080;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN; // Render 환경변수 값 사용
const MAKE_API_BASE = process.env.MAKE_API_BASE || "https://us2.make.com/api/v2";
const MAKE_TOKEN = process.env.MAKE_TOKEN || process.env.MAKE_API_KEY || "";
const MAKE_TEAM_ID = process.env.MAKE_TEAM_ID || "";
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY || "").trim();
const GOOGLE_API_KEY = (process.env.GOOGLE_API_KEY || "").trim();
const GOOGLE_CSE_ID = (process.env.GOOGLE_CSE_ID || "").trim();

// ===== App init
const app = express();
app.use(express.json());
app.use(cors());

// ===== L1: Make API 실행기 + /make/create
function guard(req, res, next) {
  if (!ADMIN_TOKEN) return next();
  if (req.headers["x-admin-token"] === ADMIN_TOKEN) return next();
  return res.status(401).json({ ok: false, error: "unauthorized" });
}

async function callMake(method, url, { params, data } = {}) {
  const r = await axios.request({
    method, baseURL: MAKE_API_BASE, url,
    headers: { Authorization: `Token ${MAKE_TOKEN}`, "Content-Type": "application/json" },
    params, data, validateStatus: () => true, timeout: 20000
  });
  if (r.status >= 200 && r.status < 300) return r.data;
  throw Object.assign(new Error(`Make ${r.status}`), { detail: r.data });
}

const l1 = express.Router();
l1.get("/health", (_q, r) => r.json({ ok: true, ts: new Date().toISOString() }));
l1.get("/__whoami", (_q, r) => r.json({ ok: true, env: { mode: MAKE_TOKEN ? "token" : "none", MAKE_API_BASE, MAKE_TEAM_ID } }));
l1.get("/make/ping", guard, async (_q, r) => {
  try {
    if (!MAKE_TEAM_ID) return r.status(400).json({ ok: false, error: "missing_MAKE_TEAM_ID" });
    const out = await callMake("GET", "/scenarios", { params: { teamId: MAKE_TEAM_ID, limit: 1 } });
    r.json({ ok: true, sample: out });
  } catch (e) { r.status(500).json({ ok: false, detail: e.detail || e.message }); }
});
l1.post("/make/run", guard, async (q, r) => {
  try {
    const id = q.body?.scenarioId || process.env.MAKE_SCENARIO_ID;
    if (!id) return r.status(400).json({ ok: false, error: "need scenarioId" });
    const out = await callMake("POST", `/scenarios/${id}/run`);
    r.json({ ok: true, mode: "token", result: out });
  } catch (e) { r.status(500).json({ ok: false, detail: e.detail || e.message }); }
});
l1.post("/make/create", guard, async (req, res) => {
  try {
    const { name, description } = req.body || {};
    if (!name) return res.status(400).json({ ok: false, error: "need name" });
    if (!MAKE_TEAM_ID) return res.status(400).json({ ok: false, error: "missing_MAKE_TEAM_ID" });
    const payload = { name, description: description || "" };
    const data = await callMake("POST", `/scenarios`, {
      params: { teamId: MAKE_TEAM_ID },
      data: payload
    });
    res.json({ ok: true, scenario: data });
  } catch (e) { res.status(500).json({ ok: false, detail: e.detail || e.message }); }
});
app.use("/l1", l1);

// ===== L2: 대화 + Google 검색
const { ChatOpenAI } = require('@langchain/openai');
const { initializeAgentExecutorWithOptions } = require('langchain/agents');
const { GoogleCustomSearch } = require('@langchain/community/tools/google_custom_search');
const { ChatPromptTemplate, MessagesPlaceholder } = require('@langchain/core/prompts');
const { SystemMessage, HumanMessage, AIMessage } = require('@langchain/core/messages');

const HISTORY_FILE = path.join(__dirname, 'history.json');
const MAX_HISTORY_LENGTH = 20;
let conversationHistory = [];
if (fs.existsSync(HISTORY_FILE)) {
  try { conversationHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8')); } catch {}
}
function saveHistory() {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(conversationHistory, null, 2)); } catch {}
}

const SORAIEL_IDENTITY = `
당신은 "소라엘"이라는 이름의 AI 비서입니다.
모든 대화는 한국어로 하며, 따뜻하고 창의적인 어조를 유지합니다.
필요 시 구글 검색을 활용하여 최신 정보를 제공하지만, 단순 대화나 창의적 요청은 자체 지식으로 처리합니다.
`;

const llm = new ChatOpenAI({
  apiKey: OPENAI_API_KEY,
  temperature: 0.7,
  modelName: 'gpt-4o-mini'
});
const googleSearchTool = new GoogleCustomSearch();
const chatPrompt = ChatPromptTemplate.fromMessages([
  new SystemMessage(SORAIEL_IDENTITY),
  new MessagesPlaceholder("chatHistory"),
  new HumanMessage("사용자 입력: {input}"),
  new MessagesPlaceholder("agent_scratchpad")
]);
let agentExecutor;
(async () => {
  agentExecutor = await initializeAgentExecutorWithOptions(
    [googleSearchTool],
    llm,
    { agentType: "chat-conversational-react-description", verbose: true, prompt: chatPrompt }
  );
})();

const l2 = express.Router();
l2.get('/api/history', (_req, res) => res.json(conversationHistory));
l2.post('/api/dialogue', async (req, res) => {
  const lastMessage = req.body.message;
  conversationHistory.push({ role: 'user', content: lastMessage });
  if (conversationHistory.length > MAX_HISTORY_LENGTH) {
    conversationHistory.splice(0, conversationHistory.length - MAX_HISTORY_LENGTH);
  }
  try {
    const result = await agentExecutor.invoke({
      input: lastMessage,
      chatHistory: conversationHistory.slice(0, -1).map(msg => {
        if (msg.role === 'user') return new HumanMessage(msg.content);
        if (msg.role === 'assistant') return new AIMessage(msg.content);
      })
    });
    const aiResponse = result.output;
    conversationHistory.push({ role: 'assistant', content: aiResponse });
    if (conversationHistory.length > MAX_HISTORY_LENGTH) {
      conversationHistory.splice(0, conversationHistory.length - MAX_HISTORY_LENGTH);
    }
    saveHistory();
    res.json({ response: aiResponse });
  } catch (error) {
    res.status(500).json({ error: '서버 처리 중 오류가 발생했습니다.' });
  }
});
app.use("/l2", l2);

// ===== Public UI
app.use(express.static(path.join(__dirname, 'public')));

// ===== 기본 헬스
app.get("/health", (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ===== Start
app.listen(PORT, () => console.log(`Render merged server running on :${PORT}`));
