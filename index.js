// =======================
// index.js — Soraiel v8 FULL (GOOGLE_CSE_ID 패치)
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
  "GOOGLE_CSE_ID",   // ✅ 수정됨
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
  GOOGLE_CSE_ID,   // ✅ 수정됨
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

// ===== 나머지 라우트들 (/make, /memory, /crm, /video, /ebook, /build, /run, /orchestrate, /execute, /deploy, /rta/webhook, /health)
// 👉 이전 v8 FULL 코드 그대로 유지 (변경 없음)

// ===== 서버 시작 =====
const PORT = process.env.PORT || 3000;
(async () => {
  await initializeChatChain();
  await loadHistory();
  app.listen(PORT, () => console.log(`🚀 Soraiel v8 FULL (GOOGLE_CSE_ID) 실행 중: 포트 ${PORT}`));
})();
