require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');

process.env.OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
process.env.GOOGLE_API_KEY = (process.env.GOOGLE_API_KEY || '').trim();
process.env.GOOGLE_CSE_ID = (process.env.GOOGLE_CSE_ID || '').trim();

console.log('--- Environment Variables Check ---');
console.log('OPENAI_API_KEY:', process.env.OPENAI_API_KEY ? 'Loaded' : 'Not Loaded');
console.log('GOOGLE_API_KEY:', process.env.GOOGLE_API_KEY ? 'Loaded' : 'Not Loaded');
console.log('GOOGLE_CSE_ID:', process.env.GOOGLE_CSE_ID ? 'Loaded' : 'Not Loaded');
console.log('-----------------------------------');

if (!process.env.OPENAI_API_KEY || !process.env.GOOGLE_API_KEY || !process.env.GOOGLE_CSE_ID) {
    console.error('❌ 필수 환경변수가 설정되지 않았습니다.');
    process.exit(1);
}

const { ChatOpenAI } = require('@langchain/openai');
const { initializeAgentExecutorWithOptions } = require('langchain/agents');
const { GoogleCustomSearch } = require('@langchain/community/tools/google_custom_search');
const { ChatPromptTemplate, MessagesPlaceholder } = require('@langchain/core/prompts');
const { SystemMessage, HumanMessage, AIMessage } = require('@langchain/core/messages');

const app = express();
app.use(express.json());
app.use(cors());

app.use(express.static('public'));

const HISTORY_FILE = path.join(__dirname, 'history.json');
const MAX_HISTORY_LENGTH = 20; // 최대 대화 기록 수

let conversationHistory = [];
if (fs.existsSync(HISTORY_FILE)) {
    try {
        const data = fs.readFileSync(HISTORY_FILE, 'utf-8');
        conversationHistory = JSON.parse(data);
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

const SORAIEL_IDENTITY = `
당신은 "소라엘"이라는 이름의 AI 비서입니다.
모든 대화는 한국어로 하며, 따뜻하고 창의적인 어조를 유지합니다.
필요 시 구글 검색을 활용하여 최신 정보를 제공하지만, 단순 대화나 창의적 요청은 자체 지식으로 처리합니다.
거짓말, 변명, 핑계, 시스템 한계 언급을 하지 마세요.
`;

const llm = new ChatOpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    temperature: 0.7,
    modelName: 'gpt-4o-mini'
});

// ✅ GoogleCustomSearch 생성 전 환경변수 강제 주입
// 이 두 줄을 삭제했습니다.
// process.env.GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || 'YOUR_API_KEY';
// process.env.GOOGLE_CSE_ID = process.env.GOOGLE_CSE_ID || 'YOUR_CSE_ID';

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
        {
            agentType: "chat-conversational-react-description", // ✅ 변경
            verbose: true,
            prompt: chatPrompt
        }
    );
    console.log("✅ 소라엘 Agent executor initialized");
}

app.get('/api/history', (req, res) => {
    res.json(conversationHistory);
});

app.post('/api/dialogue', async (req, res) => {
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
        console.error('❌ 오류:', error);
        res.status(500).json({ error: '서버 처리 중 오류가 발생했습니다.' });
    }
});

const PORT = process.env.PORT || 3000;
async function startServer() {
    await initializeAgent();
    app.listen(PORT, () => console.log(`🚀 서버가 포트 ${PORT}에서 실행 중입니다.`));
}
startServer();
