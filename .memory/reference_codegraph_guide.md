---
name: reference-codegraph-guide
description: codegraph 인덱스 현황 + 도메인별 핵심 쿼리 패턴 — 이 프로젝트에서 코드를 탐색할 때 먼저 확인
metadata:
  type: reference
---

# impact7newDSC codegraph 활용 가이드

**인덱스 현황 (2026-06-09 기준)**
- 파일 72개 · 노드 1,526개 · 엣지 4,270개 · DB 4.31 MB
- 언어: JavaScript 57, JSX 13, YAML 2
- WAL 모드 — 동시 읽기 안전

## 구조 개요

```
app.js / daily-ops.js  — 메인 SPA
hw-management.js       — 숙제·다음숙제 관리 (분리 완료)
parent-message.js      — 학부모 메시지 생성 (AI 포함)
state.js               — 전역 상태 (selectedDate, allStudents 등)
```

## 도메인별 codegraph_explore 핵심 쿼리

| 도메인 | 쿼리 예시 |
|-------|----------|
| 숙제 OX 관리 | `"toggleHwDomainOX applyHwDomainOX oxFieldLabel hw_domains"` |
| 다음 숙제 | `"renderNextHwClassDetail refreshNextHwViews classNextHw nextHwChip"` |
| 학부모 메시지 AI | `"generateParentMessage generateDataTemplate domainFullName gemini"` |
| 학생 상세 뷰 | `"renderStudentDetail selectStudent collectStudentDaySummary"` |
| 출결 관리 | `"attendance toggleAttendance renderAttendance"` |
| 반별 뷰·필터 | `"classCode enrollmentCode getClassDomains matchesBranchFilter"` |
| 상태 관리 | `"state allStudents selectedDate selectedStudentId activeFilters"` |
| Firebase 저장 | `"saveImmediately dailyRecords db firestore"` |
| @impact7/shared 연동 | `"studentFullLabel studentShortLabel enrollment-status history"` |
| echarts 차트 | `"ReactECharts echarts option notMerge"` |

## 주요 모듈 위치

| 파일 | 역할 |
|------|------|
| `state.js` | 전역 상태 단일 원천 |
| `app.js` | 메인 SPA 진입점 |
| `daily-ops.js` | 일별 운영 로직 |
| `hw-management.js` | 숙제·다음숙제 UI + 저장 |
| `parent-message.js` | 학부모 메시지 생성 (Gemini AI) |

## @impact7/shared 우선 탐색 원칙

학생 상태·이력·라벨·번호 작업 전 먼저 확인:
```
/Users/jongsooyi/projects/impact7-shared/package.json
```
핵심 shared 모듈: `history-classifier`, `enrollment-status`, `student-label`,
`student-number`, `class-move`

## Firestore 컬렉션

| 컬렉션 | 설명 |
|--------|------|
| `students` | 학생 마스터 (impact7DB 소유, 읽기 전용) |
| `daily_records` | 일별 수업 기록 |
| `class_settings` | 반별 설정 (도메인·다음숙제 포함) |
| `daily_stats` | 일별 통계 |

## 주의: 테스트 없음

모든 심볼에 "no covering tests found" — 변경 시 런타임 검증 필수.
