// server.js — Make(us2) 연동 최종본: 이름 PATCH + 블루프린트 PATCH + start + 확인
import express from "express";
import axios from "axios";

const app = express();
app.use(express.json({ limit: "2mb" }));

/* ===== ENV ===== */
const PORT = process.env.PORT || 8080;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const MAKE_API_KEY = process.env.MAKE_API_KEY || "";
const MAKE_SCENARIO_ID = process.env.MAKE_SCENARIO_ID || "2718972"; // 필요 시 덮어쓰기
const MAKE_API_BASE = (process.env.MAKE_API_BASE || "https://us2.make.com/api/v2").replace(/\/$/, "");

/* ===== STATE ===== */
const runs = new Map();

/* ===== HELPERS ===== */
const ok = (res, data) => res.json(data);
const errJson = (res, code, msg) => res.status(code).json({ error: msg });
const authHeaders = () => ({ Authorization: `Token ${MAKE_API_KEY}` });

function normalizeBlueprintMaybe(bp) {
  // bp가 다양한 형태로 올 수 있어 안전하게 정규화
  // 1) { response: { blueprint: {...} } } 형태 → 꺼내기
  if (bp && typeof bp === "object" && bp.response && bp.response.blueprint) {
    bp = bp.response.blueprint;
  }
  // 2) 문자열이면 JSON 파싱 시도
  if (typeof bp === "string") {
    try { bp = JSON.parse(bp); } catch { /* 그대로 둠 */ }
  }
  // 3) 최종 유효성: flow 배열이 있으면 OK
  const valid = bp && typeof bp === "object" && Array.isArray(bp.flow);
  return { bp, valid };
}

/* ===== ROUTES ===== */
app.get("/health", (_req, res) => ok(res, { ok: true, uptime: process.uptime() }));

// (진단) 서버가 실제로 어떤 설정으로 Make를 치는지 확인
app.get("/make-check", async (_req, res) => {
  try {
    const headers = authHeaders();
    let status = 200, body;
    try {
      const r = await axios.get(`${MAKE_API_BASE}/scenarios/${MAKE_SCENARIO_ID}`, { headers });
      body = r.data;
    } catch (e) {
      status = e.response?.status || 500;
      body = e.response?.data || e.message;
    }
    ok(res, { base: MAKE_API_BASE, sid: MAKE_SCENARIO_ID, scenario_get_status: status, scenario_get_body: body });
  } catch (e) {
    errJson(res, 500, e.response?.data || e.message);
  }
});

// 최소 /build: 임시 블루프린트(flow) 생성 (원하면 교체 가능)
app.post("/build", async (req, res) => {
  try {
    const { prompt = "", dryRun = true } = req.body || {};
    if (!prompt) return errJson(res, 400, "prompt required");

    // 아주 단순한 샘플 블루프린트(flow/metadata 구조)
    const blueprint = {
      flow: [
        {
          id: 1,
          module: "gateway:CustomWebHook",
          version: 1,
          mapper: {},
          metadata: { label: "Webhook In" }
        }
      ],
      metadata: { name: "AutoFlow", description: prompt }
    };

    const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    runs.set(runId, {
      workflow_spec: `요청: ${prompt}`,
      make_blueprint: blueprint,
      status: "built",
      dryRun
    });

    ok(res, { runId, dryRun, workflow_spec: `Ping: ${prompt}`, make_blueprint: blueprint });
  } catch (e) {
    errJson(res, 500, e.response?.data || e.message);
  }
});

// /deploy : 이름 PATCH → 블루프린트 갱신(put→patch 폴백) → start → 확인
app.post("/deploy", async (req, res) => {
  try {
    const { runId, dryRun = true } = req.body || {};
    if (!runId || !runs.has(runId)) return res.status(400).json({ error: "invalid runId" });

    const item = runs.get(runId);
    let scenarioId = dryRun ? `dry_${runId}` : process.env.MAKE_SCENARIO_ID;
    let status = dryRun ? "active(dryRun)" : "active(realRun)";
    let applied = false;
    let note = "mode=name_then_blueprint_start(fallback); ";

    if (!dryRun) {
      const MAKE_API_BASE = (process.env.MAKE_API_BASE || "https://us2.make.com/api/v2").replace(/\/$/, "");
      const MAKE_API_KEY = process.env.MAKE_API_KEY;
      const SCENARIO_ID = process.env.MAKE_SCENARIO_ID;
      if (!MAKE_API_KEY || !SCENARIO_ID) return res.status(400).json({ error: "missing_env" });

      const headers = { Authorization: `Token ${MAKE_API_KEY}` };

      // bp 정규화
      let bp = item.make_blueprint;
      if (bp && typeof bp === "object" && bp.response?.blueprint) bp = bp.response.blueprint;
      if (typeof bp === "string") { try { bp = JSON.parse(bp); } catch {} }
      const bpValid = bp && typeof bp === "object" && Array.isArray(bp.flow);

      try {
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const newName = `AutoScenario ${SCENARIO_ID} ${ts}`;

        // 1) 이름 PATCH (/scenarios/{id})
        await axios.patch(`${MAKE_API_BASE}/scenarios/${SCENARIO_ID}`, { name: newName }, { headers });
        note += "patch_name_ok; ";

        // 2) 블루프린트 갱신 시도 (/scenarios/{id}/blueprint)
        if (bpValid) {
          // 현재 scheduling 유지용 GET
          let schedulingObj = { type: "indefinitely", interval: 900 };
          try {
            const bpGet = await axios.get(`${MAKE_API_BASE}/scenarios/${SCENARIO_ID}/blueprint`, { headers });
            schedulingObj = bpGet.data?.response?.scheduling || schedulingObj;
          } catch { /* ignore */ }

          const payload = {
            blueprint: JSON.stringify(bp),
            scheduling: JSON.stringify(schedulingObj)
          };

          let bpUpdated = false;
          // 2-1) PUT 우선
          try {
            await axios.put(`${MAKE_API_BASE}/scenarios/${SCENARIO_ID}/blueprint`, payload, { headers });
            note += "blueprint_put_ok; ";
            bpUpdated = true;
          } catch (e1) {
            // 2-2) PATCH 폴백
            try {
              await axios.patch(`${MAKE_API_BASE}/scenarios/${SCENARIO_ID}/blueprint`, payload, { headers });
              note += "blueprint_patch_ok; ";
              bpUpdated = true;
            } catch (e2) {
              const d1 = e1.response?.data || e1.message;
              const d2 = e2.response?.data || e2.message;
              note += `blueprint_failed(${JSON.stringify(d1)} | ${JSON.stringify(d2)}); `;
            }
          }
        } else {
          note += "blueprint_skip_invalid_shape; ";
        }

        // 3) start (이미 실행 중이면 skip)
        try {
          await axios.post(`${MAKE_API_BASE}/scenarios/${SCENARIO_ID}/start`, {}, { headers });
          note += "start_ok; ";
        } catch (e) {
          const code = e?.response?.data?.code;
          if (code === "IM306") note += "start_skipped_already_running; ";
          else throw e;
        }

        // 4) 확인
        const g = await axios.get(`${MAKE_API_BASE}/scenarios/${SCENARIO_ID}`, { headers });
        const nameAfter = g.data?.scenario?.name || "";
        if (nameAfter.includes(ts)) applied = true;

        scenarioId = SCENARIO_ID;
      } catch (e) {
        const detail = e.response?.data || e.message;
        note += `error=${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
      }
    }

    runs.set(runId, { ...item, status, scenarioId, applied });
    return res.json({ runId, scenarioId, status, applied, note });
  } catch (e) {
    return res.status(500).json({ error: "deploy_failed", detail: e.message });
  }
});
/* (선택) 텔레그램 웹훅 — 필요 없으면 제거 가능 */
app.post("/telegram/webhook", async (req, res) => {
  try {
    const update = req.body;
    const msg = update?.message || update?.edited_message;
    if (!msg || !msg.text) return ok(res, { ok: true });

    const chatId = msg.chat.id;
    const text = msg.text.trim();
    const dryRunFlag = !(/dryRun=false/i.test(text) || /(실발행|진짜|실제로)/.test(text));

    // build → deploy
    const b = await axios.post(`${req.protocol}://${req.get("host")}/build`, { prompt: text, dryRun: dryRunFlag });
    const runId = b.data.runId;
    const d = await axios.post(`${req.protocol}://${req.get("host")}/deploy`, { runId, dryRun: dryRunFlag });

    // 알림
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
    ok(res, { ok: true });
  } catch {
    ok(res, { ok: true });
  }
});

app.listen(PORT, () => console.log(`Sorael server running on :${PORT}`));
