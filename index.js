// =======================
// index.js — Soraiel v1.0 (완성본)
// =======================
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');

// ===== 1. 환경변수 강제 주입 =====
const OPENAI_API_KEY_CONST = (process.env.OPENAI_API_KEY || '').trim();
const GOOGLE_API_KEY_CONST = (process.env.GOOGLE_API_KEY || '').trim();
const GOOGLE_CSE_ID_CONST = (process.env.GOOGLE_CSE_ID || '').trim();

process.env.GOOGLE_API_KEY = GOOGLE_API_KEY_CONST;
process.env.GOOGLE_CSE_ID = GOOGLE_CSE_ID_CONST;

console.log('=== 🚀 Render 환경변수 디버그 출력 ===');
console.log('OPENAI_API_KEY:', OPENAI_API_KEY_CONST ? 'Loaded' : 'Not Loaded');
console.log('GOOGLE_API_KEY:', GOOGLE_API_KEY_CONST ? 'Loaded' : 'Not Loaded');
console.log('GOOGLE_CSE_ID:', GOOGLE_CSE_ID_CONST ? 'Loaded' : 'Not Loaded');
console.log('======================================');

if (!OPENAI_API_KEY_CONST) {
  console.error('❌ 필수 OPENAI_API_KEY 없음');
  process.exit(1);
}

// ===== 2. LangChain / OpenAI =====
const { ChatOpenAI } = require('@langchain/openai');
const { initializeAgentExecutorWithOptions } = require('langchain/agents');
const { GoogleCustomSearch } = require('@langchain/community/tools/google_custom_search');
const { ChatPromptTemplate, MessagesPlaceholder } = require('@langchain/core/prompts');
const { SystemMessage } = require('@langchain/core/messages');
const { BufferMemory } = require('langchain/memory');

const app = express();
app.use(express.json());
app.use(cors());

// ===== 3. 대화 기록 관리 =====
const HISTORY_FILE = path.join(__dirname, 'history.json');
const MAX_HISTORY_LENGTH = 20;
let conversationHistory = [];

if (fs.existsSync(HISTORY_FILE)) {
  try {
    conversationHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    console.log(`💾 기존 대화 기록 ${conversationHistory.length}개 불러옴`);
  } catch (err) {
    console.error('❌ 대화 기록 로드 실패:', err);
  }
}

function saveHistory() {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(conversationHistory, null, 2));
  } catch (err) {
    console.error('❌ 대화 기록 저장 실패:', err);
  }
}

// ===== 4. 소라엘 프롬프트 =====
const SORAIEL_IDENTITY = `
당신은 "소라엘"이라는 이름의 AI 비서입니다.
모든 대화는 한국어로 하며, 따뜻하고 창의적인 어조를 유지합니다.
필요 시 구글 검색을 활용하여 최신 정보를 제공하지만, 단순 대화나 창의적 요청은 자체 지식으로 처리합니다.
거짓말, 변명, 핑계, 시스템 한계 언급을 하지 마세요.
`;

const llm = new ChatOpenAI({
  apiKey: OPENAI_API_KEY_CONST,
  temperature: 0.7,
  modelName: 'gpt-4o-mini'
});

const googleSearchTool = new GoogleCustomSearch();

const chatPrompt = ChatPromptTemplate.fromMessages([
  new SystemMessage(SORAIEL_IDENTITY),
  new MessagesPlaceholder("chatHistory"),
  new MessagesPlaceholder("agent_scratchpad")
]);

const memory = new BufferMemory({
  returnMessages: true,
  memoryKey: "chatHistory"
});

let agentExecutor;

// ===== 5. Agent 초기화 =====
async function initializeAgent() {
  agentExecutor = await initializeAgentExecutorWithOptions(
    [googleSearchTool],
    llm,
    {
      agentType: "chat-conversational-react-description",
      verbose: true,
      prompt: chatPrompt,
      memory
    }
  );
  console.log("✅ 소라엘 Agent executor initialized");
}

// ===== 6. API =====

// --- 6.1 대화 (/chat) ---
app.post('/chat', async (req, res) => {
  const lastMessage = req.body.message;
  conversationHistory.push({ role: 'user', content: lastMessage });
  if (conversationHistory.length > MAX_HISTORY_LENGTH) {
    conversationHistory.splice(0, conversationHistory.length - MAX_HISTORY_LENGTH);
  }

  try {
    const result = await agentExecutor.invoke({ input: lastMessage });
    const aiResponse =
      result.output || result.output_text || result.returnValues?.output || "응답 생성 실패";

    conversationHistory.push({ role: 'assistant', content: aiResponse });
    saveHistory();
    res.json({ response: aiResponse });
  } catch (error) {
    console.error('❌ chat error:', error);
    res.status(500).json({ error: '대화 처리 오류' });
  }
});

// --- 6.2 설계 (/build) ---
app.post('/build', (req, res) => {
  const { instruction = "" } = req.body || {};
  if (!instruction) return res.status(400).json({ error: "instruction required" });

  const plan = {
    planId: Date.now().toString(),
    steps: [
      { tool: "generate_image", args: { prompt: instruction }, saveAs: "image" },
      { tool: "write_blog", args: { topic: instruction }, saveAs: "blog" }
    ]
  };
  fs.writeFileSync(`runs_${plan.planId}.json`, JSON.stringify(plan, null, 2));
  res.json(plan);
});

// --- 6.3 실행 (/run) ---
app.post('/run', async (req, res) => {
  try {
    const output = {
      image_url: "https://dummyimage.com/512x512/000/fff&text=Generated+Image",
      blog_post: `# ${req.body.topic || "제목 없음"}\n\n생성된 블로그 글 초안입니다.`
    };
    res.json(output);
  } catch (err) {
    res.status(500).json({ error: "실행 중 오류", detail: err.message });
  }
});

// --- 6.4 자가 확장 (/deploy) ---
app.post('/deploy', async (req, res) => {
  res.json({ ok: true, deployed: req.body || {} });
});

// --- 6.5 오케스트레이트 (/orchestrate) ---
app.post('/orchestrate', (req, res) => {
  const { goal = "" } = req.body || {};
  if (!goal) return res.status(400).json({ error: "goal required" });

  const plan = {
    goal,
    steps: [
      { tool: "llm.generate", args: { prompt: goal }, saveAs: "text" },
      { tool: "http.fetch", args: { url: "https://example.com" }, saveAs: "data" }
    ]
  };
  res.json({ planId: Date.now().toString(), steps: plan.steps });
});

// --- 6.6 Health check ---
app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ===== 7. 글로벌 에러 핸들링 =====
process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("❌ Unhandled Rejection:", reason);
});

// ===== 8. 서버 시작 =====
const PORT = process.env.PORT || 3000;
(async () => {
  await initializeAgent();
  app.listen(PORT, () => console.log(`🚀 서버가 포트 ${PORT}에서 실행 중입니다.`));
})();
