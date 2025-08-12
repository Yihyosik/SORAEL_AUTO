// ===== 기존 "한 번의 PATCH" 블록 삭제하고 아래로 교체 =====
const ts = new Date().toISOString().replace(/[:.]/g, "-");
const newName = `AutoScenario ${MAKE_SCENARIO_ID} ${ts}`;

// 1) 현 블루프린트 상태 GET (래퍼 유무 모두 대응)
const g = await axios.get(`${MAKE_API_BASE}/scenarios/${MAKE_SCENARIO_ID}/blueprint`, { headers });
const resp = g.data?.response || g.data || {};
let currentBlueprint = resp.blueprint || resp?.scenario?.blueprint || {};
let currentScheduling = resp.scheduling || { type: "indefinitely", interval: 900 };

// 2) build 결과(bp)가 있으면 flow만 교체(필수 키 유지). 문자열 금지!
let bp = item.make_blueprint;
if (bp && typeof bp === "object" && bp.response?.blueprint) bp = bp.response.blueprint;
if (typeof bp === "string") { try { bp = JSON.parse(bp); } catch { bp = null; } }
if (bp && Array.isArray(bp.flow)) {
  currentBlueprint = { ...currentBlueprint, flow: bp.flow }; // 핵심: flow만 바꿔치기
}
// 안전 스탬프(선택)
currentBlueprint.__meta = { by: "api-sorael", at: new Date().toISOString() };

// 3) 블루프린트 전용 PUT (객체 그대로, 문자열 금지)
await axios.put(
  `${MAKE_API_BASE}/scenarios/${MAKE_SCENARIO_ID}/blueprint?confirmed=true`,
  { blueprint: currentBlueprint, scheduling: currentScheduling },
  { headers: { ...headers, "Content-Type": "application/json" } }
);
note += "blueprint_put_ok; ";

// 4) 이름만 별도 PATCH (여긴 /scenarios/{id})
await axios.patch(
  `${MAKE_API_BASE}/scenarios/${MAKE_SCENARIO_ID}`,
  { name: newName },
  { headers }
);
note += "name_patch_ok; ";

// 5) start (이미 실행중이면 스킵)
try {
  await axios.post(`${MAKE_API_BASE}/scenarios/${MAKE_SCENARIO_ID}/start`, {}, { headers });
  note += "start_ok; ";
} catch (e) {
  const code = e?.response?.data?.code;
  if (code === "IM306") note += "start_skipped_already_running; ";
  else throw e;
}

// 6) 확인
const after = await axios.get(`${MAKE_API_BASE}/scenarios/${MAKE_SCENARIO_ID}`, { headers });
if ((after.data?.scenario?.name || "").includes(ts)) applied = true;
scenarioId = MAKE_SCENARIO_ID;
