// server.js — Make(us2) team_id 제거 + 텔레그램 자동응답 버전
import express from "express";
import axios from "axios";

const app = express();
app.use(express.json({ limit: "2mb" }));

/* ===== ENV ===== */
const PORT               = process.env.PORT || 8080;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const MAKE_API_KEY       = process.env.MAKE_API_KEY || "";
const MAKE_SCENARIO_ID   = process.env.MAKE_SCENARIO_ID || "2718972";
const MAKE_API_BASE      = (process.env.MAKE_API_BASE || "https://us2.make.com/api/v2").replace(/\/$/, "");

/* ===== STATE & UTILS ===== */
const runs = new Map();
const H = () => ({ Authorization: `Token ${MAKE_API_KEY}` });
const ts = () => new Date().toISOString().replace(/[:.]/g, "-");

/* ===== ROUTES ===== */
app.get("/health", (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

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

app.post("/deploy", async (req, res) => {
  try {
    const { runId, dryRun = true } = req.body || {};
    if (!runId || !runs.has(runId)) return res.status(400).json({ error: "invalid runId" });

    const item = runs.get(runId);
    let scenarioId = dryRun ? `dry_${runId}` : MAKE_SCENARIO_ID;
    let status = dryRun ? "active(dryRun)" : "active(realRun)";
    let applied = false;
    let note = "mode=blueprint_put_then_patch_name; ";

    if (!dryRun) {
      if (!MAKE_API_KEY || !MAKE_SCENARIO_ID) return res.status(400).json({ error: "missing_env" });

      const steps = [];
      try {
        const g = await axios.get(
          `${MAKE_API_BASE}/scenarios/${MAKE_SCENARIO_ID}/blueprint?confirmed=true`,
          { headers: H() }
        );
        const resp = g.data?.response || g.data || {};
        steps.push("blueprint_get_ok");

        let currentBlueprint = resp.blueprint || {};
        let currentScheduling = resp.scheduling || { type: "indefinitely", interval: 900 };

        let bp = item.make_blueprint;
        if (bp && typeof bp === "object" && bp.response?.blueprint) bp = bp.response.blueprint;
        if (typeof bp === "string") { try { bp = JSON.parse(bp); } catch { bp = null; } }
        if (bp && Array.isArray(bp.flow)) currentBlueprint = { ...currentBlueprint, flow: bp.flow };
        if (currentBlueprint && typeof currentBlueprint === "object") {
          currentBlueprint.__meta = { by: "api-sorael", at: new Date().toISOString() };
        }

        await axios.put(
          `${MAKE_API_BASE}/scenarios/${MAKE_SCENARIO_ID}/blueprint?confirmed=true`,
          { blueprint: currentBlueprint, scheduling: currentScheduling },
          { headers: { ...H(), "Content-Type": "application/json" } }
        );
        steps.push("blueprint_put_ok");

        const stamp = ts();
        const newName = `AutoScenario ${MAKE_SCENARIO_ID} ${stamp}`;
        await axios.patch(`${MAKE_API_BASE}/scenarios/${MAKE_SCENARIO_ID}`, { name: newName }, { headers: H() });
        steps.push("name_patch_ok");

        try {
          await axios.post(`${MAKE_API_BASE}/scenarios/${MAKE_SCENARIO_ID}/start`, {}, { headers: H() });
          steps.push("start_ok");
        } catch (e2) {
          if (e2?.response?.data?.code === "IM306") steps.push("start_skipped_already_running");
          else throw e2;
        }

        const after = await axios.get(`${MAKE_API_BASE}/scenarios/${MAKE_SCENARIO_ID}`, { headers: H() });
        if ((after.data?.scenario?.name || "").includes(stamp)) applied = true;

        scenarioId = MAKE_SCENARIO_ID;
        note += steps.join("; ") + "; ";
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

// ✅ 텔레그램 메시지 수신 → /build → /deploy → 결과 자동응답
app.post("/telegram/webhook", async (req, res) => {
  try {
    const update = req.body;
    const msg = update?.message || update?.edited_message;
    if (!msg || !msg.text) return res.json({ ok: true });

    const chatId = msg.chat.id;
    const text = msg.text.trim();
    const dryRunFlag = !(/dryRun=false/i.test(text) || /(실발행|진짜|실제로)/.test(text));

    const b = await axios.post(`${req.protocol}://${req.get("host")}/build`, {
      prompt: text,
      dryRun: dryRunFlag
    });

    const runId = b.data.runId;

    const d = await axios.post(`${req.protocol}://${req.get("host")}/deploy`, {
      runId,
      dryRun: dryRunFlag
    });

    if (TELEGRAM_BOT_TOKEN) {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: chatId,
        text:
          `✅ 완료 (${dryRunFlag ? "드라이런" : "실발행"})` +
          `\nrunId: ${runId}` +
          `\nstatus: ${d.status || d.data?.status}` +
          `\nscenario: ${d.scenarioId || d.data?.scenarioId}` +
          (dryRunFlag ? "" : `\napplied: ${(d.applied ?? d.data?.applied) ? "✅ 반영됨" : "❌ 미반영(로그확인)"}`) +
          ((d.note ?? d.data?.note) ? `\nnote: ${d.note ?? d.data?.note}` : "")
      });
    }

    res.json({ ok: true });
  } catch {
    res.json({ ok: true });
  }
});

app.listen(PORT, () => console.log(`Server running on :${PORT}`));
