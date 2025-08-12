// server.js — Make(us2) 안정 연동: blueprint PUT(객체) + name PATCH + start + 확인
import express from "express";
import axios from "axios";

const app = express();
app.use(express.json({ limit: "2mb" }));

/* ===== ENV ===== */
const PORT              = process.env.PORT || 8080;
const TELEGRAM_BOT_TOKEN= process.env.TELEGRAM_BOT_TOKEN || "";
const MAKE_API_KEY      = process.env.MAKE_API_KEY || "";
const MAKE_SCENARIO_ID  = process.env.MAKE_SCENARIO_ID || "2718972";
const MAKE_API_BASE     = (process.env.MAKE_API_BASE || "https://us2.make.com/api/v2").replace(/\/$/, "");

/* ===== STATE ===== */
const runs = new Map();

/* ===== UTILS ===== */
const headers = () => ({ Authorization: `Token ${MAKE_API_KEY}` });
const nowStamp = () => new Date().toISOString().replace(/[:.]/g, "-");

/* ===== ROUTES ===== */
app.get("/health", (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

// 샘플 /build — 실제 설계 생성 로직은 이후 교체
app.post("/build", async (req, res) => {
  try {
    const { prompt = "", dryRun = true } = req.body || {};
    if (!prompt) return res.status(400).json({ error: "prompt required" });

    const blueprint = {
      flow: [
        { id: 1, module: "gateway:CustomWebHook", version: 1, mapper: {}, metadata: { label: "Webhook In" } }
      ],
      metadata: { name: "AutoFlow", description: prompt }
    };

    const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    runs.set(runId, { workflow_spec: `요청: ${prompt}`, make_blueprint: blueprint, status: "built", dryRun });
    res.json({ runId, dryRun, workflow_spec: `Ping: ${prompt}`, make_blueprint: blueprint });
  } catch (e) {
    res.status(500).json({ error: "build_failed", detail: e.response?.data || e.message });
  }
});

/**
 * /deploy
 * - blueprint & scheduling: PUT /scenarios/{id}/blueprint
 * - name: PATCH /scenarios/{id}
 * - start: POST /scenarios/{id}/start
 * - 적용 확인: GET /scenarios/{id}
 */
app.post("/deploy", async (req, res) => {
  try {
    const { runId, dryRun = true } = req.body || {};
    if (!runId || !runs.has(runId)) return res.status(400).json({ error: "invalid runId" });

    const item = runs.get(runId);
    let scenarioId = dryRun ? `dry_${runId}` : MAKE_SCENARIO_ID;
    let status = dryRun ? "active(dryRun)" : "active(realRun)";
    let applied = false;
    let note = "mode=blueprint_put_then_name_patch; ";

    if (!dryRun) {
      if (!MAKE_API_KEY || !MAKE_SCENARIO_ID) {
        return res.status(400).json({ error: "missing_env" });
      }

      try {
        // 현재 블루프린트/스케줄링 GET
        const g = await axios.get(`${MAKE_API_BASE}/scenarios/${MAKE_SCENARIO_ID}/blueprint`, { headers: headers() });
        const resp = g.data?.response || g.data || {};
        let currentBlueprint = resp.blueprint || {};
        let currentScheduling = resp.scheduling || { type: "indefinitely", interval: 900 };

        // build에서 만든 bp가 있으면 flow만 교체
        let bp = item.make_blueprint;
        if (bp && typeof bp === "object" && bp.response?.blueprint) bp = bp.response.blueprint;
        if (typeof bp === "string") { try { bp = JSON.parse(bp); } catch { bp = null; } }
        if (bp && Array.isArray(bp.flow)) currentBlueprint = { ...currentBlueprint, flow: bp.flow };
        if (currentBlueprint && typeof currentBlueprint === "object") {
          currentBlueprint.__meta = { by: "api-sorael", at: new Date().toISOString() };
        }

        // 블루프린트 전용 PUT
        await axios.put(
          `${MAKE_API_BASE}/scenarios/${MAKE_SCENARIO_ID}/blueprint?confirmed=true`,
          { blueprint: currentBlueprint, scheduling: currentScheduling },
          { headers: { ...headers(), "Content-Type": "application/json" } }
        );
        note += "blueprint_put_ok; ";

        // 이름 PATCH
        const ts = nowStamp();
        const newName = `AutoScenario ${MAKE_SCENARIO_ID} ${ts}`;
        await axios.patch(`${MAKE_API_BASE}/scenarios/${MAKE_SCENARIO_ID}`, { name: newName }, { headers: headers() });
        note += "name_patch_ok; ";

        // start
        try {
          await axios.post(`${MAKE_API_BASE}/scenarios/${MAKE_SCENARIO_ID}/start`, {}, { headers: headers() });
          note += "start_ok; ";
        } catch (e) {
          if (e?.response?.data?.code === "IM306") note += "start_skipped_already_running; ";
          else throw e;
        }

        // 반영 확인
        const after = await axios.get(`${MAKE_API_BASE}/scenarios/${MAKE_SCENARIO_ID}`, { headers: headers() });
        if ((after.data?.scenario?.name || "").includes(newName)) applied = true;

        scenarioId = MAKE_SCENARIO_ID;
      } catch (e) {
        const detail = e.response?.data || e.message;
        note += `error=${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
      }
    }

    runs.set(runId, { ...item, status, scenarioId, applied });
    res.json({ runId, scenarioId, status, applied, note });
  } catch (e) {
    res.status(500).json({ error: "deploy_failed", detail: e.message });
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
    const dryRunFlag = !(/dryRun=false/i.test(text) || /(실발행|진짜|실제로)/.test(text));

    const b = await axios.post(`${req.protocol}://${req.get("host")}/build`, { prompt: text, dryRun: dryRunFlag });
    const runId = b.data.runId;
    const d = await axios.post(`${req.protocol}://${req.get("host")}/deploy`, { runId, dryRun: dryRunFlag });

    if (TELEGRAM_BOT_TOKEN) {
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
    }
    res.json({ ok: true });
  } catch {
    res.json({ ok: true });
  }
});

app.listen(PORT, () => console.log(`Server running on :${PORT}`));
