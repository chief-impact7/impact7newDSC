---
name: reference_naesin_active_shared
description: 내신기간 active 판정은 shared isNaesinActiveAt SSoT 사용 — 로컬 재구현 금지
metadata:
  type: reference
---

# 내신 active 판정 = `@impact7/shared/enrollment-derivation` `isNaesinActiveAt` (shared v1.31.0+)

내신기간 활성 여부 boolean 판정은 **로컬 재구현 금지**. shared SSoT를 쓴다.

```js
import { isNaesinActiveAt } from '@impact7/shared/enrollment-derivation';
// current = 날짜 필터(미시작·종료 제외)한 활성 enrollment 배열
isNaesinActiveAt(current, { classSettings, dateStr, resolveNaesinCsKey });
```
- `isNaesinActiveAt` = `!!deriveActiveNaesinEnrollment(...)` — **applyNaesinFreeDerivation(파생 등원일정)과 동일 함수**를 공유하므로 '내신 라벨'과 '등원일정'이 절대 어긋나지 않는다.
- 각 앱이 `classSettings`·`resolveNaesinCsKey`를 주입(앱별 환경 의존). DSC는 `state.classSettings` + `student-core.resolveNaesinCsKey`.
- DSC 래퍼: `student-helpers.isNaesinActiveToday(s, dateStr)` (활성필터 후 predicate 호출). 직접 `isNaesinActiveAt`를 부르지 말고 이 래퍼 사용.

## 배경 (왜 통합했나)
과거 DSC가 `_isNaesinActiveAt`(naesin_class_override 직접 csKey)·`isNaesinActiveToday`(resolveNaesinCsKey 경유) 두 벌로 재구현 → override 해석 drift. shared로 통합(커밋 shared `9758978` v1.31.0, DSC `1d6f3bb`). DB는 `applyNaesinFreeDerivation`만 사용(boolean predicate 없음), HR/exam은 내신 무관 — 변경 불필요했음. shared 공개 API 정본: `impact7-shared/AGENTS.md`.
