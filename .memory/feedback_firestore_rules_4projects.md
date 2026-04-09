---
name: Firestore rules는 4개 프로젝트에 동기화
description: firestore.rules 변경 시 DB, DSC, HR, exam 4개 프로젝트 모두 동기화 필요
type: feedback
---

firestore.rules 수정 시 반드시 **4개 프로젝트** 모두에 복사해야 함:
- impact7DB (배포는 여기서)
- impact7newDSC
- impact7HR
- impact7exam

**Why:** 동일한 Firebase 프로젝트(impact7db)를 공유하므로 rules가 일치해야 함. impact7exam을 빠뜨린 적 있음.
**How to apply:** rules 변경 → 4곳 cp → impact7DB에서 `firebase deploy --only firestore:rules`
