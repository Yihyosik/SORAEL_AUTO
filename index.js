import express from "express";
import axios from "axios";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MAKE_API_KEY = process.env.MAKE_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MAKE_SCENARIO_ID = process.env.MAKE_SCENARIO_ID;

if (!OPENAI_API_KEY) {
  console.warn("[WARN] OPENAI_API_KEY is not set. /build will fail.");
}

const runs = new Map();

// Health check
app.get("/health", (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// /build : 자연어 → 설계(JSON)
app.post("/build", async (req, res) => {
  try {
    const { prompt = "", dryRun = true } = req.body || {};
    if (!prompt) return res.status(400).json({ error: "prompt required" });

    const sys = `너는 자동화 설계 보조 AI다. 사용자의 요청을 받아 'workflow_spec'(사람이 읽을 요약)과 'make_blueprint'(JSON) 두 가지로 반환한다. make_blueprint는 키/값이 안정적으로 파싱되게 작성한다.`;
    const user = `요청: ${prompt}\n제약: 최소 단계로, 게시/발행은 dryRun=${dryRun} 기준. 출력은 JSON만. 구조: {workflow_spec:{...}, make_blueprint:{...}}`;

    const resp = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user }
        ],
        temperature: 0.2
      },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
    );

    let content = resp.data?.choices?.[0]?.message?.content?.trim();
    if (content.startsWith("```")) content = content.replace(/^```[a-zA-Z]*\n|```$/g, "");

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = { workflow_spec: { summary: prompt }, make_blueprint: { steps: [] }, raw: content };
    }

    const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    runs.set(runId, { ...parsed, status: "built", dryRun });

    return res.json({ runId, dryRun, ...parsed });
  } catch (e) {
    console.error("/build error", e.response?.data || e.message);
    return res.status(500).json({ error: "build_failed", detail: e.response?.data || e.message });
  }
});

// /deploy : 설계 → 메이크 시나리오 업데이트/활성 (반영 확인)
app.post("/deploy", async (req, res) => {
  try {
    const { runId, dryRun = true } = req.body || {};
    if (!runId || !runs.has(runId)) return res.status(400).json({ error: "invalid runId" });

    const item = runs.get(runId);
    const bp = item.make_blueprint || {};
    const hasSteps =
      Array.isArray(bp.steps) ? bp.steps.length > 0 :
      Array.isArray(bp.nodes) ? bp.nodes.length > 0 :
      Object.keys(bp || {}).length > 0;

    let scenarioId = dryRun ? `dry_${runId}` : MAKE_SCENARIO_ID;
    let status = dryRun ? "active(dryRun)" : "active(realRun)";
    let applied = false;
    let makeMsg = "";

    if (!dryRun && MAKE_API_KEY && MAKE_SCENARIO_ID) {
      try {
        const headers = { Authorization: `Token ${MAKE_API_KEY}` };
        const ts = new Date().toISOString().replace(/[:.]/g, "-");

        // 이름 변경으로 권한·적용 여부 검증
        await axios.patch(
          `https://api.make.com/v2/scenarios/${scenarioId}`,
          { name: `AutoScenario ${scenarioId} ${ts}` },
          { headers }
        );

        if (hasSteps) {
          await axios.put(
            `https://api.make.com/v2/scenarios/${scenarioId}`,
            { blueprint: bp },
            { headers }
          );
          makeMsg += "[Make] blueprint PUT ok. ";
        } else {
          makeMsg += "[Make] blueprint is empty → skip PUT. ";
        }

        await axios.post(
          `https://api.make.com/v2/scenarios/${scenarioId}/enable`,
          {},
          { headers }
        );
        makeMsg += "enable ok. ";

        const g = await axios.get(
          `https://api.make.com/v2/scenarios/${scenarioId}`,
          { headers }
        );
        const nameAfter = g.data?.name || "";
        if (nameAfter.includes(ts)) applied = true;

      } catch (e) {
        const detail = e.response?.data || e.message;
        console.warn("[Make] scenario update/enable failed", detail);
        makeMsg += `error: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
      }
    }

    runs.set(runId, { ...item, status, scenarioId, applied });
    return res.json({ runId, scenarioId, status, applied, note: makeMsg });
  } catch (e) {
    console.error("/deploy error", e.response?.data || e.message);
    return res.status(500).json({ error: "deploy_failed", detail: e.response?.data || e.message });
  }
});

// /chat : 텍스트 → /build → /deploy
app.post("/chat", async (req, res) => {
  try {
    const { message = "", dryRun = true } = req.body || {};
    if (!message) return res.status(400).json({ error: "message required" });

    const b = await axios.post(`http://localhost:${PORT}/build`, { prompt: message, dryRun });
    const runId = b.data.runId;
    const d = await axios.post(`http://localhost:${PORT}/deploy`, { runId, dryRun });

    return res.json({ ok: true, runId, build: b.data, deploy: d.data });
  } catch (e) {
    console.error("/chat error", e.response?.data || e.message);
    return res.status(500).json({ error: "chat_failed", detail: e.response?.data || e.message });
  }
});

// 텔레그램 웹훅
app.post("/telegram/webhook", async (req, res) => {
  try {
    const update = req.body;
    const msg = update?.message || update?.edited_message;
    if (!msg || !msg.text) return res.json({ ok: true });

    const chatId = msg.chat.id;
    const text = msg.text.trim();
    const dryRunFlag = !(/dryRun=false/i.test(text) || /(실제로|실발행|진짜)/.test(text));

    if (text === "/start") {
      await sendTG(chatId, "안녕하세요! 명령을 보내주세요.\n예시: 드라이런으로 쿠팡 신상품 3개 리뷰 작성 후 블로그 발행 워크플로우");
      return res.json({ ok: true });
    }

    const b = await axios.post(`http://localhost:${PORT}/build`, { prompt: text, dryRun: dryRunFlag });
    const runId = b.data.runId;
    const d = await axios.post(`http://localhost:${PORT}/deploy`, { runId, dryRun: dryRunFlag });

    await sendTG(
      chatId,
      `✅ 완료 (${dryRunFlag ? "드라이런" : "실발행"})\nrunId: ${runId}\nstatus: ${d.data.status}\nscenario: ${d.data.scenarioId}` +
      (dryRunFlag ? "" : `\napplied: ${d.data.applied ? "✅ 반영됨" : "❌ 미반영(로그확인)"}`)
    );
    return res.json({ ok: true });
  } catch (e) {
    console.error("/telegram/webhook error", e.response?.data || e.message);
    return res.status(200).json({ ok: true });
  }
});

async function sendTG(chatId, text) {
  if (!TELEGRAM_BOT_TOKEN) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  await axios.post(url, { chat_id: chatId, text });
}

app.listen(PORT, () => {
  console.log(`Sorael server running on :${PORT}`);
});
