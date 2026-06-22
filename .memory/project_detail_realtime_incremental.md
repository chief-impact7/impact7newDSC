---
name: project_detail_realtime_incremental
description: 우측 상세패널 realtime 증분 렌더링·탭별 가드 설계 + 내신기간 정규카드 숨김 + shared 내신 predicate drift 후속
metadata:
  type: project
---

# 상세패널 realtime 증분 렌더링 + 내신 카드 숨김 (2026-06-22)

## 증분 렌더링 (우측 상세패널 깜빡임 해소)
`renderStudentDetail(studentId, { incremental })` — `_realtimeRefreshUI`(data-layer.js)만 `incremental:true`로 호출.
- `detail-cards`는 표준상세 외에 **naesin·class-detail·diagnostic·hw-management·past-history가 공유**하는 단일 컨테이너다. 그래서 단순 "HTML 같으면 skip"은 다른 화면이 점유했을 때 stale 위험.
- 가드: `incremental && !studentChanged && _lastCardsHtml === cardsHtml && !isWithdrawn && detail-cards에 #student-status-mount[data-student-id="이 학생"] 마커 존재` → 모두 참일 때만 innerHTML 교체·AI 비동기 마운트·fillTenure·expanded복원을 skip. 마커는 표준 카드에만 있어 타 렌더러 점유를 가려낸다.
- `_lastCardsHtml`(모듈변수)은 교체 시에만 갱신. 같은 학생 동일성은 `studentChanged`가 담당(cardsHtml에 studentId 중복 인코딩 불필요 — 리뷰 반영).

## realtime 탭별 가드 (열어둔 탭 보존 + stale 없음)
다른 교사의 무관한 쓰기가 와도 **열어둔 비-daily 탭(기록/상담/성적/메시지)이 재생성되지 않게** 한다:
- docu·score: realtime 재렌더에 `!incremental` 가드 추가(매번 재호출하던 것 차단). consultation·message·report는 기존 `studentChanged` 가드로 이미 보존.
- daily 카드 + 프로필 헤더(이름/배지/연락처/재원현황)는 항상 최신화 → 탭 복귀 시 stale 없음.
- ⚠️ **하지마라**: `_realtimeRefreshUI`를 `detailTab==='daily'`로 게이트하는 방식(초기 시도). 비-daily 탭 동안 들어온 daily 변경이 `switchDetailTab('daily')`(display만 토글, 재렌더 X) 복귀 시 stale로 남는 회귀를 만든다. 증분+탭별 가드가 올바른 해법.

## 내신기간 정규 학습관리 카드 숨김
`isNaesinActive = _isNaesinActiveAt(student, date)` 이면 정규반 카드 숨김 → 내신 종료(정규 복귀) 시 자동 재표시.
- `showStudyCards = isAttended && !isNaesinActive` → 영역별숙제·테스트현황·숙제미통과·테스트미통과
- 다음숙제(nextHwHtml)는 출석 무관이라 `isNaesinActive || uniqueClasses.length===0`로 별도 게이트

## 내신 active 판정 — shared SSoT 통합 완료 (shared v1.31.0, 2026-06-22)
3겹(`_isNaesinActiveAt`·`isNaesinActiveToday`·`applyNaesinFreeDerivation` 내부 판정)을 shared `isNaesinActiveAt`로 일원화. shared `deriveActiveNaesinEnrollment`(applyNaesinFreeDerivation과 SSoT 공유)를 boolean으로 노출. DSC `isNaesinActiveToday`는 얇은 래퍼(활성필터+주입), `_isNaesinActiveAt`는 제거. 통합으로 '내신 라벨'과 '파생 등원일정'이 항상 동일 판정. DB는 boolean predicate 미사용(applyNaesinFreeDerivation만 사용), HR/exam은 내신 무관. 상세: [[reference_naesin_active_shared]]
