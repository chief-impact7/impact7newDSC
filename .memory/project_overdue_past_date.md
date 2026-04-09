---
name: 미완료 과업 과거 날짜에서도 처리 가능하게
description: 미통과 등원 과업이 해당 날짜(과거)에서도 재지정/확인 버튼이 보여야 함
type: project
---

미통과 등원 과업(hw_fail_tasks, test_fail_tasks)이 pending 상태일 때, 오늘 날짜에서만 지연(overdue)으로 표시되는 게 아니라 해당 예정 날짜(과거)에서도 재지정/확인 버튼을 통해 처리할 수 있어야 한다.

**Why:** 현재는 날이 지나야(오늘 날짜 기준) 지연으로 뜨는데, 어제 날짜를 보면서 바로 처리할 수 있어야 자연스러운 흐름임.

**How to apply:** `daily-ops.js`의 `renderScheduledVisitList`에서 과거 날짜 선택 시에도 pending 과업에 재지정/확인 버튼이 보이도록 수정 필요.
