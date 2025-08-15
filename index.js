require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');

// ===== 환경변수 상수화 & 강제 주입 =====
const OPENAI_API_KEY_CONST = (process.env.OPENAI_API_KEY || '').trim();
const GOOGLE_API_KEY_CONST = (process.env.GOOGLE_API_KEY || '').trim();
const GOOGLE_CSE_ID_CONST = (process.env.GOOGLE_CSE_ID || '').trim();

process.env.GOOGLE_API_KEY = GOOGLE_API_KEY_CONST; // ✅ 강제 주입
process.env.GOOGLE_CSE_ID = GOOGLE_CSE_ID_CONST;   // ✅ 강제 주입

console.log('=== 🚀 Render 환경변수 디버그 출력 ===');
console.log('OPENAI_API_KEY:', OPENAI_API_KEY_CONST ? 'Loaded' : 'Not Loaded');
console.log('GOOGLE_API_KEY:', GOOGLE_API_KEY_CONST ? 'Loaded' : 'Not Loaded');
console.log('GOOGLE_CSE_ID:', GOOGLE_CSE_ID_CONST ? 'Loaded' : 'Not Loaded');
console.log('======================================');

if (!OPENAI_API_KEY_CONST || !GOOGLE_API_KEY_CONST || !GOOGLE_CSE_ID_CONST) {
    console.error('❌ 필수 환경변수가 설정되지 않았습니다.');
    process.exit(1);
}

const { ChatOpenAI } = require('@langchain/openai');
const { initializeAgentExecutorWithOptions } = require('langchain/agents');
// ✅ 환경변수 강제 주입 후 require
const { GoogleCustomSearch } = require('@langchain/community/tools/google_custom_search');
const { ChatPromptTemplate, MessagesPlaceholder } = require('@langchain/core/prompts');
const { SystemMessage, HumanMessage, AIMessage } = require('@langchain/core/messages');

const app = express();
app.use(express.json());
app.use(cors());

// ===== 정적 파일 서빙 =====
app.use(express.static('public'));

// ===== 대화 기록 관리 =====
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

// ===== 소라엘 기본 설정 =====
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

// ✅ 검색 모듈 생성 (환경변수 강제 주입 상태)
const googleSearchTool = new GoogleCustomSearch();

const chatPrompt = ChatPromptTemplate.fromMessages([
    new SystemMessage(SORAIEL_IDENTITY),
    new MessagesPlaceholder("chatHistory"),
    new HumanMessage("사용자 입력: {input}"),
    new MessagesPlaceholder("agent_scratchpad")
]);

let agentExecutor;
async function initializeAgent() {
    agentExecutor = await initializeAgentExecutorWithOptions(
        [googleSearchTool],
        llm,
        { agentType: "chat-conversational-react-description", verbose: true, prompt: chatPrompt }
    );
    console.log("✅ 소라엘 Agent executor initialized");
}

// ===== API =====
app.get('/l2/api/history', (req, res) => res.json(conversationHistory));

app.post('/l2/api/dialogue', async (req, res) => {
    const lastMessage = req.body.message;
    conversationHistory.push({ role: 'user', content: lastMessage });
    if (conversationHistory.length > MAX_HISTORY_LENGTH) {
        conversationHistory.splice(0, conversationHistory.length - MAX_HISTORY_LENGTH);
    }

    try {
        const result = await agentExecutor.invoke({
            input: lastMessage,
            chatHistory: conversationHistory.slice(0, -1).map(msg =>
                msg.role === 'user' ? new HumanMessage(msg.content) : new AIMessage(msg.content)
            )
        });
        const aiResponse = result.output;
        conversationHistory.push({ role: 'assistant', content: aiResponse });
        saveHistory();
        res.json({ response: aiResponse });
    } catch (error) {
        console.error('❌ dialogue error:', error);
        res.status(500).json({ error: '서버 처리 중 오류가 발생했습니다.' });
    }
});

app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
(async () => {
    await initializeAgent();
    app.listen(PORT, () => console.log(`🚀 서버가 포트 ${PORT}에서 실행 중입니다.`));
})();
