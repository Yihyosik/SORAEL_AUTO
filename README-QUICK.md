# Sorael Minimal Server (Render)

## 1) Render 배포
- 3개 파일(package.json, index.js, README-QUICK.md)을 깃허브 리포에 올림
- Render → New Web Service → 리포 연결 → 빌드·시작

## 2) 환경변수
- OPENAI_API_KEY: 필수
- MAKE_API_KEY: 선택(드라이런이면 없어도 됨)
- TELEGRAM_BOT_TOKEN: 텔레그램 연동 시 필수

## 3) 헬스 체크
GET https://<도메인>/health → { ok: true }

## 4) 텔레그램 웹훅 설정
https://api.telegram.org/bot<텔레그램_토큰>/setWebhook?url=https://<도메인>/telegram/webhook

## 5) 사용
- 텔레그램 봇에 명령 입력 → /build→/deploy 실행 후 결과 회신
- POST /chat { "message": "...", "dryRun": true }

## 6) Make 실연동
- /deploy 함수 안 TODO에 Make API 호출 추가
