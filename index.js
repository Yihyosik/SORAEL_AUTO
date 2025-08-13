// index.js — RTA 기반 자동화 서버 v1 (소라엘)
import express from "express";
import axios from "axios";

const app = express();
app.use(express.json({ limit: "2mb" }));

// ========== 1. Vault: API 키 저장소 ==========
const vault = new Map();

app.post("/vault", (req, res) => {
  const { service, key } = req.body || {};
  if (!service || !key) return res.status(400).json({ error: "service & key required" });
  vault.set(service, key);
  res.json({ ok: true, stored: service });
});

// ========== 2. Build: 명령 → 설계 JSON ==========
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

// ========== 3. Module: 자동 모듈 등록 (예시) ==========
const modules = {
  generate_image: async ({ prompt }) => {
    return { url: `https://fakeimg.pl/600x400/?text=${encodeURIComponent(prompt)}` };
  },
  write_blog: async ({ topic }) => {
    return { title: `블로그: ${topic}`, content: `${topic}에 대한 자동 생성 포스팅입니다.` };
  }
};

// ========== 4. Run: 실행 엔진 ==========
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
      results.push({ type, output });
    }

    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ error: "run_failed", detail: e.message });
  }
});

// ========== 5. 기본 라우트 ==========
app.get("/", (_req, res) => {
  res.send("✅ RTA 기반 소라엘 자동화 서버 작동 중");
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Server running on :${PORT}`));
