# 정규 enrollment는 end_date를 갖지 않는다 (88f639f, 2026-06-15)

## 정책
정규(class_type='정규') enrollment에 **end_date를 박으면 안 된다**. 정규 종료는 status(퇴원/종강)로만 표현한다.
내신·자유학기·특강은 기간제라 end_date 정상.

## 왜
정규에 end_date를 박으면, 그날 이후 getActiveEnrollments에서 빠져 **유령 정규**가 된다.
특히 내신 override가 걸린 정규가 죽으면 내신 종료 후 정규 복귀 시 갈 곳이 없다 (이예원 유령 사고 패턴).

## 출처였던 코드 (모두 수정됨)
- `class-setup.js` submitWizard 정규 분기: '옛 정규 강제종료(end_date=새 start−1)+새 정규 push' → **in-place 반 변경**(기존 활성 정규의 코드·요일·시작일만 교체, override/semester 보존). 옛 정규 없으면 추가.
- `modals.js` saveEnrollment: 정규는 end_date 저장 무시. openEnrollmentModal: 정규 선택 시 종료일 칸 disable.

## 반 변경은 in-place
정규 반 변경은 옛것 닫고 새것 추가가 아니라 **in-place 갱신**(shared `class-move.js` moveClass와 동일 철학). 정규는 항상 1개 유지.

## 정리 이력
재원생 정규 end_date 48건 전수 정리 (history_logs RESTORE 기록):
- 김시원·김민찬4: 단독 정규 end_date 제거(부활)
- 44명 46건: 죽은/중복 정규 enrollment 통째 삭제 (override는 전부 활성 정규에 보존 확인)

## 주의 (code-review 잔여)
- **history-classifier 시그니처**: 수업추가 로그는 `'추가:' + '누적'` 토큰 둘 다 필요(@impact7/shared/history-classifier.js:97). 빼면 수업이력에서 숨겨짐. [[feedback_reexport_local_binding]]류 드리프트 주의.
- in-place 교체가 naesin_class_override를 보존하므로, **분원/그룹 교차 반변경** 시 override의 csKey(branch+school+grade+group)가 새 반과 안 맞을 수 있음 — 필요 시 교차 변경 감지해 override clear 가드 추가 검토.
