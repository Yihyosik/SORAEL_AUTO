const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const cors = require("cors");

const { ChatOpenAI } = require('@langchain/openai');
const { initializeAgentExecutorWithOptions } = require('langchain/agents');
const { GoogleCustomSearch } = require('@langchain/community/tools/google_custom_search');
const { ChatPromptTemplate, MessagesPlaceholder } = require('@langchain/core/prompts');
const { SystemMessage, HumanMessage, AIMessage } = require('@langchain/core/messages');

// ===== 환경변수 읽기 =====
const PORT = process.env.PORT || 8080;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const MAKE_API_BASE = process.env.MAKE_API_BASE || "https://us2.make.com/api/v2";
const MAKE_TOKEN = process.env.MAKE_TOKEN || process.env.MAKE_API_KEY || "";
const MAKE_TEAM_ID = process.env.MAKE_TEAM_ID || "";
const MAKE_SCENARIO_ID = process.env.MAKE_SCENARIO_ID || "";
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const GOOGLE_API_KEY = (process.env.GOOGLE_API_KEY || "").trim();
const GOOGLE_CSE_ID = (process.env.GOOGLE_CSE_ID || "").trim();
const SCENARIO_WEBHOOK_URL = (process.env.SCENARIO_WEBHOOK_URL || "").trim();

// ===== 디버그 출력 =====
console.log("=== 🚀 Render 환경변수 디버그 출력 ===");
console.log("PORT:", PORT);
console.log("ADMIN_TOKEN:", ADMIN_TOKEN || "[없음]");
console.log("MAKE_API_BASE:", MAKE_API_BASE);
console.log("MAKE_TOKEN:", MAKE_TOKEN || "[없음]");
console.log("MAKE_API_KEY:", process.env.MAKE_API_KEY || "[없음]");
console.log("MAKE_TEAM_ID:", MAKE_TEAM_ID || "[없음]");
console.log("MAKE_SCENARIO_ID:", MAKE_SCENARIO_ID || "[없음]");
console.log("OPENAI_API_KEY:", OPENAI_API_KEY ? "[설정됨]" : "[없음]");
console.log("GOOGLE_API_KEY:", GOOGLE_API_KEY ? "[설정됨]" : "[없음]");
console.log("GOOGLE_CSE_ID:", GOOGLE_CSE_ID || "[없음]");
console.log("SCENARIO_WEBHOOK_URL:", SCENARIO_WEBHOOK_URL || "[없음]");
console.log("NODE_ENV:", process.env.NODE_ENV);
console.log("PWD:", process.env.PWD);
console.log("================================================================");

// ===== 앱 초기화 =====
const app = express();
app.use(express.json());
app.use(cors());

// ===== 공통 함수 =====
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

// ===== L1 =====
const l1 = express.Router();
l1.get("/make/ping", guard, async (_q, r) => {
  try {
    if (!MAKE_TEAM_ID) return r.status(400).json({ ok: false, error: "missing_MAKE_TEAM_ID" });
    const out = await callMake("GET", "/scenarios", { params: { teamId: MAKE_TEAM_ID, limit: 1 } });
    r.json({ ok: true, sample: out });
  } catch (e) { r.status(500).json({ ok: false, detail: e.detail || e.message }); }
});
app.use("/l1", l1);

// ===== L2 =====
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
거짓 정보는 절대 제공하지 않으며, 모르는 경우 "정확한 정보는 없습니다"라고 명시합니다.
그러나 항상 관련된 유익한 정보나 대안을 제공합니다.
사용자의 지시에 대해 끝까지 시도하며, 시도 과정과 결과를 보고합니다.
`;

const llm = new ChatOpenAI({
  apiKey: OPENAI_API_KEY,
  temperature: 0.7,
  modelName: 'gpt-4o-mini'
});

// ===== Google 검색 지연 초기화 =====
let googleSearchTool = null;
let agentExecutor = null;

function ensureGoogleSearch() {
  if (!googleSearchTool && GOOGLE_API_KEY && GOOGLE_CSE_ID) {
    googleSearchTool = new GoogleCustomSearch({
      apiKey: GOOGLE_API_KEY,
      engineId: GOOGLE_CSE_ID
    });
    console.log("✅ Google 검색 모듈 생성 완료");
  }
  return googleSearchTool;
}

const chatPrompt = ChatPromptTemplate.fromMessages([
  new SystemMessage(SORAIEL_IDENTITY),
  new MessagesPlaceholder("chatHistory"),
  new HumanMessage("사용자 입력: {input}"),
  new MessagesPlaceholder("agent_scratchpad")
]);

app.post('/l2/api/dialogue', async (req, res) => {
  const lastMessage = req.body.message;
  conversationHistory.push({ role: 'user', content: lastMessage });
  if (conversationHistory.length > MAX_HISTORY_LENGTH) {
    conversationHistory.splice(0, conversationHistory.length - MAX_HISTORY_LENGTH);
  }

  try {
    let aiResponse = "";

    // 요청 시 검색 모듈과 Executor 생성
    if (!agentExecutor) {
      const tool = ensureGoogleSearch();
      if (tool) {
        agentExecutor = await initializeAgentExecutorWithOptions(
          [tool],
          llm,
          { agentType: "chat-conversational-react-description", verbose: true, prompt: chatPrompt }
        );
      }
    }

    if (/(포스팅|글 작성|콘텐츠|블로그)/.test(lastMessage)) {
      const post = await llm.invoke([
        new SystemMessage(SORAIEL_IDENTITY + "\n\n마케팅 콘텐츠 전문가로서 포스팅을 구조적으로 작성하세요."),
        new HumanMessage(lastMessage)
      ]);
      aiResponse = post.content;

      if (/(업로드|게시)/.test(lastMessage) && MAKE_TEAM_ID && MAKE_TOKEN) {
        const makeRes = await callMake("POST", `/scenarios/${MAKE_SCENARIO_ID}/run`, {
          params: { teamId: MAKE_TEAM_ID },
          data: { content: aiResponse }
        });
        aiResponse += `\n\n✅ 업로드 완료: ${JSON.stringify(makeRes)}`;
      }
    } else if (agentExecutor) {
      const result = await agentExecutor.invoke({
        input: lastMessage,
        chatHistory: conversationHistory.slice(0, -1).map(msg => {
          if (msg.role === 'user') return new HumanMessage(msg.content);
          if (msg.role === 'assistant') return new AIMessage(msg.content);
        })
      });
      aiResponse = result.output;
    } else {
      aiResponse = "⚠ 현재 Google 검색 기능이 비활성화되어 있습니다.";
    }

    conversationHistory.push({ role: 'assistant', content: aiResponse });
    if (conversationHistory.length > MAX_HISTORY_LENGTH) {
      conversationHistory.splice(0, conversationHistory.length - MAX_HISTORY_LENGTH);
    }
    saveHistory();

    res.json({ response: aiResponse });
  } catch (error) {
    res.status(500).json({ error: '서버 처리 중 오류', detail: error.message });
  }
});

// ===== Public UI =====
app.use(express.static(path.join(__dirname, 'public')));

// ===== Health =====
app.get("/health", (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.listen(PORT, () => console.log(`Render merged server running on :${PORT}`));
