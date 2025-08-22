# Soraiel v1.1.1 — Render 배포용

## 1) 필요한 것
- GitHub 저장소
- Render 계정
- ENV 4개: `ADMIN_TOKEN`, `JWT_SECRET`, `OPENAI_API_KEY`, `RTA_WEBHOOK_SECRET`

## 2) 배포 (GitHub → Render)
1. 이 폴더 그대로 GitHub에 업로드 (`.env`는 올리지 말 것)
2. Render → New → Web Service → GitHub repo 선택
3. Build: `npm ci`  /  Start: `node src/index.js`  /  Health: `/healthz`
4. Environment 탭에 필수 4개 입력
5. Deploy → 로그에 `soraiel v1.1.1 on :8080` 확인

## 3) 바로 테스트
```bash
curl https://<YOUR_RENDER_URL>/healthz

# 계획
curl -sX POST https://<YOUR_RENDER_URL>/orchestrate \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"instruction":"AI 뉴스 3줄 요약"}'

# 실행
curl -sX POST https://<YOUR_RENDER_URL>/execute \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"planId":"<planId>","steps":<steps>}'