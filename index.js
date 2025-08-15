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

// ===== 환경변수 전역 상수화 =====
const PORT = process.env.PORT || 8080;
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || "").trim();
const MAKE_API_BASE = (process.env.MAKE_API_BASE || "https://us2.make.com/api/v2").trim();
const MAKE_TOKEN = (process.env.MAKE_TOKEN || process.env.MAKE_API_KEY || "").trim();
const MAKE_TEAM_ID = (process.env.MAKE_TEAM_ID || "").trim();
const MAKE_SCENARIO_ID = (process.env.MAKE_SCENARIO_ID || "").trim();
const OPENAI_API_KEY_CONST = (process.env.OPENAI_API_KEY || "").trim();
const GOOGLE_API_KEY_CONST = (process.env.GOOGLE_API_KEY || "").trim();
const GOOGLE_CSE_ID_CONST = (process.env.GOOGLE_CSE_ID || "").trim();
const SCENARIO_WEBHOOK_URL = (process.env.SCENARIO_WEBHOOK_URL || "").trim();

// ===== 부팅 시 환경변수 확인 =====
console.log("=== 🚀 Render 환경변수 디버그 출력 ===");
console.log({
    GOOGLE_API_KEY_CONST,
    GOOGLE_CSE_ID_CONST
});
if (!GOOGLE_API_KEY_CONST || !GOOGLE_CSE_ID_CONST) {
    console.error("🚫 필수 환경변수 누락: GOOGLE_API_KEY, GOOGLE_CSE_ID를 확인하세요.");
}
console.log("================================================================");

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

// ===== L2: 대화 처리 =====
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
`;

const llm = new ChatOpenAI({
    apiKey: OPENAI_API_KEY_CONST,
    temperature: 0.7,
    modelName: 'gpt-4o-mini'
});

let googleSearchTool = null;
let agentExecutor = null;

// ===== Google 검색 모듈 즉시 로드 =====
function loadGoogleSearch() {
    if (!GOOGLE_API_KEY_CONST || !GOOGLE_CSE_ID_CONST) {
        throw new Error("🚫 GOOGLE_API_KEY 또는 GOOGLE_CSE_ID가 설정되지 않아 검색 기능을 사용할 수 없습니다.");
    }
    googleSearchTool = new GoogleCustomSearch({
        apiKey: GOOGLE_API_KEY_CONST,
        engineId: GOOGLE_CSE_ID_CONST
    });
    console.log("✅ Google 검색 모듈 생성 완료");
}
try {
    loadGoogleSearch();
} catch (err) {
    console.error("❌ Google 검색 모듈 초기화 실패:", err.message);
}

const chatPrompt = ChatPromptTemplate.fromMessages([
    new SystemMessage(SORAIEL_IDENTITY),
    new MessagesPlaceholder("chatHistory"),
    new HumanMessage("사용자 입력: {input}"),
    new MessagesPlaceholder("agent_scratchpad")
]);

app.post('/l2/api/dialogue', async (req, res) => {
    console.log("📩 /l2/api/dialogue 진입:", req.body);

    const lastMessage = req.body.message || "";
    let aiResponse = "";

    try {
        conversationHistory.push({ role: 'user', content: lastMessage });
        if (conversationHistory.length > MAX_HISTORY_LENGTH) {
            conversationHistory.splice(0, conversationHistory.length - MAX_HISTORY_LENGTH);
        }

        if (!agentExecutor && googleSearchTool) {
            agentExecutor = await initializeAgentExecutorWithOptions(
                [googleSearchTool], llm,
                { agentType: "chat-conversational-react-description", verbose: true, prompt: chatPrompt }
            );
        }

        if (agentExecutor) {
            const result = await agentExecutor.invoke({
                input: lastMessage,
                chatHistory: conversationHistory.slice(0, -1).map(msg =>
                    msg.role === 'user' ? new HumanMessage(msg.content) : new AIMessage(msg.content)
                )
            });
            aiResponse = result.output;
        } else {
            // JSON 형식으로 오류 메시지 반환
            aiResponse = "⚠ Google 검색 기능이 비활성화되었습니다. 서버의 필수 환경 변수를 확인해주세요.";
            conversationHistory.push({ role: 'assistant', content: aiResponse });
            saveHistory();
            return res.json({ response: aiResponse });
        }

        conversationHistory.push({ role: 'assistant', content: aiResponse });
        saveHistory();

        return res.json({ response: aiResponse });

    } catch (error) {
        console.error("❌ dialogue error:", error);
        return res.status(500).json({ error: error.message });
    }
});

// ===== Health =====
app.get("/health", (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ===== 마지막에 정적 파일 서빙 =====
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => console.log(`✅ Server running on :${PORT}`));
