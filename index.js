// index.js — 자체 오케스트레이션: /run (generate_image → write_blog)
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "2mb" }));

// ==== ENV ====
const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ""; // 반드시 설정

// ==== OpenAI 클라이언트 ====
const openai = axios.create({
  baseURL: "https://api.openai.com/v1",
  headers: {
    Authorization: `Bearer ${OPENAI_API_KEY}`,
    "Content-Type": "application/json"
  },
});

// ==== 유틸 ====
const ok = (res, data) => res.json({ ok: true, ...data });
const err = (res, code, detail) => res.status(code).json({ ok: false, error: "run_failed", detail });

// ==== 이미지 생성 (gpt-image-1): url 또는 b64_json 모두 수용 ====
async function generateImage(prompt, size = "1024x1024") {
  const resp = await openai.post("/images/generations", {
    model: "gpt-image-1",
    prompt,
    size
    // response_format는 보내지 않음 (엔드포인트에 따라 거부됨)
  });
  const payload = resp?.data;

  // 1) URL 우선
  const url = payload?.data?.[0]?.url;
  if (url) return url;

  // 2) b64_json 응답이면 data URL로 변환
  const b64 = payload?.data?.[0]?.b64_json;
  if (b64) return `data:image/png;base64,${b64}`;

  // 3) 둘 다 없으면 원문 리턴해서 오류 맥락 보이게
  throw new Error(`이미지 생성 응답에 url/b64가 없습니다: ${JSON.stringify(payload)}`);
}

// ==== 블로그 글 작성 (gpt-4o-mini) ====
async function writeBlog(topic, imageUrl) {
  const resp = await openai.post("/chat/completions", {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "너는 간결하고 읽기 쉬운 한국어 블로그 글을 작성하는 어시스턴트다." },
      {
        role: "user",
        content:
          `다음 주제로 800~1000자 리뷰 글 작성.\n` +
          `- 주제: ${topic}\n` +
          (imageUrl ? `- 본문에 아래 이미지 URL 1회 삽입: ${imageUrl}\n` : "") +
          `- 구성: 한 문단 요약 → 제품 3개 핵심 포인트(불릿) → 간단 비교표(텍스트) → 마무리 추천\n` +
          `- 어투: 담백, 과장 금지, 표기는 마크다운`
      }
    ],
    temperature: 0.7
  });

  const text = resp?.data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("블로그 본문 생성 실패");
  return text;
}

// ==== ROUTES ====
app.get("/health", (_req, res) => ok(res, { ts: new Date().toISOString() }));

/**
 * /run
 * body 예시:
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

    const results = [];
    const context = {};

    for (const mod of plan.modules) {
      const t = mod?.type;

      if (t === "generate_image") {
        const prompt = mod.prompt || "부드러운 그래디언트 배경, 일러스트 스타일";
        const size = mod.size || "1024x1024";
        const imageUrl = await generateImage(prompt, size);
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
