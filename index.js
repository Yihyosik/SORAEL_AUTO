// index.js — 자체 오케스트레이션(안정판)
// - 이미지: url 있으면 그대로 사용
// - url 없고 b64만 오면 서버에 파일 저장 → 짧은 URL 응답
// - Axios 타임아웃/에러 처리 강화
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({ limit: "2mb" }));

// 정적 파일 제공 디렉토리 (생성)
const FILE_DIR = path.join(process.cwd(), "files");
if (!fs.existsSync(FILE_DIR)) fs.mkdirSync(FILE_DIR, { recursive: true });
app.use("/files", express.static(FILE_DIR, { maxAge: "1d", immutable: true }));

// ==== ENV ====
const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ""; // 필수

// ==== OpenAI 클라이언트 (타임아웃/재시도 최소화) ====
const openai = axios.create({
  baseURL: "https://api.openai.com/v1",
  headers: {
    Authorization: `Bearer ${OPENAI_API_KEY}`,
    "Content-Type": "application/json"
  },
  timeout: 120000, // 120s
});

// ==== 유틸 ====
const ok = (res, data) => res.json({ ok: true, ...data });
const err = (res, code, detail) => res.status(code).json({ ok: false, error: "run_failed", detail });
const makeId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ==== 이미지 생성 (gpt-image-1): url 우선, b64면 파일로 저장 후 URL 반환 ====
async function generateImage(prompt, size, baseUrl) {
  const { data: payload } = await openai.post("/images/generations", {
    model: "gpt-image-1",
    prompt,
    size
    // response_format는 보내지 않음 (엔드포인트에 따라 거부될 수 있음)
  });

  // 1) URL 우선
  const url = payload?.data?.[0]?.url;
  if (url) return url;

  // 2) b64_json → 로컬 파일로 저장 후 /files URL 반환(응답을 작게 유지)
  const b64 = payload?.data?.[0]?.b64_json;
  if (b64) {
    const id = makeId();
    const filePath = path.join(FILE_DIR, `${id}.png`);
    fs.writeFileSync(filePath, Buffer.from(b64, "base64"));
    return `${baseUrl}/files/${id}.png`;
  }

  // 3) 둘 다 없으면 원문 포함해 명확히 실패
  throw new Error(`이미지 응답에 url/b64 없음: ${JSON.stringify(payload)}`);
}

// ==== 블로그 글 작성 (gpt-4o-mini) ====
async function writeBlog(topic, imageUrl) {
  const { data } = await openai.post("/chat/completions", {
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
    temperature: 0.7
  });
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("블로그 본문 생성 실패");
  return text;
}

// ==== ROUTES ====
app.get("/health", (_req, res) => ok(res, { ts: new Date().toISOString() }));

/**
 * /run
 * body:
 * {
 *   "plan": {
 *     "action": "auto_execute",
 *     "modules": [
 *       { "type": "generate_image", "prompt": "차분한 색감의 쇼핑 블로그용 일러스트 배경", "size": "1024x1024" },
 *       { "type": "write_blog", "topic": "쿠팡 신상품 3개 리뷰 작성" }
 *     ]
 *   }
 * }
 */
app.post("/run", async (req, res) => {
  try {
    if (!OPENAI_API_KEY) return res.status(400).json({ ok: false, error: "missing_OPENAI_API_KEY" });

    const plan = req.body?.plan;
    if (!plan || !Array.isArray(plan.modules)) {
      return res.status(400).json({ ok: false, error: "invalid_plan" });
    }

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const results = [];
    const context = {};

    for (const mod of plan.modules) {
      const t = mod?.type;

      if (t === "generate_image") {
        const prompt = mod.prompt || "부드러운 그래디언트 배경, 일러스트 스타일";
        const size = mod.size || "1024x1024";
        const imageUrl = await generateImage(prompt, size, baseUrl);
        context.image_url = imageUrl;
        results.push({ type: t, ok: true, image_url: imageUrl });
      }

      else if (t === "write_blog") {
        const topic = mod.topic || "신상품 3개 리뷰 작성";
        const blog = await writeBlog(topic, context.image_url);
        context.blog_post = blog;
        results.push({ type: t, ok: true, blog_post: blog });
      }

      else {
        results.push({ type: t || "unknown", ok: false, error: "unknown_module" });
      }
    }

    return ok(res, { results, context });
  } catch (e) {
    const detail = e?.response?.data || e?.message || String(e);
    return err(res, 500, detail);
  }
});

app.listen(PORT, () => console.log(`orchestrator running on :${PORT}`));
