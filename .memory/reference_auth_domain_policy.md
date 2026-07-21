# 인증 도메인 정책 — @impact7.kr 단일

- `@gw.impact7.kr`은 초기 계정 도메인. 이후 전 계정 `@impact7.kr`로 이관 완료 (사용자 확인 2026-07-22).
- 정본(SSoT): firestore.rules `isAuthorized()` — `@impact7.kr`만 허용. 시스템이 정상 동작 = 활성 로그인 전부 impact7.kr이라는 증거.
- 잔재(legacy 허용, 정리 후보): DSC storage.rules:8, DSC 로그인 게이트 6곳(app.js:606, excel.js:134, checkin.js:217, class-setup.js:67, src/dashboard/App.jsx:133, src/messages/App.jsx:21) + help-guide.js 문구, impact7DB app.js, impact7HR src/lib/firebase/auth.ts.
- 주의: Firestore **데이터**의 teacher 필드에는 `edward@gw.impact7.kr` 같은 옛 주소가 값으로 남아 있음 — staff-label 등 표시 로직은 gw 도메인 파싱을 유지해야 한다. 인증 게이트 정리와 별개.
