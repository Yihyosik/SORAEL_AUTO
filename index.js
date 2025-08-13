// index.js — RTA 자동화 서버 v1.6 (OpenAI 에러 메시지 출력 추가)
import express from "express";
import axios from "axios";

const app = express();
app.use(express.json({ limit: "2mb" }));

const vault = new Map();

app.post("/vault", (req, res) => {
  const { service, key } = req.body || {};
  if (!service || !key) return res.status(400).json({ error: "service & key required" });
  vault.set(service, key);
  res.json({ ok: true, stored: service });
});

app.post("/build", async (req, res) => {
  const { prompt = "", dryRun = true } = req.body || {};
  if (!prompt) return res.status(400).json({ error: "prompt required" });

  const plan = {
    action: "auto_execute",
    modules: [
      { type: "generate_image", prompt },
      { type: "write_blog", topic: prompt }
    ]
  };

  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  res.json({ runId, dryRun, plan });
});

const modules = {
  generate_image: async ({ prompt }) => {
    const key = vault.get("openai");
    if (!key) return { error: "missing OpenAI key" };
    const cleanPrompt = decodeURIComponent(encodeURIComponent(prompt));
    try {
      const response = await axios.post("https://api.openai.com/v1/images/generations", {
        model: "dall-e-3",
        prompt: cleanPrompt,
        n: 1,
        size: "1024x1024"
      }, {
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json"
        }
      });
      const url = response.data.data?.[0]?.url;
      return { url, summary: `DALL·E 이미지 생성`, preview: url };
    } catch (e) {
      const msg = e?.response?.data?.error?.message || e.message;
      console.error("🔥 OpenAI IMAGE ERROR:", msg);
      return { error: msg };
    }
  },

  write_blog: async ({ topic }) => {
    const key = vault.get("openai");
    if (!key) return { error: "missing OpenAI key" };
    try {
      const response = await axios.post("https://api.openai.com/v1/chat/completions", {
        model: "gpt-3.5-turbo",
        messages: [
          { role: "system", content: "당신은 블로그 작가입니다." },
          { role: "user", content: `${topic}에 대해 600자 분량으로 블로그 포스트를 써줘.` }
        ]
      }, {
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json"
        }
      });
      const content = response.data.choices?.[0]?.message?.content || "";
      return { title: `블로그: ${topic}`, content, summary: `GPT로 블로그 작성 완료` };
    } catch (e) {
      const msg = e?.response?.data?.error?.message || e.message;
      console.error("🔥 OpenAI TEXT ERROR:", msg);
      return { error: msg };
    }
  }
};

app.post("/run", async (req, res) => {
  try {
    const { plan = {} } = req.body || {};
    const { modules: steps = [] } = plan;

    const results = [];
    for (const step of steps) {
      const { type, ...args } = step;
      const mod = modules[type];
      if (!mod) return res.status(400).json({ error: `unknown module: ${type}` });
      const output = await mod(args);
      results.push({ type, ...output });
    }

    res.json({ ok: true, results });
  } catch (e) {
    console.error("🔥 RUNTIME ERROR:", e);
    res.status(500).json({ error: "run_failed", detail: e.message });
  }
});

app.get("/", (_req, res) => {
  res.send("✅ RTA 기반 소라엘 자동화 서버 작동 중 — OpenAI 에러 메시지 출력됨");
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Server running on :${PORT}`));
