// index.js — Orchestrator + Make(Webhook/ OAuth-Bearer / Token) + teamId + Auto Refresh (완전본)
// - 우선순위: Webhook → OAuth Bearer → Token
// - /make/run: SCENARIO_WEBHOOK_URL 있으면 웹훅 POST로 실행, 없으면 API(run)
// - /make/deploy: API 필요(유료/OAuth 권장). Free 플랜은 UI로 관리 권장
// - /__whoami로 현재 인증 모드/환경 빠르게 점검

const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({ limit: "1mb" }));

// ===== Static files (/files)
const FILE_DIR = path.join(process.cwd(), "files");
if (!fs.existsSync(FILE_DIR)) fs.mkdirSync(FILE_DIR, { recursive: true });
app.use("/files", express.static(FILE_DIR, { maxAge: "1d", immutable: true }));

// ===== ENV
const PORT = (process.env.PORT || 8080);
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();

const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || "").trim();

// Make 공통
const MAKE_API_BASE = (process.env.MAKE_API_BASE || "https://us2.make.com/api/v2").trim();
const MAKE_TEAM_ID = (process.env.MAKE_TEAM_ID || "").trim();

// Webhook 우선
const SCENARIO_WEBHOOK_URL = (process.env.SCENARIO_WEBHOOK_URL || "").trim();

// OAuth Bearer (권장)
const MAKE_BEARER = (process.env.MAKE_BEARER || "").trim(); // 직접 넣은 액세스 토큰(단기)
const MAKE_OAUTH_CLIENT_ID = (process.env.MAKE_OAUTH_CLIENT_ID || "").trim();
const MAKE_OAUTH_CLIENT_SECRET = (process.env.MAKE_OAUTH_CLIENT_SECRET || "").trim();
const MAKE_OAUTH_REFRESH_TOKEN = (process.env.MAKE_OAUTH_REFRESH_TOKEN || "").trim();

// Token (조직 정책에 따라 금지될 수 있음)
const MAKE_TOKEN = ((process.env.MAKE_TOKEN || process.env.MAKE_API_KEY || "")).trim();

// ===== OpenAI client
const openai = axios.create({
  baseURL: "https://api.openai.com/v1",
  headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
  timeout: 60000
});

// ===== Utils
const ok = (res, data) => res.json({ ok: true, ...data });
const err = (res, code, detail) => res.status(code).json({ ok: false, error: "run_failed", detail });
const id = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function withRetry(fn, { tries = 3, baseDelay = 700 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(i); } catch (e) {
      lastErr = e;
      const status = e?.response?.status;
      const typ = e?.response?.data?.error?.type || e?.code || "";
      if (status === 401 || status === 403 || (status === 400 && /invalid|model|param/i.test(typ))) throw e;
      await sleep(baseDelay * Math.pow(2, i));
    }
  }
  throw lastErr;
}

// ===== OpenAI helpers
async function generateImageStable(prompt, sizeWanted, baseUrl) {
  const sizes = [sizeWanted || "1024x1024", "512x512"];
  let lastError;
  for (const s of sizes) {
    try {
      const data = await withRetry(async () => {
        const resp = await openai.post("/images/generations", { model: "gpt-image-1", prompt, size: s });
        return resp.data;
      }, { tries: 2, baseDelay: 800 });

      const url = data?.data?.[0]?.url;
      if (url) return url;
      const b64 = data?.data?.[0]?.b64_json;
      if (b64) {
        const filename = `${id()}.png`;
        fs.writeFileSync(path.join(FILE_DIR, filename), Buffer.from(b64, "base64"));
        return `${baseUrl}/files/${filename}`;
      }
      throw new Error(`이미지 응답에 url/b64 없음(size=${s})`);
    } catch (e) { lastError = e; }
  }
  const detail = lastError?.response?.data || lastError?.message || String(lastError);
  throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
}

async function writeBlogStable(topic, imageUrl) {
  const { data } = await withRetry(() => openai.post("/chat/completions", {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "너는 간결하고 읽기 쉬운 한국어 블로그 글을 작성하는 어시스턴트다." },
      { role: "user", content:
`다음 주제로 800~1000자 리뷰 글 작성.
- 주제: ${topic}
${imageUrl ? `- 본문에 아래 이미지 URL 1회 삽입: ${imageUrl}` : ""}
- 구성: 한 문단 요약 → 제품 3개 핵심 포인트(불릿) → 간단 비교표(텍스트) → 마무리 추천
- 어투: 담백, 과장 금지, 표기는 마크다운` }
    ],
    temperature: 0.7,
    max_tokens: 800
  }), { tries: 2, baseDelay: 600 });
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("블로그 본문 생성 실패");
  return text;
}

// ===== Public: health
app.get("/health", (_req, res) => ok(res, { ts: new Date().toISOString() }));

// ===== Debug: whoami
app.get("/__whoami", (_req, res) => {
  const mode =
    SCENARIO_WEBHOOK_URL ? "webhook" :
    (MAKE_BEARER || (MAKE_OAUTH_CLIENT_ID && MAKE_OAUTH_CLIENT_SECRET && MAKE_OAUTH_REFRESH_TOKEN))
      ? "oauth-bearer"
      : (MAKE_TOKEN ? "token" : "none");

  res.json({
    ok: true,
    tag: "whoami",
    ts: new Date().toISOString(),
    env: {
      has_OPENAI_API_KEY: !!OPENAI_API_KEY,
      has_ADMIN_TOKEN: !!ADMIN_TOKEN,
      MAKE_API_BASE,
      MAKE_TEAM_ID,
      mode,
      has_WEBHOOK: !!SCENARIO_WEBHOOK_URL
    },
    routes: ["/health", "/__whoami", "/files/*", "/housekeep", "/run", "/make/ping", "/make/deploy", "/make/run"]
  });
});

// ===== Admin-token protection (except health/whoami)
app.use((req, res, next) => {
  if (req.path === "/health" || req.path === "/__whoami") return next();
  if (!ADMIN_TOKEN) return next();
  const got = req.headers["x-admin-token"];
  if (got === ADMIN_TOKEN) return next();
  return res.status(401).json({ ok: false, error: "unauthorized" });
});

// ===== OAuth Bearer manager
const OAUTH = {
  cached: { token: MAKE_BEARER || "", exp: 0 },
  async getAccessToken() {
    if (SCENARIO_WEBHOOK_URL) return ""; // 웹훅 모드면 Bearer 불필요
    if (MAKE_BEARER) return MAKE_BEARER;

    if (MAKE_OAUTH_CLIENT_ID && MAKE_OAUTH_CLIENT_SECRET && MAKE_OAUTH_REFRESH_TOKEN) {
      const now = Math.floor(Date.now() / 1000);
      if (OAUTH.cached.token && OAUTH.cached.exp > now + 30) return OAUTH.cached.token;

      const params = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: MAKE_OAUTH_REFRESH_TOKEN,
        client_id: MAKE_OAUTH_CLIENT_ID,
        client_secret: MAKE_OAUTH_CLIENT_SECRET
      });
      const { data } = await axios.post("https://www.make.com/oauth/v2/token", params.toString(), {
        headers: { "content-type": "application/x-www-form-urlencoded" },
        timeout: 15000
      });
      const access = data?.access_token;
      const expiresIn = data?.expires_in || 3600;
      if (!access) throw new Error("OAuth: access_token 없음");
      OAUTH.cached.token = access;
      OAUTH.cached.exp = Math.floor(Date.now() / 1000) + (expiresIn - 30);
      return access;
    }
    return "";
  }
};

// ===== Make API caller (dual mode; webhook 우선이므로 API는 보조)
async function callMake(method, url, { params, data } = {}) {
  let headers = { "Content-Type": "application/json" };
  let using = "token";

  const bearer = await OAUTH.getAccessToken();
  if (bearer) {
    headers.Authorization = `Bearer ${bearer}`;
    using = "bearer";
  } else if (MAKE_TOKEN) {
    headers.Authorization = `Token ${MAKE_TOKEN}`;
    using = "token";
  } else {
    throw new Error("Make 인증정보 없음(Bearer/Token)");
  }

  const r = await axios.request({
    method,
    baseURL: MAKE_API_BASE,
    url,
    headers,
    params,
    data,
    timeout: 20000,
    validateStatus: () => true
  });

  if (r.status >= 200 && r.status < 300) return { data: r.data, using, status: r.status };
  const detail = r.data || { status: r.status };
  if (r.status === 403 && using === "token") {
    throw new Error("SC403: 조직이 Token 인증 금지. OAuth(Bearer)로 전환 필요.");
  }
  throw Object.assign(new Error(`Make API ${r.status}`), { detail });
}

// ===== Make routes
// ping: Free/Webhook 모드에선 API 대신 간단 상태만
app.get("/make/ping", async (_req, res) => {
  try {
    if (SCENARIO_WEBHOOK_URL) {
      return res.json({ ok: true, mode: "webhook", webhook: SCENARIO_WEBHOOK_URL });
    }
    if (!MAKE_TEAM_ID) return res.status(400).json({ ok: false, error: "missing_MAKE_TEAM_ID" });
    const out = await callMake("GET", "/scenarios", { params: { limit: 1, teamId: MAKE_TEAM_ID } });
    res.json({ ok: true, mode: out.using, sample: out.data });
  } catch (e) {
    res.status(500).json({ ok: false, detail: e.detail || e.message });
  }
});

// deploy: API 필요(유료/OAuth 권장). Free에서는 UI로 변경 권장
app.post("/make/deploy", async (req, res) => {
  try {
    if (SCENARIO_WEBHOOK_URL) {
      return res.status(400).json({ ok: false, error: "not_supported_in_webhook_mode" });
    }
    const { scenarioId, blueprint } = req.body || {};
    if (!MAKE_TEAM_ID) return res.status(400).json({ ok: false, error: "missing_MAKE_TEAM_ID" });
    if (!scenarioId || !blueprint) return res.status(400).json({ ok: false, error: "need scenarioId & blueprint" });

    await callMake("POST", `/scenarios/${scenarioId}/deactivate`, { params: { teamId: MAKE_TEAM_ID } });
    await callMake("PUT", `/scenarios/${scenarioId}/blueprint`, { params: { teamId: MAKE_TEAM_ID }, data: blueprint });
    await callMake("POST", `/scenarios/${scenarioId}/activate`, { params: { teamId: MAKE_TEAM_ID } });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, detail: e.detail || e.message });
  }
});

// run: Webhook 우선 → 없으면 API(run)
app.post("/make/run", async (req, res) => {
  try {
    const payload = req.body?.payload || {};
    if (SCENARIO_WEBHOOK_URL) {
      const r = await axios.post(SCENARIO_WEBHOOK_URL, payload, {
        headers: { "Content-Type": "application/json" },
        timeout: 20000
      });
      return res.json({ ok: true, mode: "webhook", result: r.data || true });
    }

    // API 경로 (유료/OAuth)
    const { scenarioId } = req.body || {};
    if (!MAKE_TEAM_ID) return res.status(400).json({ ok: false, error: "missing_MAKE_TEAM_ID" });
    if (!scenarioId) return res.status(400).json({ ok: false, error: "need scenarioId" });

    const out = await callMake("POST", `/scenarios/${scenarioId}/run`, { params: { teamId: MAKE_TEAM_ID } });
    res.json({ ok: true, mode: out.using, result: out.data || true });
  } catch (e) {
    res.status(500).json({ ok: false, detail: e.response?.data || e.message });
  }
});

// ===== housekeeping
app.post("/housekeep", (_req, res) => {
  const now = Date.now(), DAY = 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const f of fs.readdirSync(FILE_DIR)) {
    try {
      const p = path.join(FILE_DIR, f);
      const st = fs.statSync(p);
      if (now - st.mtimeMs > DAY) { fs.unlinkSync(p); removed++; }
    } catch {}
  }
  ok(res, { removed });
});

/**
 * /run — sample pipeline (OpenAI)
 */
app.post("/run", async (req, res) => {
  try {
    if (!OPENAI_API_KEY) return res.status(400).json({ ok: false, error: "missing_OPENAI_API_KEY" });
    const plan = req.body?.plan;
    if (!plan || !Array.isArray(plan.modules)) return res.status(400).json({ ok: false, error: "invalid_plan" });

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const results = [];
    const context = {};

    for (const mod of plan.modules) {
      const t = mod?.type;

      if (t === "generate_image") {
        const prompt = mod.prompt || "부드러운 그래디언트 배경, 일러스트 스타일";
        const size = mod.size || "1024x1024";
        const imageUrl = await generateImageStable(prompt, size, baseUrl);
        context.image_url = imageUrl;
        results.push({ type: t, ok: true, image_url: imageUrl });
      } else if (t === "write_blog") {
        const topic = mod.topic || "신상품 3개 리뷰 작성";
        const blog = await writeBlogStable(topic, context.image_url);
        context.blog_post = blog;
        results.push({ type: t, ok: true, blog_post: blog });
      } else {
        results.push({ type: t || "unknown", ok: false, error: "unknown_module" });
      }
    }

    return ok(res, { results, context });
  } catch (e) {
    const detail = e?.response?.data || e?.message || String(e);
    return err(res, 500, detail);
  }
});

// ===== Guards
process.on("unhandledRejection", (r) => console.error("UnhandledRejection:", r));
process.on("uncaughtException", (e) => console.error("UncaughtException:", e));

// ===== Start
app.listen(PORT, () => console.log(`orchestrator running on :${PORT}`));
