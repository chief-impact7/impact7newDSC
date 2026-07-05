---
name: feedback-formal-review-over-equivalent
description: 소스 변경 커밋은 정식 /simplify→/code-review 필수 — equivalent(직접 점검)는 Critical 버그를 놓친다
metadata:
  type: feedback
---

소스 코드(.js·.svelte·.tsx 등) 변경이 포함된 커밋은 commit 전에 **정식 `/simplify` →
`/code-review`를 실제로 실행**하라. "직접 diff 점검(equivalent review)"으로 대체하지 말 것.
CSS 토큰 값 변경도 시각/접근성 영향이 있으면 code-review 대상으로 본다.

**Why:** 2026-06-28 에코시스템 a11y 전파 때, DSC만 정식 스킬을 돌리고 DB/HR/exam은
equivalent review(diff 로직변경 grep + 직접 점검)로 대체했다. 사용자 지적으로 사후에
정식 code-review를 돌리자 **equivalent가 놓친 실 버그 2건**이 잡혔다:
- DB: Esc 핸들러가 `modal.style.display='none'` 직접 할당 → `closeXxxModal` cleanup 우회.
  특히 prompt-modal `_resolve(null)` 미호출로 `promptModal()` Promise **영구 pending**(Critical).
- HR: ConfirmModal 정적 `id="confirm-modal-title"`이 한 페이지 2개 인스턴스에서 중복 →
  스크린리더가 잘못된 제목을 읽음.
둘 다 "속성 추가뿐이라 안전"이라는 내 판단을 빠져나갔다. 멀티앵글 정식 리뷰만 잡았다.

**How to apply:** 병렬로 여러 앱/큰 변경을 수정했더라도, 각 커밋 전 정식 리뷰를 생략하지
말 것. hook이 "equivalent independent review"를 허용해도, equivalent의 기준은 "직접 grep"이
아니라 멀티앵글 수준이어야 한다. 확신 없으면 정식 스킬을 돌려라. [[project_a11y_shared_snippet_2026-06-28]]
