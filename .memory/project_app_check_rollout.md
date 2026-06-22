---
name: project_app_check_rollout
description: App Check 점진 도입 현황 — 현재 DSC만 미강제 부착, enforcement 켜기 전 4앱 부착·콘솔등록 선행 필요
metadata:
  type: project
---

# App Check 점진 도입 (2026-06-22 시작, enforcement 미완)

Firebase App Check(reCAPTCHA Enterprise)를 **순수 가산적·미강제**로 도입 시작. 토큰만 흐르기 시작했고 서버 enforcement는 아직 안 켬.

## 현재 상태 (커밋 b92b09a·merge 984bfdc, push 완료)
- `firebase-config.js`: `dataApp('dsc')`에 `ReCaptchaEnterpriseProvider` 부착. db/functions/storage 호출 주체가 dataApp이라 거기 붙임([DEFAULT] app은 auth 전담이라 토큰 누락).
- site key(공개): `6LcS4ywtAAAAADd8BBiFo_Fd4XXiXT1Uf3gHGxYl`, `isTokenAutoRefreshEnabled: true`.
- `typeof document !== 'undefined'` 가드 — reCAPTCHA Enterprise는 DOM 필요. node:test/vitest 비브라우저 import 크래시 방지.
- localhost/127.0.0.1은 `FIREBASE_APPCHECK_DEBUG_TOKEN = true`(콘솔 출력 토큰을 App Check에 등록해야 로컬 동작).
- 7개 entry 공유 단일 init 모듈이라 전 페이지 커버. named app 분리 맥락은 [[reference_firebase_named_app_persistence]].

## enforcement 켜기 전 선행조건 (나중에 해결 — 순서 주의)
1. **App Check 콘솔 등록 확인**: reCAPTCHA Enterprise 키 등록 + 로컬 디버그 토큰 등록.
2. **production 토큰 발급 실측**: 실 브라우저에서 토큰 발급 확인. App Check 콘솔 메트릭(verified/unverified 비율)을 며칠 모니터링. (b92b09a Not-tested 항목)
3. **⚠️ 공유 프로젝트 함정 (최우선)**: impact7db는 DB·DSC·HR·exam **4개 앱이 공유**([[feedback_firestore_rules_4projects]]). enforcement를 켜면 App Check 미부착 앱의 Firestore/Functions/Storage 요청이 **전부 차단**된다. 현재 부착은 **DSC뿐**. → enforce 켜기 전 **4개 앱 모두 App Check init 부착 완료**가 반드시 선행돼야 한다.
4. verified 비율 충분 확인 후 Firestore → Functions → Storage 순으로 enforcement를 점진 enable(한 번에 다 켜지 말 것).

## 검증된 것
- vite build(7 entry)·npm run test(node 71 + vitest 5) 통과. 클라 런타임 무영향(미강제라 가산적).
