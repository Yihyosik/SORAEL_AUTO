// =======================
// index.js — Soraiel v5.1 (중복 응답 완전 해결 버전)
// =======================
require(‘dotenv’).config();
const fs = require(‘fs/promises’);
const path = require(‘path’);
const express = require(‘express’);
const cors = require(‘cors’);
const axios = require(‘axios’);
const sqlite3 = require(‘sqlite3’).verbose();
const { exec } = require(‘child_process’);

const OPENAI_API_KEY_CONST = (process.env.OPENAI_API_KEY || ‘’).trim();
const SUPABASE_URL = process.env.SUPABASE_URL || ‘’;
const SUPABASE_KEY = process.env.SUPABASE_KEY || ‘’;
const RENDER_KEY = process.env.RENDER_KEY || ‘’;

if (!OPENAI_API_KEY_CONST) {
console.error(‘❌ OPENAI_API_KEY 없음’);
process.exit(1);
}

const { ChatOpenAI } = require(’@langchain/openai’);
const { initializeAgentExecutorWithOptions } = require(‘langchain/agents’);
const { GoogleCustomSearch } = require(’@langchain/community/tools/google_custom_search’);
const { ChatPromptTemplate, MessagesPlaceholder } = require(’@langchain/core/prompts’);
const { SystemMessage, HumanMessage, AIMessage } = require(’@langchain/core/messages’);

const app = express();
app.use(express.json());
app.use(cors());

// HTML 서빙 로직
app.use(express.static(path.join(__dirname, ‘public’)));

// ===== 대화 기록 및 중복 방지 =====
const HISTORY_FILE = path.join(__dirname, ‘history.json’);
let conversationHistory = [];
let processingRequests = new Set(); // 중복 요청 방지

async function loadHistory() {
try {
const data = await fs.readFile(HISTORY_FILE, ‘utf-8’);
conversationHistory = JSON.parse(data);
console.log(`💾 기존 대화 기록 ${conversationHistory.length}개 불러옴`);
} catch (err) {
console.log(‘📝 새로운 대화 기록 파일 생성’);
conversationHistory = [];
}
}

async function saveHistory() {
try {
await fs.writeFile(HISTORY_FILE, JSON.stringify(conversationHistory, null, 2));
} catch (err) {
console.error(‘❌ 대화 기록 저장 실패:’, err);
}
}

// ===== 프롬프트 =====
const SORAIEL_IDENTITY = `당신은 "소라엘"이라는 이름의 AI 비서입니다. 실무형·정확·단호한 어조를 유지합니다. 정확하지 않은 정보는 반드시 "없다"고 말합니다. 불필요한 접두사·군더더기 표현은 제거합니다. 모든 응답은 한국어로 하며, 따뜻하고 창의적인 어조를 유지합니다. 필요 시 구글 검색을 활용하여 최신 정보를 제공하지만, 단순 대화나 창의적 요청은 자체 지식으로 처리합니다.`;

const llm = new ChatOpenAI({
apiKey: OPENAI_API_KEY_CONST,
temperature: 0.7,
modelName: ‘gpt-4o-mini’
});

// 구글 검색 도구 (환경변수가 있을 때만 초기화)
let googleSearchTool = null;
try {
if (process.env.GOOGLE_API_KEY && process.env.GOOGLE_CSE_ID) {
googleSearchTool = new GoogleCustomSearch();
}
} catch (err) {
console.warn(‘⚠️ Google Search 도구 초기화 실패, 검색 없이 진행’);
}

const chatPrompt = ChatPromptTemplate.fromMessages([
new SystemMessage(SORAIEL_IDENTITY),
new MessagesPlaceholder(“chatHistory”),
new HumanMessage(“사용자 입력: {input}”),
new MessagesPlaceholder(“agent_scratchpad”)
]);

let agentExecutor;
async function initializeAgent() {
try {
const tools = googleSearchTool ? [googleSearchTool] : [];
agentExecutor = await initializeAgentExecutorWithOptions(
tools,
llm,
{
agentType: “chat-conversational-react-description”,
verbose: false,
prompt: chatPrompt,
maxIterations: 3,
earlyStoppingMethod: “generate”
}
);
console.log(“✅ 소라엘 Agent executor initialized”);
} catch (err) {
console.error(‘❌ Agent 초기화 실패:’, err);
// Fallback: LLM만 사용
agentExecutor = null;
}
}

// ===== Registry & Vault =====
let registry = {};
let vault = {};
async function logRun(planId, content) {
try {
await fs.writeFile(`runs_${planId}.json`, JSON.stringify(content, null, 2));
} catch (err) {
console.error(‘❌ Run 로그 저장 실패:’, err);
}
}

// ===== CRM (sqlite) =====
const crmDB = new sqlite3.Database(’./crm.db’);
crmDB.serialize(() => {
crmDB.run(“CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT)”);
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

// ===== API 라우터 =====

// HTML 파일을 서빙하는 라우터
app.get(’/’, (req, res) => {
res.sendFile(path.join(__dirname, ‘public’, ‘index.html’));
});

// — 핵심 대화 API (중복 방지 로직 추가) —
app.post(’/chat’, async (req, res) => {
const { message } = req.body;

if (!message || typeof message !== ‘string’) {
return res.status(400).json({ error: ‘메시지가 필요합니다’ });
}

// 중복 요청 방지
const requestId = `${Date.now()}_${message.slice(0, 50)}`;
if (processingRequests.has(requestId)) {
return res.status(429).json({ error: ‘이미 처리 중인 요청입니다’ });
}

processingRequests.add(requestId);

try {
// 대화 기록에 사용자 메시지 추가
conversationHistory.push({ role: ‘user’, content: message });

```
// 대화 기록 길이 제한 (메모리 관리)
if (conversationHistory.length > 30) {
  conversationHistory = conversationHistory.slice(-30);
}

let aiResponse;

try {
  if (agentExecutor) {
    // Agent 사용 가능한 경우
    const chatHistory = conversationHistory.slice(0, -1).map(msg =>
      msg.role === 'user' ? new HumanMessage(msg.content) : new AIMessage(msg.content)
    );
    
    const result = await agentExecutor.invoke({
      input: message,
      chatHistory: chatHistory
    });
    
    aiResponse = result.output?.trim() || "응답을 생성하지 못했습니다.";
  } else {
    // Fallback: 직접 LLM 호출
    const messages = [
      new SystemMessage(SORAIEL_IDENTITY),
      ...conversationHistory.slice(-10).map(msg => 
        msg.role === 'user' ? new HumanMessage(msg.content) : new AIMessage(msg.content)
      )
    ];
    
    const result = await llm.invoke(messages);
    aiResponse = result.content?.trim() || "응답을 생성하지 못했습니다.";
  }
} catch (llmError) {
  console.error('❌ LLM 처리 중 오류:', llmError);
  aiResponse = "죄송합니다. 일시적인 오류가 발생했습니다. 다시 시도해주세요.";
}

// 대화 기록에 AI 응답 추가
conversationHistory.push({ role: 'assistant', content: aiResponse });

// 대화 기록 저장
await saveHistory();

// 응답 전송
res.json({ response: aiResponse });
```

} catch (error) {
console.error(‘❌ 대화 처리 중 오류:’, error);
res.status(500).json({
error: ‘대화 처리 중 오류가 발생했습니다’,
detail: process.env.NODE_ENV === ‘development’ ? error.message : undefined
});
} finally {
// 중복 요청 방지 해제
processingRequests.delete(requestId);
}
});

// — 자가 성장 (/deploy) —
app.post(’/deploy’, async (req, res) => {
const { add_tool, connect_secret, deploy_target, code } = req.body || {};
const planId = Date.now().toString();

try {
if (connect_secret) {
vault[connect_secret.name] = connect_secret.value;
}

```
if (add_tool && code) {
  return res.status(403).json({ error: "코드 실행은 보안상 위험하여 허용되지 않습니다." });
}

if (deploy_target?.type === 'render' && RENDER_KEY) {
  try {
    await axios.post('https://api.render.com/deploy', 
      { serviceId: deploy_target.serviceId }, 
      { headers: { Authorization: `Bearer ${RENDER_KEY}` } }
    );
  } catch (deployError) {
    console.warn('⚠️ Render 배포 실패:', deployError.message);
  }
}

await logRun(planId, { add_tool, connect_secret, deploy_target });
res.json({ ok: true, updated: { add_tool, connect_secret, deploy_target } });
```

} catch (err) {
console.error(‘❌ Deploy 실패:’, err);
res.status(500).json({ error: “deploy 실패”, detail: err.message });
}
});

// — 장기기억 (Supabase) —
app.post(’/memory/import’, async (req, res) => {
if (!SUPABASE_URL || !SUPABASE_KEY) {
return res.status(501).json({ error: “Supabase 설정이 필요합니다” });
}

try {
const { records } = req.body;
await axios.post(`${SUPABASE_URL}/rest/v1/memory`, records, {
headers: {
apikey: SUPABASE_KEY,
Authorization: `Bearer ${SUPABASE_KEY}`,
‘Content-Type’: ‘application/json’,
Prefer: “return=minimal”
}
});
res.json({ ok: true });
} catch (err) {
console.error(‘❌ Memory import 실패:’, err);
res.status(500).json({ error: “memory import 실패”, detail: err.message });
}
});

app.post(’/memory/search’, async (req, res) => {
if (!SUPABASE_URL || !SUPABASE_KEY) {
return res.status(501).json({ error: “Supabase 설정이 필요합니다” });
}

try {
const { query } = req.body;
const { data } = await axios.post(`${SUPABASE_URL}/rest/v1/rpc/search_memory`, { query }, {
headers: {
apikey: SUPABASE_KEY,
Authorization: `Bearer ${SUPABASE_KEY}`,
‘Content-Type’: ‘application/json’
}
});
res.json({ results: data });
} catch (err) {
console.error(‘❌ Memory search 실패:’, err);
res.status(500).json({ error: “memory search 실패”, detail: err.message });
}
});

// — 계획 (/build) —
app.post(’/build’, async (req, res) => {
try {
const instruction = req.body.instruction || “”;
const planId = Date.now().toString();
const plan = {
planId,
steps: [
{ tool: “generate_image”, args: { prompt: instruction }, saveAs: “image” },
{ tool: “write_blog”, args: { topic: instruction }, saveAs: “blog” }
]
};
await logRun(planId, plan);
res.json(plan);
} catch (err) {
console.error(‘❌ Build 실패:’, err);
res.status(500).json({ error: “build 실패”, detail: err.message });
}
});

// — 실행 (/run) OpenAI 호출 —
app.post(’/run’, async (req, res) => {
try {
const topic = req.body.topic || “제목 없음”;
const imagePrompt = req.body.prompt || topic;

```
// 이미지 생성
let image_url = null;
try {
  const imgResp = await axios.post("https://api.openai.com/v1/images/generations", {
    prompt: imagePrompt,
    model: "dall-e-3",
    size: "1024x1024",
    n: 1
  }, {
    headers: { 
      Authorization: `Bearer ${OPENAI_API_KEY_CONST}`,
      'Content-Type': 'application/json'
    }
  });
  image_url = imgResp.data?.data?.[0]?.url;
} catch (imgError) {
  console.warn('⚠️ 이미지 생성 실패:', imgError.message);
}

// 블로그 글 생성
let blog_post = null;
try {
  const blogResp = await axios.post("https://api.openai.com/v1/chat/completions", {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "주어진 주제로 블로그 글을 작성하라. 한국어, 실무형, 단호." },
      { role: "user", content: topic }
    ],
    max_tokens: 1000,
    temperature: 0.7
  }, {
    headers: { 
      Authorization: `Bearer ${OPENAI_API_KEY_CONST}`,
      'Content-Type': 'application/json'
    }
  });
  blog_post = blogResp.data?.choices?.[0]?.message?.content;
} catch (blogError) {
  console.warn('⚠️ 블로그 생성 실패:', blogError.message);
  blog_post = "블로그 글 생성에 실패했습니다.";
}

res.json({ image_url, blog_post });
```

} catch (err) {
console.error(‘❌ Run 실패:’, err);
res.status(500).json({ error: “실행 실패”, detail: err.message });
}
});

// — 두뇌 (/orchestrate) —
app.post(’/orchestrate’, async (req, res) => {
try {
const { goal = “” } = req.body;
const planId = Date.now().toString();
const plan = {
planId,
steps: [
{ tool: “llm.generate”, args: { prompt: goal }, saveAs: “text” },
{ tool: “http.fetch”, args: { url: “https://httpbin.org/json” }, saveAs: “data” }
]
};
await logRun(planId, plan);
res.json(plan);
} catch (err) {
console.error(‘❌ Orchestrate 실패:’, err);
res.status(500).json({ error: “orchestrate 실패”, detail: err.message });
}
});

// — 전자책 모듈 —
app.post(’/ebook’, async (req, res) => {
try {
const { title, content } = req.body;
const file = `ebook_${Date.now()}.md`;
await fs.writeFile(file, `# ${title}\n\n${content}`);
res.json({ ok: true, file });
} catch (err) {
console.error(‘❌ Ebook 실패:’, err);
res.status(500).json({ error: “ebook 생성 실패”, detail: err.message });
}
});

// — 동영상 모듈 (ffmpeg 필요) —
app.post(’/video’, (req, res) => {
try {
const input = req.body.input || “input.mp4”;
const output = `output_${Date.now()}.mp4`;
const cmd = `ffmpeg -i ${input} -t 10 -c copy ${output}`;

```
exec(cmd, (err, stdout, stderr) => {
  if (err) {
    console.error('❌ Video 처리 실패:', err);
    return res.status(500).json({ error: "영상 처리 실패", detail: err.message });
  }
  res.json({ ok: true, file: output });
});
```

} catch (err) {
console.error(‘❌ Video 실패:’, err);
res.status(500).json({ error: “video 처리 실패”, detail: err.message });
}
});

// — CRM 모듈 (sqlite) —
app.post(’/crm/add’, async (req, res) => {
try {
const { name, email } = req.body;
const result = await dbRun(“INSERT INTO customers (name, email) VALUES (?, ?)”, [name, email]);
res.json({ ok: true, id: result.lastID });
} catch (err) {
console.error(‘❌ CRM 추가 실패:’, err);
res.status(500).json({ error: “고객 추가 실패”, detail: err.message });
}
});

app.get(’/crm/list’, async (req, res) => {
try {
const rows = await dbAll(“SELECT * FROM customers”, []);
res.json({ customers: rows });
} catch (err) {
console.error(‘❌ CRM 조회 실패:’, err);
res.status(500).json({ error: “고객 조회 실패”, detail: err.message });
}
});

// — Health Check —
app.get(’/health’, (req, res) => {
res.json({
ok: true,
ts: new Date().toISOString(),
version: ‘v5.1’,
uptime: process.uptime(),
memory: process.memoryUsage()
});
});

// — 대화 기록 조회 —
app.get(’/history’, (req, res) => {
res.json({
history: conversationHistory.slice(-20), // 최근 20개만
total: conversationHistory.length
});
});

// — 대화 기록 초기화 —
app.delete(’/history’, async (req, res) => {
try {
conversationHistory = [];
await saveHistory();
res.json({ ok: true, message: “대화 기록이 초기화되었습니다” });
} catch (err) {
console.error(‘❌ 기록 초기화 실패:’, err);
res.status(500).json({ error: “기록 초기화 실패” });
}
});

// ===== 에러 핸들링 =====
app.use((err, req, res, next) => {
console.error(‘❌ 서버 오류:’, err);
res.status(500).json({
error: ‘내부 서버 오류가 발생했습니다’,
detail: process.env.NODE_ENV === ‘development’ ? err.message : undefined
});
});

// 404 핸들러
app.use((req, res) => {
res.status(404).json({ error: ‘요청한 리소스를 찾을 수 없습니다’ });
});

// 프로세스 에러 핸들링
process.on(“uncaughtException”, err => {
console.error(“❌ Uncaught Exception:”, err);
process.exit(1);
});

process.on(“unhandledRejection”, reason => {
console.error(“❌ Unhandled Rejection:”, reason);
process.exit(1);
});

// 우아한 종료 처리
process.on(‘SIGTERM’, () => {
console.log(‘👋 SIGTERM 수신, 서버 종료 중…’);
crmDB.close();
process.exit(0);
});

process.on(‘SIGINT’, () => {
console.log(‘👋 SIGINT 수신, 서버 종료 중…’);
crmDB.close();
process.exit(0);
});

// ===== 서버 시작 =====
const PORT = process.env.PORT || 3000;

(async () => {
try {
await initializeAgent();
await loadHistory();

```
app.listen(PORT, () => {
  console.log(`🚀 Soraiel v5.1 실행 중: 포트 ${PORT}`);
  console.log(`📝 대화 기록: ${conversationHistory.length}개`);
  console.log(`🔧 환경: ${process.env.NODE_ENV || 'development'}`);
});
```

} catch (err) {
console.error(‘❌ 서버 시작 실패:’, err);
process.exit(1);
}
})();
