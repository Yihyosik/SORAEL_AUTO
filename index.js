// index.js — 오케스트레이션 안정판 (+ Make 연동/보안/팀ID 포함 완전본)
// - generate_image: url 우선, 없으면 b64→파일 저장, 60s 타임아웃, 2회 재시도, 1024→512 자동 다운스케일
// - write_blog: 안정 파라미터, JSON 실패 원문 반환
// - ADMIN_TOKEN 보안, /__whoami, /make/ping, /make/deploy(Off→PUT→On), /make/run(API 실행, teamId 포함)

const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({ limit: "1mb" })); // 입력 과대 방지

// 정적 파일 폴더(/files)
const FILE_DIR = path.join(process.cwd(), "files");
if (!fs.existsSync(FILE_DIR)) fs.mkdirSync(FILE_DIR, { recursive: true });
app.use("/files", express.static(FILE_DIR, { maxAge: "1d", immutable: true }));

// ==== ENV ====
const PORT = (process.env.PORT || 8080);
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim(); // (선택) 이미지/블로그 모듈에서 사용
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || "").trim();        // (권장) API 보호용
const MAKE_API_BASE = (process.env.MAKE_API_BASE || "https://us2.make.com/api/v2").trim();
const MAKE_TOKEN = ((process.env.MAKE_TOKEN || process.env.MAKE_API_KEY || "")).trim(); // 호환성
const MAKE_TEAM_ID = (process.env.MAKE_TEAM_ID || "").trim();

// ==== OpenAI 클라이언트 ====
const openai = axios.create({
  baseURL: "https://api.openai.com/v1",
  headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
  timeout: 60000 // 60s
});

// ==== 유틸 ====
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
      // 정책/인증/모델 파라미터류는 재시도 무의미 → 즉시 중단
      if (status === 401 || status === 403 || (status === 400 && /invalid|model|param/i.test(typ))) throw e;
      await sleep(baseDelay * Math.pow(2, i)); // 백오프
    }
  }
  throw lastErr;
}

// 이미지 생성 (gpt-image-1): url → b64→파일 저장, 1024 실패시 512
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

// 블로그 글 작성 (gpt-4o-mini)
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

// === 공개 라우트: 헬스 ===
app.get("/health", (_req, res) => ok(res, { ts: new Date().toISOString() }));

// === 디버그: 현재 빌드/라우트 스냅샷 ===
app.get("/__whoami", (_req, res) => {
  res.json({
    ok: true,
    tag: "whoami",
    ts: new Date().toISOString(),
    env: {
      has_OPENAI_API_KEY: !!OPENAI_API_KEY,
      has_ADMIN_TOKEN: !!ADMIN_TOKEN,
      MAKE_API_BASE,
      has_MAKE_TOKEN: !!MAKE_TOKEN,
      MAKE_TEAM_ID
    },
    routes: ["/health", "/__whoami", "/files/*", "/housekeep", "/run", "/make/ping", "/make/deploy", "/make/run"]
  });
});

// === Admin Token 보호 (헬스/디버그 제외 전부 보호 권장) ===
app.use((req, res, next) => {
  if (req.path === "/health" || req.path === "/__whoami") return next();
  if (!ADMIN_TOKEN) return next(); // 토큰 미설정 시 보호 비활성
  const got = req.headers["x-admin-token"];
  if (got === ADMIN_TOKEN) return next();
  return res.status(401).json({ ok: false, error: "unauthorized" });
});

// === Make API 클라이언트 ===
const make = axios.create({
  baseURL: MAKE_API_BASE,
  headers: { Authorization: `Token ${MAKE_TOKEN}`, "Content-Type": "application/json" },
  timeout: 15000
});

// === Make 라우트 ===
// 연결 확인 (teamId 필수)
app.get("/make/ping", async (_req, res) => {
  try {
    if (!MAKE_TOKEN) return res.status(400).json({ ok: false, error: "missing_MAKE_TOKEN" });
    if (!MAKE_TEAM_ID) return res.status(400).json({ ok: false, error: "missing_MAKE_TEAM_ID" });
    const r = await make.get(`/scenarios`, {
      params: { limit: 1, teamId: MAKE_TEAM_ID }
    });
    res.json({ ok: true, sample: r.data });
  } catch (e) {
    res.status(500).json({ ok: false, detail: e?.response?.data || e.message });
  }
});

// 배포: 비활성화 → 블루프린트 PUT → 활성화 (teamId 포함)
app.post("/make/deploy", async (req, res) => {
  try {
    const { scenarioId, blueprint } = req.body || {};
    if (!MAKE_TOKEN) return res.status(400).json({ ok: false, error: "missing_MAKE_TOKEN" });
    if (!MAKE_TEAM_ID) return res.status(400).json({ ok: false, error: "missing_MAKE_TEAM_ID" });
    if (!scenarioId || !blueprint) return res.status(400).json({ ok: false, error: "need scenarioId & blueprint" });

    await make.post(`/scenarios/${scenarioId}/deactivate`, null, {
      params: { teamId: MAKE_TEAM_ID }
    });

    await make.put(`/scenarios/${scenarioId}/blueprint`, blueprint, {
      headers: { "Content-Type": "application/json" },
      params: { teamId: MAKE_TEAM_ID }
    });

    await make.post(`/scenarios/${scenarioId}/activate`, null, {
      params: { teamId: MAKE_TEAM_ID }
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, detail: e?.response?.data || e.message });
  }
});

// 실행: API 직결(run) (teamId 포함)
app.post("/make/run", async (req, res) => {
  try {
    const { scenarioId } = req.body || {};
    if (!MAKE_TOKEN) return res.status(400).json({ ok: false, error: "missing_MAKE_TOKEN" });
    if (!MAKE_TEAM_ID) return res.status(400).json({ ok: false, error: "missing_MAKE_TEAM_ID" });
    if (!scenarioId) return res.status(400).json({ ok: false, error: "need scenarioId" });

    const r = await make.post(`/scenarios/${scenarioId}/run`, null, {
      params: { teamId: MAKE_TEAM_ID }
    });
    res.json({ ok: true, result: r.data || true });
  } catch (e) {
    res.status(500).json({ ok: false, detail: e?.response?.data || e.message });
  }
});

// === 임시 파일 정리(24h 지난 PNG 삭제) — 필요시 스케줄러에서 호출
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
 * /run
 * {
 *   "plan": { "action":"auto_execute", "modules":[
 *     { "type":"generate_image", "prompt":"차분한 색감의 쇼핑 블로그용 일러스트 배경", "size":"1024x1024" },
 *     { "type":"write_blog", "topic":"쿠팡 신상품 3개 리뷰 작성" }
 *   ]}
 * }
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

// 전역 안전망: 프로세스 크래시 방지(연결 끊김 예방)
process.on("unhandledRejection", (r) => console.error("UnhandledRejection:", r));
process.on("uncaughtException", (e) => console.error("UncaughtException:", e));

// 서버 실행
app.listen(PORT, () => console.log(`orchestrator running on :${PORT}`));
