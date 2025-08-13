// index.js — 자체 오케스트레이션 안정판
// - generate_image: url → fallback b64→file, 60s timeout, 2회 재시도, 1024 실패 시 512 재시도
// - write_blog: 안정 파라미터
// - 모든 에러는 JSON으로 반환해 연결 끊김 방지
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({ limit: "1mb" })); // 입력은 작게 제한(안정성)

// 정적 파일 서빙 (b64를 파일로 저장해서 짧은 URL만 응답)
const FILE_DIR = path.join(process.cwd(), "files");
if (!fs.existsSync(FILE_DIR)) fs.mkdirSync(FILE_DIR, { recursive: true });
app.use("/files", express.static(FILE_DIR, { maxAge: "1d", immutable: true }));

// ==== ENV ====
const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ""; // 필수

// ==== OpenAI 클라이언트 ====
const openai = axios.create({
  baseURL: "https://api.openai.com/v1",
  headers: {
    Authorization: `Bearer ${OPENAI_API_KEY}`,
    "Content-Type": "application/json"
  },
  timeout: 60000 // 60s
});

// ==== 공통 유틸 ====
const ok = (res, data) => res.json({ ok: true, ...data });
const err = (res, code, detail) => res.status(code).json({ ok: false, error: "run_failed", detail });
const id = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function withRetry(fn, { tries = 3, baseDelay = 600 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(i); }
    catch (e) {
      lastErr = e;
      // 정책/인증류는 재시도해도 의미 없음 → 바로 throw
      const code = e?.response?.status;
      const t = e?.response?.data?.error?.type || e?.code;
      if (code === 401 || code === 403 || code === 400 && /invalid|model|param/i.test(t || "")) throw e;
      // 백오프
      await sleep(baseDelay * Math.pow(2, i));
    }
  }
  throw lastErr;
}

// ==== 이미지 생성 (gpt-image-1) ====
// 흐름: 1024 시도 → 실패/타임아웃이면 512로 다운스케일 재시도
async function generateImageStable(prompt, sizeWanted, baseUrl) {
  const sizes = [sizeWanted || "1024x1024", "512x512"]; // 자동 대체
  let lastError;
  for (const s of sizes) {
    try {
      const payload = await withRetry(async (attempt) => {
        const { data } = await openai.post("/images/generations", {
          model: "gpt-image-1",
          prompt,
          size: s
          // response_format은 지정 안 함 (일부 테넌트에서 거부됨)
        });
        return data;
      }, { tries: 2, baseDelay: 800 });

      // URL 우선
      const u = payload?.data?.[0]?.url;
      if (u) return u;

      // b64 → 파일 저장
      const b64 = payload?.data?.[0]?.b64_json;
      if (b64) {
        const filename = `${id()}.png`;
        fs.writeFileSync(path.join(FILE_DIR, filename), Buffer.from(b64, "base64"));
        return `${baseUrl}/files/${filename}`;
      }

      throw new Error(`이미지 응답에 url/b64 없음(size=${s})`);
    } catch (e) {
      lastError = e;
      // 다음 사이즈로 다운그레이드 시도
    }
  }
  // 두 사이즈 모두 실패
  const detail = lastError?.response?.data || lastError?.message || String(lastError);
  throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
}

// ==== 블로그 글 작성 (gpt-4o-mini) ====
async function writeBlogStable(topic, imageUrl) {
  const { data } = await withRetry(() => openai.post("/chat/completions", {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "너는 간결하고 읽기 쉬운 한국어 블로그 글을 작성하는 어시스턴트다." },
      {
        role: "user",
        content:
`다음 주제로 800~1000자 리뷰 글 작성.
- 주제: ${topic}
${imageUrl ? `- 본문에 아래 이미지 URL 1회 삽입: ${imageUrl}` : ""}
- 구성: 한 문단 요약 → 제품 3개 핵심 포인트(불릿) → 간단 비교표(텍스트) → 마무리 추천
- 어투: 담백, 과장 금지, 표기는 마크다운`
      }
    ],
    temperature: 0.7,
    max_tokens: 800 // 과한 길이 방지(연결 안정)
  }), { tries: 2, baseDelay: 600 });

  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("블로그 본문 생성 실패");
  return text;
}

// ==== 라우트 ====
app.get("/health", (_req, res) => ok(res, { ts: new Date().toISOString() }));

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
      }

      else if (t === "write_blog") {
        const topic = mod.topic || "신상품 3개 리뷰 작성";
        const blog = await writeBlogStable(topic, context.image_url);
        context.blog_post = blog;
        results.push({ type: t, ok: true, blog_post: blog });
      }

      else {
        results.push({ type: t || "unknown", ok: false, error: "unknown_module" });
      }
    }

    return ok(res, { results, context });
  } catch (e) {
    // 어떤 경우에도 JSON 본문으로 실패 이유 반환(연결 끊김 방지)
    const detail = e?.response?.data || e?.message || String(e);
    return err(res, 500, detail);
  }
});

// 전역 에러 핸들링 (프로세스 크래시 방지)
process.on("unhandledRejection", (reason) => console.error("UnhandledRejection:", reason));
process.on("uncaughtException", (err) => console.error("UncaughtException:", err));

app.listen(PORT, () => console.log(`orchestrator running on :${PORT}`));
