// server.js — 루트 + build 포함 디버깅 완성본
import express from "express";
import axios from "axios";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 8080;
const MAKE_API_KEY = process.env.MAKE_API_KEY || "";
const MAKE_SCENARIO_ID = process.env.MAKE_SCENARIO_ID || "2718972";
const MAKE_API_BASE = (process.env.MAKE_API_BASE || "https://us2.make.com/api/v2").replace(/\/$/, "");
const MAKE_TEAM_ID = process.env.MAKE_TEAM_ID || "1169858";

const runs = new Map();
const H = () => ({ Authorization: `Token ${MAKE_API_KEY}` });
const ts = () => new Date().toISOString().replace(/[:.]/g, "-");
const qTeam = MAKE_TEAM_ID ? `&team_id=${encodeURIComponent(MAKE_TEAM_ID)}` : "";

app.get("/", (_req, res) => {
  res.send("✅ API 소라엘 서버 작동 중입니다.");
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

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
    let note = "mode=blueprint_put_then_patch_name(team_id); ";

    if (!dryRun) {
      if (!MAKE_API_KEY || !MAKE_SCENARIO_ID) return res.status(400).json({ error: "missing_env" });

      const steps = [];
      try {
        const getUrl = `${MAKE_API_BASE}/scenarios/${MAKE_SCENARIO_ID}/blueprint?confirmed=true${qTeam}`;
        console.log("🔎 GET:", getUrl);
        const g = await axios.get(getUrl, { headers: H() });

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

        const putUrl = `${MAKE_API_BASE}/scenarios/${MAKE_SCENARIO_ID}/blueprint?confirmed=true${qTeam}`;
        console.log("📤 PUT:", putUrl);

        await axios.put(putUrl, {
          blueprint: currentBlueprint,
          scheduling: currentScheduling
        }, {
          headers: { ...H(), "Content-Type": "application/json" }
        });
        steps.push("blueprint_put_ok");

        const stamp = ts();
        const newName = `AutoScenario ${MAKE_SCENARIO_ID} ${stamp}`;
        const patchUrl = `${MAKE_API_BASE}/scenarios/${MAKE_SCENARIO_ID}${qTeam}`;
        console.log("✏️ PATCH:", patchUrl);

        await axios.patch(patchUrl, { name: newName }, { headers: H() });
        steps.push("name_patch_ok");

        const startUrl = `${MAKE_API_BASE}/scenarios/${MAKE_SCENARIO_ID}/start${qTeam}`;
        console.log("▶️ START:", startUrl);

        try {
          await axios.post(startUrl, {}, { headers: H() });
          steps.push("start_ok");
        } catch (e2) {
          if (e2?.response?.data?.code === "IM306") steps.push("start_skipped_already_running");
          else throw e2;
        }

        const getFinal = `${MAKE_API_BASE}/scenarios/${MAKE_SCENARIO_ID}${qTeam}`;
        console.log("📥 FINAL CHECK:", getFinal);

        const after = await axios.get(getFinal, { headers: H() });
        if ((after.data?.scenario?.name || "").includes(stamp)) applied = true;

        scenarioId = MAKE_SCENARIO_ID;
        note += steps.join("; ") + "; ";
      } catch (e) {
        const detail = e.response?.data || e.message;
        console.log("❌ ERROR DETAIL:", detail);
        note += `error=${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
      }
    }

    runs.set(runId, { ...item, status, scenarioId, applied });
    res.json({ runId, scenarioId, status, applied, note });
  } catch (e) {
    res.status(500).json({ error: "deploy_failed", detail: e.message });
  }
});

app.listen(PORT, () => console.log(`✅ Server running on :${PORT}`));
