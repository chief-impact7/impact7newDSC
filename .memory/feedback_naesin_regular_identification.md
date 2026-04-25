---
name: 정규 enrollment 식별 시 화이트리스트 사용
description: 정규 enrollment를 찾을 때 `class_type !== '내신'` 같은 블랙리스트 패턴 금지. `(정규 || 자유학기)` 화이트리스트만 사용.
type: feedback
---

정규 enrollment를 식별할 때는 반드시 화이트리스트 방식으로 한다:

```js
// ❌ 금지 — 특강·미래에 추가될 새 class_type까지 통과시킴
const reg = enrollments.find(e => e.class_type !== '내신' && e.class_number);

// ✅ 사용
const reg = enrollments.find(
    e => (e.class_type === '정규' || e.class_type === '자유학기') && e.class_number
);
```

**Why:** 2026-04-26 오소윤(염경중1) 사고. enrollments 인덱스 0번에 "토요특강"(class_type='특강', class_number='토요특강')이 있어서 옛 패턴이 특강을 정규로 오인 → `resolveNaesinCsKey`가 잘못된 csKey 계산 → 내신 화면/등원요일/반설정에서 학생 누락. 사용자 도메인 규칙상 "특강과 내신은 서로 영향 주면 안 됨"이지만 코드가 이를 위반.

**How to apply:**
- `student-helpers.js`, `naesin.js`, `daily-ops.js` 등 정규 enrollment를 `find`/`findIndex`/`some`으로 찾는 모든 위치에 적용
- 새로운 class_type이 도입되면 명시적으로 화이트리스트 갱신
- 비슷한 검색이 필요한 다른 도메인(자유학기 식별, 내신 식별 등)도 화이트리스트 우선
- 수정 이력: 67c92d0 (8개 위치 일괄 교체)
