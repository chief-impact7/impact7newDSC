---
name: project_app_check_rollout
description: App Check 도입 보류(사용자 결정 2026-07-05) — DSC init 제거됨, 재제안 금지, SSoT는 impact7DB 메모
metadata:
  type: project
---

# App Check — 도입 보류 (사용자 결정 2026-07-05)

2026-06-22 DSC에 미강제 부착(b92b09a)했던 App Check init을 **2026-07-05 제거**(커밋 3d9dbb2).
reCAPTCHA Enterprise 스크립트 로드가 초기 반응속도를 체감되게 깎는데, 서버 callable이 전부
`enforceAppCheck: false`라 보안 이득이 0이기 때문. 같은 날 DB·HR·tablet의 init도 함께 제거 — **5개 앱 전부 init 없음**.

- `firebase-config.js`에 보류 사유 주석 있음. **AI/에이전트는 도입을 재제안하지 말 것 — 사용자가 먼저 요청할 때만.**
- 2026-07-05 재검토(세션 정리 중): API 대상 제한 26개 + rules 역할 기반 write + callable request.auth·rate limit이
  이미 배포돼 있어 App Check는 필수 아닌 심층 방어로 판정, 보류 유지.
- 재개 시 로드맵·enforce 전환 순서·도메인 함정의 SSoT: `impact7DB/.memory/project_appcheck_rollout.md`
- named app 분리 맥락은 [[reference_firebase_named_app_persistence]].
