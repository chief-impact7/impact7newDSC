---
name: 데이터 정합성 검증 패턴 — outlier 발견
description: 일괄 작업의 단일 누락 학생을 빠르게 찾는 방법. 비슷한 위치 학생들과 비교.
type: feedback
---

# Outlier 검출 패턴

사용자가 "다른 학생들은 잘 들어가있는데 X만 이상하다"고 보고하면 → **같은 csKey/반에 매핑된 다른 학생들과 X의 데이터 구조를 한 줄씩 비교**.

## 사례 (2026-05-19)
이하윤2가 진명여고1B 카드 표시가 다른 학생과 달랐음. compare 스크립트로 진명여고1B 전체 학생 5명의 enrollments 한 줄씩 dump:
- 다른 4명: 정규 #0에 `naesin_class_override='2단지진명여고1B'` ✅ + 명시적 내신 #1 ✅ + end_date 채워짐 ✅
- 이하윤2: override 없음 ❌ + 정규(빈코드) #1 ❌ + end_date 없음 ❌

즉 5월 일괄 정정 작업 3단계 모두에서 누락된 케이스.

## Why
silent drift는 한 케이스만 보면 안 보임. 같은 그룹의 다른 멤버와 비교해야 형식 불일치가 드러남. UI 표시 차이("2단지진명여고1B"가 학생 카드에 그대로 노출)가 첫 단서.

## How to apply
- 사용자가 "한 명만 이상함" 보고 시: `scripts/oneoff/compare-X-vs-Y.mjs` 같은 패턴 즉시 작성
- 같은 csKey · 같은 반 · 같은 학교+학년 멤버 전체 dump
- enrollments 구조의 각 필드(class_type, override, end_date, day, time) 한 줄씩 표시
- "정상 다수 + 이상 1명" 패턴 → 일괄 작업 누락 의심
- 그 다음 history_logs로 누락 작업 추적 가능
