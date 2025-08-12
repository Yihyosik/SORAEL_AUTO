// server.js — us2 + 고정 시나리오 + (단순화) 이름 PATCH → enable → GET 확인
import express from "express";
import axios from "axios";

const app = express();
app.use(express.json({ limit: "2mb" }));

// ===== ENV =====
const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MAKE_API_KEY = process.env.MAKE_API_KEY;
const MAKE_SCENARIO_ID = process.env.MAKE_SCENARIO_ID || "2718972"; // 기본값
const MAKE_API_BASE = (process.env.MAKE_API_BASE || "https://us2.make.com/api/v2").replace(/\/$/, "");

// ===== State =====
const runs = new Map();

// ===== Health =====
app.get("/health", (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

// (진단) 서버가 실제로 어떤 값으로 Make를 치는지 확인
app.get("/make-check", async (_req, res) => {
  try {
    const headers = { Authorization: `Token ${MAKE_API_KEY}` };
    let status = 200, body;
    try {
      const r = await axios.get(`${MAKE_API_BASE}/scenarios/${MAKE_SCENARIO_ID}`, { headers });
      body = r.data;
    } catch (e) {
      status = e.response?.status || 500;
      body = e.response?.data || e.message;
    }
    res.json({ base: MAKE_API_BASE, sid: MAKE_SCENARIO_ID, scenario_get_status: status, scenario_get_body: body });
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// ===== Build =====
app.post("/build", async (req, res) => {
  try {
    const { prompt = "", dryRun = true } = req.body || {};
    if (!prompt) return res.status(400).json({ error: "prompt required" });

    // 최소한의 더미 설계
    const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const blueprint = { nodes: [{ id: "ping", type: "ping", parameters: { target: "localhost", count: 1 } }], connections: [] };
    runs.set(runId, { workflow_spec: "Ping 작업", make_blueprint: blueprint, status: "built", dryRun });
    res.json({ runId, dryRun, workflow_spec: "Ping 작업을 수행하는 간단한 워크플로우입니다.", make_blueprint: blueprint });
  } catch (e) {
    res.status(500).json({ error: "build_failed", detail: e.response?.data || e.message });
  }
});

// ===== (단순화) Deploy: 블루프린트 PUT 제거, 이름 PATCH + enable + GET 확인만 수행 =====
app.post("/deploy", async (req, res) => {
  try {
    const { runId, dryRun = true } = req.body || {};
    if (!runId || !runs.has(runId)) return res.status(400).json({ error: "invalid runId" });

    const item = runs.get(runId);
    let scenarioId = dryRun ? `dry_${runId}` : MAKE_SCENARIO_ID;
    let status = dryRun ? "active(dryRun)" : "active(realRun)";
    let applied = false;
    let note = "mode=simple_patch_enable; ";

    if (!dryRun) {
      if (!MAKE_API_KEY || !MAKE_SCENARIO_ID) {
        return res.status(400).json({ error: "missing_env", detail: "MAKE_API_KEY or MAKE_SCENARIO_ID not set" });
      }
      try {
        const headers = { Authorization: `Token ${MAKE_API_KEY}` };
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const newName = `AutoScenario ${MAKE_SCENARIO_ID} ${ts}`;

        // 1) 이름 변경
        await axios.patch(`${MAKE_API_BASE}/scenarios/${MAKE_SCENARIO_ID}`, { name: newName }, { headers });
        note += "patch_ok; ";

        // 2) enable
        await axios.post(`${MAKE_API_BASE}/scenarios/${MAKE_SCENARIO_ID}/enable`, {}, { headers });
        note += "enable_ok; ";

        // 3) 확인
        const g = await axios.get(`${MAKE_API_BASE}/scenarios/${MAKE_SCENARIO_ID}`, { headers });
        const nameAfter = g.data?.scenario?.name || "";
        if (nameAfter.includes(ts)) applied = true;
      } catch (e) {
        const detail = e.response?.data || e.message;
        note += `error=${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
      }
    }

    runs.set(runId, { ...item, status, scenarioId, applied });
    res.json({ runId, scenarioId, status, applied, note });
  } catch (e) {
    res.status(500).json({ error: "deploy_failed", detail: e.response?.data || e.message });
  }
});

// ===== Telegram (생략 가능; 기존 그대로 쓰셔도 무방) =====
app.post("/telegram/webhook", async (req, res) => {
  try {
    const update = req.body;
    const msg = update?.message || update?.edited_message;
    if (!msg || !msg.text) return res.json({ ok: true });
    const chatId = msg.chat.id;
    const text = msg.text.trim();
    const dryRunFlag = !(/dryRun=false/i.test(text) || /(실발행|진짜|실제로)/.test(text));

    if (text === "/start") return res.json({ ok: true });

    const b = await axios.post(`${req.protocol}://${req.get("host")}/build`, { prompt: text, dryRun: dryRunFlag });
    const runId = b.data.runId;
    const d = await axios.post(`${req.protocol}://${req.get("host")}/deploy`, { runId, dryRun: dryRunFlag });

    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text:
        `✅ 완료 (${dryRunFlag ? "드라이런" : "실발행"})` +
        `\nrunId: ${runId}` +
        `\nstatus: ${d.data.status}` +
        `\nscenario: ${d.data.scenarioId}` +
        (dryRunFlag ? "" : `\napplied: ${d.data.applied ? "✅ 반영됨" : "❌ 미반영(로그확인)"}`) +
        (d.data.note ? `\nnote: ${d.data.note}` : "")
    });
    res.json({ ok: true });
  } catch {
    res.status(200).json({ ok: true });
  }
});

app.listen(PORT, () => console.log(`Sorael server running on :${PORT}`));
