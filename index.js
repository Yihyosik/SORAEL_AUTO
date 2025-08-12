// server.js — Make(us2) 연동: 이름 PATCH + 블루프린트+scheduling PATCH + start + 확인
import express from "express";
import axios from "axios";

const app = express();
app.use(express.json({ limit: "2mb" }));

/* ===== ENV ===== */
const PORT = process.env.PORT || 8080;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const MAKE_API_KEY = process.env.MAKE_API_KEY || "";
const MAKE_SCENARIO_ID = process.env.MAKE_SCENARIO_ID || "2718972";
const MAKE_API_BASE = (process.env.MAKE_API_BASE || "https://us2.make.com/api/v2").replace(/\/$/, "");

/* ===== STATE ===== */
const runs = new Map();

/* ===== ROUTES ===== */
app.get("/health", (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

// 샘플 build — 실제 설계 로직에 맞게 수정 가능
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

// /deploy : 이름 + (blueprint, scheduling 문자열) "한 번의 PATCH" → start → 확인
app.post("/deploy", async (req, res) => {
  try {
    const { runId, dryRun = true } = req.body || {};
    if (!runId || !runs.has(runId)) return res.status(400).json({ error: "invalid runId" });

    const item = runs.get(runId);
    let scenarioId = dryRun ? `dry_${runId}` : MAKE_SCENARIO_ID;
    let status = dryRun ? "active(dryRun)" : "active(realRun)";
    let applied = false;
    let note = "mode=single_patch_with_scheduling; ";

    if (!dryRun) {
      if (!MAKE_API_KEY || !MAKE_SCENARIO_ID) return res.status(400).json({ error: "missing_env" });

      const headers = { Authorization: `Token ${MAKE_API_KEY}` };

      // bp 정규화
      let bp = item.make_blueprint;
      if (bp && typeof bp === "object" && bp.response?.blueprint) bp = bp.response.blueprint;
      if (typeof bp === "string") { try { bp = JSON.parse(bp); } catch {} }
      const bpValid = bp && typeof bp === "object" && Array.isArray(bp.flow);

      try {
        // 현재 scheduling 조회(없으면 기본값)
        let schedulingObj = { type: "indefinitely", interval: 900 };
        try {
          const g = await axios.get(`${MAKE_API_BASE}/scenarios/${MAKE_SCENARIO_ID}/blueprint`, { headers });
          schedulingObj = g.data?.response?.scheduling || schedulingObj;
        } catch { /* keep default */ }

        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const newName = `AutoScenario ${MAKE_SCENARIO_ID} ${ts}`;

        // ✅ /scenarios/{id} 에 name + blueprint(문자열) + scheduling(문자열) "한 번에 PATCH"
        const payload = {
          name: newName,
          ...(bpValid ? { blueprint: JSON.stringify(bp) } : {}),
          scheduling: JSON.stringify(schedulingObj)
        };

        await axios.patch(`${MAKE_API_BASE}/scenarios/${MAKE_SCENARIO_ID}?confirmed=true`, payload, { headers });
        note += (bpValid ? "patch_name_blueprint_scheduling_ok; " : "patch_name_scheduling_ok; ");

        // ▶ start (이미 실행 중이면 skip)
        try {
          await axios.post(`${MAKE_API_BASE}/scenarios/${MAKE_SCENARIO_ID}/start`, {}, { headers });
          note += "start_ok; ";
        } catch (e) {
          const code = e?.response?.data?.code;
          if (code === "IM306") note += "start_skipped_already_running; ";
          else throw e;
        }

        // ▷ 반영 확인(이름 포함 여부로 체크)
        const after = await axios.get(`${MAKE_API_BASE}/scenarios/${MAKE_SCENARIO_ID}`, { headers });
        if ((after.data?.scenario?.name || "").includes(ts)) applied = true;

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

// (선택) 텔레그램 웹훅
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
