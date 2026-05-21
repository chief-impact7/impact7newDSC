# 상담 입력/조회 기능 4건 — Design Spec

작성일: 2026-05-21
대상 프로젝트: impact7newDSC (+ impact7DB rules)
배경: v1.2 입력 안내 카드 작업 중 사용자가 상담 제목 자동 생성·조회 편의·pin 고정 요청.

## 1. 목적 / 범위

- **목적:** 상담에 AI 자동 제목 부여, 조회 편의(날짜 기본값·제목 이력), 중요 상담 pin 고정.
- **범위:**
  - impact7newDSC: `consultation-card.js`, `data-layer.js`, `daily-ops.css`, (제목 생성에 `firebase-ai.js`·`parent-message.js` 패턴 재사용)
  - impact7DB: `firestore.rules` (consultation_pins 신규 블록) → 4앱 동기화
- **범위 외:** 상담 분석 파이프라인(별도, Claude Opus), 퇴원생 UI, Excel import.

## 2. 기능 1 — 제목 AI 자동 생성 (Gemini 실시간 동기)

**AI 인프라 재사용:** `firebase-ai.js`의 `geminiModel`(`gemini-3-flash-preview`, VertexAI 백엔드, 클라이언트 직접 호출) + `parent-message.js`의 큐+속도제한 래퍼(`_enqueueGemini`)를 재사용. 학부모 알림장과 **동일 모델·동일 호출 방식** → 관리 일원화.

**동작:**
- `onSaveConsultation`에서 저장 직전, 메모 `text`를 Gemini에 보내 **짧은 제목(공백 포함 ~20자)** 생성 → `title` 필드에 포함하여 `addConsultation`.
- **동기**: 저장 버튼 → 제목 생성(1~2초, "저장 중..." 표시) → 저장 완료. 제목이 처음부터 존재.
- **fallback**: Gemini 실패/타임아웃 시 메모 앞 20자를 제목으로. (저장 자체는 항상 성공)
- 제목 생성 헬퍼: `generateConsultationTitle(text)` — parent-message의 `_enqueueGemini` 패턴 사용. 두 곳이 공유하면 큐 래퍼를 공용 모듈로 추출 검토(plan 단계).

**프롬프트(요지):** "다음 상담 메모의 핵심을 20자 이내 한국어 제목으로. 제목만 출력." + `text`.

**스키마:** `consultations.title`(string) 신규. create rule은 필수 8필드만 요구(hasAll) → `title` 추가 필드 허용, **rules 무변경**.

## 3. 기능 2 — 조회 날짜 기본값

- `renderSearchBar`의 시작일 `value` = 오늘−3개월, 종료일 `value` = 오늘 (ISO `YYYY-MM-DD`).
- 헬퍼 `defaultSearchRange()` → `{ start, end }` 순수 함수(node:test 가능).
- 초기화 버튼은 이 기본값으로 되돌림(빈 값이 아니라).

## 4. 기능 3 — 상담이력 제목/3개월/최근순

- **범위 3개월 통일**: 조회 기본값(3개월)과 일치하도록 이력 기본 로드도 최근 3개월. v1.2의 `searchStudentConsultations(studentId, { startDate: 3개월전, endDate: 오늘 })`(하이브리드 쿼리)를 재사용 — 별도 함수 신설 없이 기간 기반 로드. (limit 기반 `listStudentConsultations`는 그대로 두고 호출만 전환)
- **표시**: 각 항목 제목 = `title`(없으면 메모 앞 20자 fallback). 현재 "메모 40자 미리보기" 대신 제목 + 펼치면 본문.
- **정렬**: pin 먼저(기능4), 그 안에서 date desc (클라이언트 정렬).

## 5. 기능 4 — pin 고정 (consultation_pins 별도 컬렉션)

**컬렉션:** `consultation_pins/{consultation_id}`
```json
{ "consultation_id": "...", "student_id": "...", "teacher_id": "...", "pinned_at": "<serverTimestamp>" }
```
- doc id = consultation_id (학생 1명의 상담을 cid로 유일 식별).

**rules (impact7DB firestore.rules 신규 블록):**
```
match /consultation_pins/{cid} {
  allow read: if isAuthorized();
  allow create, update: if isAuthorized()
    && request.resource.data.teacher_id == request.auth.uid;
  allow delete: if isAuthorized()
    && resource.data.teacher_id == request.auth.uid;
}
```
- **24h window 없음** → 오래된 상담도 pin/unpin 가능. consultations는 안 건드림.
- 신규 컬렉션 → **4앱 동기화**(`/firestore-rules-sync`로 DB/DSC/HR/exam 반영).

**DSC:**
- `data-layer.js`: `listStudentPins(studentId)` (consultation_pins where student_id), `pinConsultation(cid, studentId, teacherId)` (set), `unpinConsultation(cid)` (delete).
- `consultation-card.js`: 이력 각 항목에 📌 토글 버튼. 클릭 시 pin/unpin + 이력 재렌더(pin 먼저).
- 조회 시 `listStudentPins`로 pin 집합 → `renderHistoryCard`가 pinned 항목을 상단에 표시(📌 표식).

## 6. 스키마 변경 요약

| 대상 | 변경 | rules |
|---|---|---|
| `consultations.title` | 신규 string 필드 | 무변경 (create hasAll 추가 필드 허용) |
| `consultation_pins/{cid}` | 신규 컬렉션 | **신규 블록 + 4앱 동기화** |

## 7. 영향 / 호환성

- **하위 호환:** `title` 없는 구 상담 → 이력에서 메모 앞 20자 fallback. `consultation_pins` 없으면 pin 없음(전부 최근순).
- **AI 비용/속도:** 제목 생성은 저장당 Gemini 1회(짧은 출력). `_enqueueGemini` 속도제한(1200ms) 공유로 알림장과 큐 경합 가능 — 사용 빈도 낮아 무시.
- **consultation 파이프라인:** `title`은 tagger 입력에 포함될 수 있으나 이번 범위는 DSC 생성만. 파이프라인은 무영향(추가 필드 무시).
- **DSC 배포:** master push = production 자동배포 → feat 브랜치 + PR.

## 8. 검증 방법

1. **단위(node:test):** `defaultSearchRange()`(오늘−3개월 경계), 제목 fallback 로직(메모 앞 20자) 순수 함수.
2. **수동(브라우저):**
   - 저장 → 제목 자동 생성(또는 fallback) → 이력에 제목 표시
   - 조회 시작/종료일 기본 3개월 자동 입력
   - 이력 최근 3개월 + 최근순 + 제목
   - 📌 토글 → pin 상단 고정, 24h 지난 상담도 pin 가능
3. **rules:** consultation_pins 4앱 동기화 후 emulator/rules-test로 본인만 create/delete 확인.

## 9. 구현 분리 (plan 단계)

- **Phase 1 (impact7DB rules):** consultation_pins 블록 추가 + 4앱 동기화 + 배포. (DSC pin 기능의 선행)
- **Phase 2 (impact7newDSC):** title 생성(기능1) + 날짜 기본값(2) + 이력 제목·3개월(3) + pin UI(4). 한 feat 브랜치 + PR.

## 10. 후속 (범위 외)

- 제목을 파이프라인 tagger 입력 신호로 활용
- pin 정렬을 Firestore composite index로(현재 클라이언트 정렬)
- 제목 수동 편집 UI
