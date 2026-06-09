---
name: enrollment-integrity
description: "학생 enrollments[] 배열의 class_type×코드 정합성을 감사하는 하네스. 4개 가드 위치를 정적으로 확인하고, 실제 Firestore 데이터의 위반 건을 탐지하는 스크립트를 생성한다. 2026-05 263건 사고 재발 방지. 'enrollment 검증', 'enrollment 정합성', '등록 데이터 확인', '수강 데이터 검증', 'class_type 오류', 'enrollment 감사', '263건 같은 사고 방지', 'enrollment 일괄 점검', '가드 코드 확인', 'enrollment 위반 탐지' 요청 시 반드시 이 스킬을 사용. 후속: '위반 건 수정', '가드 코드 추가', '스크립트 실행 결과 보고', '다른 class_type 규칙도 확인' 시에도 사용."
---

# Enrollment Integrity Auditor

학생 `enrollments[]` 배열의 class_type × 코드 필드 정합성을 두 가지 축으로 검증한다.
2026-05 263건 사고(class_type 칼럼 누락으로 잘못된 enrollment 대량 생성) 재발 방지가 핵심 목적이다.

## 실행 모드: 서브 에이전트 (파이프라인)

enrollment-validator 에이전트가 정적 감사 + 스크립트 생성을 수행하고,
오케스트레이터가 결과를 종합하여 수정 가이드를 제공한다.

## 에이전트 구성

| 에이전트 | 파일 | 역할 | 출력 |
|---------|------|------|------|
| enrollment-validator | `.claude/agents/enrollment-validator.md` | 정적 가드 감사 + 데이터 감사 스크립트 생성 | `_workspace/enrollment_integrity_report.md` + `scripts/oneoff/check-enrollment-integrity.mjs` |

## 워크플로우

### Phase 0: 컨텍스트 확인

1. `_workspace/enrollment_integrity_report.md` 존재 여부 확인
2. 실행 모드 결정:
   - **미존재** → 초기 실행. Phase 1부터
   - **존재 + "다시 확인" 요청** → Phase 1 재실행 (파일 덮어쓰기)
   - **존재 + "스크립트 실행 결과 보고" 요청** → Phase 3 (결과 해석)으로 바로 이동
   - **"가드 코드만 확인" 요청** → Phase 1 정적 감사만 실행

### Phase 1: enrollment-validator 에이전트 스폰

```
Agent(
  prompt: "enrollment_integrity_report.md와 check-enrollment-integrity.mjs를 생성해줘.
           .claude/agents/enrollment-validator.md의 지침을 따르고,
           결과를 _workspace/enrollment_integrity_report.md에 저장해.",
  subagent_type: "enrollment-validator",  // .claude/agents/enrollment-validator.md 사용
  model: "opus"
)
```

### Phase 2: 결과 취합 및 수정 가이드

`_workspace/enrollment_integrity_report.md`를 읽어:

1. **정적 가드 감사 결과**: 누락 가드가 있으면 구체적 수정 예시 제시
2. **스크립트 안내**: `scripts/oneoff/check-enrollment-integrity.mjs` 실행 방법 안내
   ```bash
   node scripts/oneoff/check-enrollment-integrity.mjs
   ```
3. **발견된 위반 수정**: 위반 건이 있으면 `firestore-data-fix` 스킬로 이어서 복구 가능함을 안내

### Phase 3: 스크립트 실행 결과 해석 (선택적)

사용자가 스크립트 실행 결과를 붙여넣으면:
- 위반 유형별 집계 보고
- 심각도 판단 (건수, class_type 분포)
- 복구 우선순위 제안
- `firestore-data-fix` 스킬로 복구 진행 안내

## 정합성 규칙 (참고)

| class_type | level_symbol | class_number | 판정 |
|------------|-------------|--------------|------|
| 정규 / 자유학기 | 필수 | 필수 | 둘 중 하나라도 비면 VIOLATION |
| 내신 | 비어야 함 | 비어야 함 | 하나라도 있으면 VIOLATION |
| 특강 | - | 필수 | 비어 있으면 VIOLATION |
| 그 외 | - | - | UNKNOWN_TYPE |

## 관련 스킬

- `firestore-data-fix` — 위반 건 복구 시 사용
- `schema-impact` — enrollment 스키마 변경 영향 분석
- `code-quality` — 가드 코드 추가 후 전체 리뷰
