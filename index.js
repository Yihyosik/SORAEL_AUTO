// =======================
// index.js — Soraiel v5.0 (최종 복구 및 안정화 버전)
// =======================
require('dotenv').config();
const fs = require('fs/promises');
const path = require('path');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const { exec } = require('child_process');

const OPENAI_API_KEY_CONST = (process.env.OPENAI_API_KEY || '').trim();
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const RENDER_KEY = process.env.RENDER_KEY || '';

if (!OPENAI_API_KEY_CONST) {
  console.error('❌ OPENAI_API_KEY 없음');
  process.exit(1);
}

const { ChatOpenAI } = require('@langchain/openai');
const { initializeAgentExecutorWithOptions } = require('langchain/agents');
const { GoogleCustomSearch } = require('@langchain/community/tools/google_custom_search');
const { ChatPromptTemplate, MessagesPlaceholder } = require('@langchain/core/prompts');
const { SystemMessage, HumanMessage, AIMessage } = require('@langchain/core/messages');
const { BufferMemory } = require('langchain/memory');

const app = express();
app.use(express.json());
app.use(cors());

// HTML 서빙 로직
app.use(express.static(path.join(__dirname, 'public')));

// ===== 대화 기록 =====
const HISTORY_FILE = path.join(__dirname, 'history.json');
let conversationHistory = [];
async function loadHistory() {
  try {
    const data = await fs.readFile(HISTORY_FILE, 'utf-8');
    conversationHistory = JSON.parse(data);
  } catch {}
}
async function saveHistory() {
  await fs.writeFile(HISTORY_FILE, JSON.stringify(conversationHistory, null, 2));
}

// ===== 프롬프트 =====
const SORAIEL_IDENTITY = `
당신은 "소라엘"이라는 이름의 AI 비서입니다.
실무형·정확·단호한 어조를 유지합니다.
정확하지 않은 정보는 반드시 "없다"고 말합니다.
불필요한 접두사·군더더기 표현은 제거합니다.
`;

const llm = new ChatOpenAI({
  apiKey: OPENAI_API_KEY_CONST,
  temperature: 0.4,
  modelName: 'gpt-4o-mini'
});
const googleSearchTool = new GoogleCustomSearch();
const chatPrompt = ChatPromptTemplate.fromMessages([
  new SystemMessage(SORAIEL_IDENTITY),
  new MessagesPlaceholder("chatHistory"),
  new MessagesPlaceholder("agent_scratchpad")
]);
const memory = new BufferMemory({ returnMessages: true, memoryKey: "chatHistory" });

let agentExecutor;
async function initializeAgent() {
  agentExecutor = await initializeAgentExecutorWithOptions(
    [googleSearchTool],
    llm,
    { agentType: "chat-conversational-react-description", verbose: true, prompt: chatPrompt, memory }
  );
  console.log("✅ 소라엘 Agent executor initialized");
}

// ===== Registry & Vault =====
let registry = {};
let vault = {};
async function logRun(planId, content) {
  await fs.writeFile(`runs_${planId}.json`, JSON.stringify(content, null, 2));
}

// ===== CRM (sqlite) =====
const crmDB = new sqlite3.Database('./crm.db');
crmDB.serialize(() => {
  crmDB.run("CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT)");
});

// promisify SQLite DB methods
const dbRun = (sql, params) => new Promise((resolve, reject) => {
  crmDB.run(sql, params, function(err) {
    if (err) reject(err);
    else resolve(this);
  });
});
const dbAll = (sql, params) => new Promise((resolve, reject) => {
  crmDB.all(sql, params, (err, rows) => {
    if (err) reject(err);
    else resolve(rows);
  });
});

// ===== API =====

// HTML 파일을 서빙하는 라우터
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- 대화 ---
app.post('/chat', async (req, res) => {
  const msg = req.body.message;

  // LangChain의 메모리 형식으로 변환 (HumanMessage, AIMessage)
  const langChainChatHistory = conversationHistory.map(msg => {
    if (msg.role === 'user') return new HumanMessage(msg.content);
    return new AIMessage(msg.content);
  });

  conversationHistory.push({ role: 'user', content: msg });
  if (conversationHistory.length > 30) conversationHistory.shift();

  try {
    // chatHistory 인자를 명시적으로 전달하여 오류 해결
    const result = await agentExecutor.invoke({
      input: msg,
      chatHistory: langChainChatHistory
    });

    const aiResponse = result.output?.trim() || "응답 실패";
    conversationHistory.push({ role: 'assistant', content: aiResponse });
    await saveHistory();
    res.json({ response: aiResponse });
  } catch (err) {
    console.error('대화 처리 중 오류 발생:', err.message);
    res.status(500).json({ error: '대화 처리 중 오류 발생', detail: err.message });
  }
});

// --- 자가 성장 (/deploy) ---
app.post('/deploy', async (req, res) => {
  const { add_tool, connect_secret, deploy_target, code } = req.body || {};
  const planId = Date.now().toString();
  try {
    if (connect_secret) vault[connect_secret.name] = connect_secret.value;
    if (add_tool && code) {
      return res.status(403).json({ error: "코드 실행은 보안상 위험하여 허용되지 않습니다." });
    }
    if (deploy_target?.type === 'render') {
      await axios.post('https://api.render.com/deploy', { serviceId: deploy_target.serviceId }, {
        headers: { Authorization: `Bearer ${RENDER_KEY}` }
      }).catch(()=>{});
    }
    await logRun(planId, { add_tool, connect_secret, deploy_target });
    res.json({ ok: true, updated: { add_tool, connect_secret, deploy_target } });
  } catch (err) {
    res.status(500).json({ error: "deploy 실패", detail: err.message });
  }
});

// --- 장기기억 (Supabase) ---
app.post('/memory/import', async (req, res) => {
  try {
    const { records } = req.body;
    await axios.post(`${SUPABASE_URL}/rest/v1/memory`, records, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Prefer: "return=minimal" }
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "memory import 실패", detail: err.message });
  }
});
app.post('/memory/search', async (req, res) => {
  try {
    const { query } = req.body;
    const { data } = await axios.post(`${SUPABASE_URL}/rest/v1/rpc/search_memory`, { query }, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
    });
    res.json({ results: data });
  } catch (err) {
    res.status(500).json({ error: "memory search 실패", detail: err.message });
  }
});

// --- 계획 (/build) ---
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
  await logRun(planId, plan);
  res.json(plan);
});

// --- 실행 (/run) OpenAI 호출 ---
app.post('/run', async (req, res) => {
  try {
    const topic = req.body.topic || "제목 없음";
    const imagePrompt = req.body.prompt || topic;
    const imgResp = await axios.post("https://api.openai.com/v1/images/generations", {
      prompt: imagePrompt,
      model: "gpt-image-1",
      size: "512x512"
    }, {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY_CONST}` }
    });
    const image_url = imgResp.data?.data?.[0]?.url;

    const blogResp = await axios.post("https://api.openai.com/v1/chat/completions", {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "주어진 주제로 블로그 글을 작성하라. 한국어, 실무형, 단호." },
        { role: "user", content: topic }
      ]
    }, {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY_CONST}` }
    });
    const blog_post = blogResp.data?.choices?.[0]?.message?.content;
    res.json({ image_url, blog_post });
  } catch (err) {
    res.status(500).json({ error: "실행 실패", detail: err.message });
  }
});

// --- 두뇌 (/orchestrate) ---
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
  await logRun(planId, plan);
  res.json(plan);
});

// --- 전자책 모듈 ---
app.post('/ebook', async (req, res) => {
  const { title, content } = req.body;
  const file = `ebook_${Date.now()}.md`;
  await fs.writeFile(file, `# ${title}\n\n${content}`);
  res.json({ ok: true, file });
});

// --- 동영상 모듈 (ffmpeg 필요) ---
app.post('/video', (req, res) => {
  const input = req.body.input || "input.mp4";
  const output = `output_${Date.now()}.mp4`;
  const cmd = `ffmpeg -i ${input} -t 10 -c copy ${output}`;
  exec(cmd, (err) => {
    if (err) return res.status(500).json({ error: "영상 처리 실패", detail: err.message });
    res.json({ ok: true, file: output });
  });
});

// --- CRM 모듈 (sqlite) ---
app.post('/crm/add', async (req, res) => {
  try {
    const { name, email } = req.body;
    const result = await dbRun("INSERT INTO customers (name, email) VALUES (?, ?)", [name, email]);
    res.json({ ok: true, id: result.lastID });
  } catch (err) {
    res.status(500).json({ error: "추가 실패" });
  }
});
app.get('/crm/list', async (req, res) => {
  try {
    const rows = await dbAll("SELECT * FROM customers", []);
    res.json({ customers: rows });
  } catch (err) {
    res.status(500).json({ error: "조회 실패" });
  }
});

// --- Health ---
app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ===== 에러 핸들링 =====
process.on("uncaughtException", err => console.error("❌ Uncaught:", err));
process.on("unhandledRejection", reason => console.error("❌ Unhandled:", reason));

// ===== 서버 시작 =====
const PORT = process.env.PORT || 3000;
(async () => {
  await initializeAgent();
  await loadHistory();
  app.listen(PORT, () => console.log(`🚀 Soraiel v5.0 실행 중: 포트 ${PORT}`));
})();
