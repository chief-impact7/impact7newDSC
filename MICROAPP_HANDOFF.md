# 마이크로앱 핸드오프 — 학생 일일활동 관리 (Daily Student Operations)

## 개요

impact7DB Dashboard와 **동일한 디자인/레이아웃**을 사용하는 마이크로앱.
학생이 학원에 오면 해야 할 모든 활동을 관리한다: 출결, 숙제, 테스트, 재시, 보충, 일정 잡기.

**기존 시스템과의 관계:**
- Firebase 프로젝트: `impact7db` (동일)
- 학생 마스터: `students` 컬렉션 (기존, 읽기 전용 참조)
- 일일 활동 데이터: 새 컬렉션 추가 (아래 데이터 모델 참조)

---

## 1. 디자인 시스템 (impact7DB Dashboard에서 그대로 복사)

### CSS 변수
```css
:root {
    --primary: #0b57d0;
    --primary-light: #e8f0fe;
    --on-primary: #ffffff;
    --surface: #f8fafd;
    --surface-container: #ffffff;
    --surface-hover: #f1f3f4;
    --outline: #747775;
    --text-main: #1f1f1f;
    --text-sec: #444746;
    --hover-bg: #f2f6fc;
    --active-bg: #d3e3fd;
    --active-text: #041e49;
    --border: #e0e0e0;
    --radius-lg: 12px;
    --font-heading: 'Google Sans', sans-serif;
    --font-body: 'Roboto', sans-serif;
}
```

### 외부 리소스
- 폰트: `Google Sans` (heading) + `Roboto` (body)
- 아이콘: Material Symbols Outlined (variable font, FILL 0, wght 400)
```html
<link href="https://fonts.googleapis.com/css2?family=Google+Sans:wght@400;500;700&family=Roboto:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200" />
```

---

## 2. 레이아웃 (3-Column, Gmail 스타일)

```
┌─────────────────────────────────────────────────────────┐
│  [☰] [📋 Daily Operations]       [🔍 검색바]  [⚙️] [👤] │  ← App Bar (64px)
├──────────┬──────────────────┬───────────────────────────┤
│          │  Panel Header    │  Detail Header            │
│ Sidebar  │  [건수] [필터칩] │  [탭바] [액션버튼]         │
│ (240px)  │  ──────────────  │  ─────────────────        │
│          │  □ 항목 1        │  프로필/제목               │
│ [+ 버튼] │  □ 항목 2        │                           │
│          │  ■ 항목 3 ← 선택 │  카드1: 오늘 출결          │
│ ▸ 카테1  │  □ 항목 4        │  카드2: 숙제 현황          │
│   ├ 하위1│  □ 항목 5        │  카드3: 테스트/재시        │
│   └ 하위2│                  │  카드4: 보충/일정          │
│ ▸ 카테2  │  (스크롤 가능)    │  (스크롤 가능)             │
│          │                  │                           │
│          │  ← 360px →       │  ← flex: 1 (나머지) →     │
└──────────┴──────────────────┴───────────────────────────┘
```

### 핵심 수치
| 요소 | 규격 |
|------|------|
| App Bar | 높이 64px, 검색 pill형 (bg: #eaf1fb, radius: 24px, max-width: 600px) |
| Sidebar | 너비 240px, 상단 액션 버튼 (radius: 16px, bg: #c2e7ff) |
| List Panel | 너비 360px, border-right: 1px solid #e0e0e0 |
| Detail Panel | flex: 1, padding: 32px 40px |
| main-content | border-radius: 24px 0 0 0 (좌상단만 둥글게) |
| 전체 | height: 100vh, overflow: hidden, 각 패널 내부 스크롤 |

---

## 3. Sidebar 구조 (3단계 접이식 메뉴, details/summary)

### 스타일 규칙
- L1 (대분류): font-size 13px, weight 600, 높이 36px, padding-left 12px
- L2 (중분류): font-size 12px, weight 500, 높이 30px, padding-left 28px
- L3 (소분류): font-size 12px, 높이 28px, padding-left 56px
- 모두: border-radius: 0 16px 16px 0 (우측만 둥글게)
- 열림 화살표: L1 → `expand_more` (180°), L2 → `chevron_right` (90°)
- 활성: --active-bg 배경

### 이 앱의 사이드바 메뉴
```
[+ 출결 기록]                    ← compose-btn

▾ 오늘 (Today)                  ← L1, 기본 open
    출결 현황                    ← L2, 필터
    미출석                       ← L2, 필터
    지각                         ← L2, 필터

▸ 숙제 (Homework)               ← L1
    ▸ 상태                       ← L2 (접이식)
        미제출                   ← L3
        제출                     ← L3
        확인완료                  ← L3
    ▸ 과목/반별                  ← L2 (접이식)
        (동적 생성)              ← L3

▸ 테스트 (Tests)                ← L1
    ▸ 상태                       ← L2
        예정                     ← L3
        완료                     ← L3
        재시 필요                 ← L3
    ▸ 유형                       ← L2
        정기                     ← L3
        쪽지                     ← L3
        모의                     ← L3

▸ 재시/보충 (Retake & Extra)    ← L1
    재시 대기                    ← L2
    보충 대기                    ← L2
    일정 확정                    ← L2

▸ 소속 (Branch)                 ← L1
    2단지                        ← L2
    10단지                       ← L2

▸ 요일 (Schedule)               ← L1
    월~일                        ← L2
```

---

## 4. List Panel (체크박스 + 일괄처리 포함)

### 기본 상태
```html
<div class="list-panel">
    <div class="panel-header">
        <span class="count-chip">128명</span>
        <span class="filter-chips">오늘 · 미출석</span>
        <div class="actions">
            <span class="material-symbols-outlined icon-btn">calendar_today</span>
            <span class="material-symbols-outlined icon-btn">refresh</span>
        </div>
    </div>
    <div class="list-items">
        <div class="list-item">
            <input type="checkbox" class="item-checkbox" />
            <div class="item-main">
                <span class="item-title">김민준</span>
                <span class="item-desc">중1 · HA104 · 월수금</span>
            </div>
            <span class="item-tag">미출석</span>
        </div>
    </div>
</div>
```

### 일괄처리 (Batch Action Bar)
체크박스 1개 이상 선택 시 panel-header를 대체하며 슬라이드다운 등장:

```html
<div class="batch-action-bar">
    <label class="batch-select-all">
        <input type="checkbox" /> 전체
    </label>
    <span class="batch-count">3명 선택</span>
    <div class="batch-actions">
        <button class="batch-btn">
            <span class="material-symbols-outlined">check_circle</span>
            출석 처리
        </button>
        <button class="batch-btn">
            <span class="material-symbols-outlined">schedule</span>
            재시 일정
        </button>
        <button class="batch-btn batch-btn-danger">
            <span class="material-symbols-outlined">cancel</span>
            결석 처리
        </button>
        <button class="batch-btn-cancel">취소</button>
    </div>
</div>
```

#### batch-action-bar 스타일
```css
.batch-action-bar {
    height: 48px;
    display: flex;
    align-items: center;
    padding: 0 16px;
    background: #e8f0fe;
    border-bottom: 2px solid #0b57d0;
    gap: 12px;
    animation: slideDown 0.2s ease;
}
.batch-count {
    font-family: 'Google Sans', sans-serif;
    font-size: 14px;
    font-weight: 500;
    color: #0b57d0;
}
.batch-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 16px;
    border-radius: 20px;
    border: 1px solid #dadce0;
    background: white;
    font-size: 13px;
    cursor: pointer;
}
.batch-btn:hover { background: #f2f6fc; }
.batch-btn-danger { color: #c5221f; border-color: #c5221f; }
.batch-btn-danger:hover { background: #fce8e6; }
.batch-btn-cancel {
    margin-left: auto;
    background: none;
    border: none;
    color: var(--text-sec);
    cursor: pointer;
    font-size: 13px;
}
```

#### 일괄처리 동작
1. 체크박스 1개 이상 → batch-action-bar 표시 (panel-header 대체)
2. "전체 선택" → 현재 필터된 목록 전체 체크
3. 액션 버튼 → 확인 다이얼로그 → 선택 항목 일괄 적용
4. "취소" → 체크 해제 + bar 숨김
5. 건수 실시간 업데이트

#### 일괄처리 가능 액션
| 컨텍스트 | 버튼들 |
|----------|--------|
| 출결 | 출석 처리, 지각 처리, 결석 처리 |
| 숙제 | 제출 확인, 미제출 통보 |
| 테스트 | 재시 지정, 통과 처리 |
| 재시/보충 | 일정 지정 (날짜 선택 모달), 완료 처리 |

---

## 5. Detail Panel

### 프로필 헤더
```html
<div class="profile-header">
    <div class="profile-avatar">민</div>  <!-- 72px, 이름 첫 글자 -->
    <div>
        <h2 class="detail-title">김민준</h2>
        <div class="profile-tags">
            <span class="tag">중1 · 신남중</span>
            <span class="tag tag-status">출석</span>
        </div>
    </div>
</div>
```

### 탭 바
```
[오늘] [숙제] [테스트] [재시/보충] [이력]
```
각 탭은 해당 카테고리의 상세 정보를 보여줌.

### 오늘 탭 — 카드 구성
```
카드1: 출결 정보
  ├ 출석 상태: 출석 / 지각 / 결석 / 미확인
  ├ 등원 시간: 14:30
  └ 메모: (간단 노트)

카드2: 오늘의 숙제
  ├ 숙제1: 영어 단어 50개 [제출 ✓]
  ├ 숙제2: 수학 프린트 [미제출 ✗]
  └ [+ 숙제 추가]

카드3: 오늘의 테스트
  ├ 영단어 테스트: 82점 (합격선: 80) → 통과
  ├ 수학 소테스트: 45점 (합격선: 70) → 재시 필요
  └ [+ 테스트 기록]

카드4: 재시/보충 일정
  ├ 수학 소테스트 재시: 2/25(화) 예정
  ├ 영문법 보충: 2/26(수) 예정
  └ [+ 일정 추가]
```

### 카드 스타일 (기존 대시보드 동일)
- info-card-title: 파란 아이콘 + Google Sans 15px bold
- form-field: field-label (회색) + field-value (본문)
- form-card: 흰색, 내부 패딩

---

## 6. 데이터 모델 (Firestore 새 컬렉션)

### `daily_records` 컬렉션
학생별 일일 활동 기록. docId: `{student_docId}_{날짜}`
```json
{
  "student_id": "김민준_1012345678_2단지",
  "date": "2026-02-24",
  "branch": "2단지",

  "attendance": {
    "status": "출석",          // 출석 / 지각 / 결석 / 미확인
    "check_in_time": "14:30",
    "note": ""
  },

  "homework": [
    {
      "title": "영어 단어 50개",
      "subject": "영어",
      "status": "제출",        // 미제출 / 제출 / 확인완료
      "note": ""
    }
  ],

  "tests": [
    {
      "title": "영단어 테스트",
      "subject": "영어",
      "type": "정기",           // 정기 / 쪽지 / 모의
      "score": 82,
      "pass_score": 80,
      "result": "통과",         // 통과 / 재시필요
      "note": ""
    }
  ],

  "updated_by": "teacher@gw.impact7.kr",
  "updated_at": "2026-02-24T14:35:00Z"
}
```

### `retake_schedule` 컬렉션
재시/보충 일정. docId: auto-ID
```json
{
  "student_id": "김민준_1012345678_2단지",
  "type": "재시",              // 재시 / 보충
  "subject": "수학",
  "title": "수학 소테스트 재시",
  "original_date": "2026-02-24",
  "original_score": 45,
  "scheduled_date": "2026-02-25",
  "status": "예정",            // 예정 / 완료 / 취소
  "result_score": null,
  "created_by": "teacher@gw.impact7.kr",
  "created_at": "2026-02-24T15:00:00Z"
}
```

### 기존 `students` 컬렉션 (읽기 전용 참조)
학생 기본정보는 여기서 가져옴:
- name, level, school, grade, branch, status
- enrollments[]: class_type, level_symbol, class_number, day[], start_date
- parent_phone_1, student_phone
- docId 형식: `이름_전화번호숫자_branch` (예: `김민준_1012345678_2단지`)

---

## 7. 기술 스택

기존 대시보드와 동일:
- **Vite** + vanilla JS (빌드)
- **Firebase v9 client SDK** (Firestore, Auth)
- **Google OAuth** (도메인: @gw.impact7.kr, @impact7.kr)
- HTML/CSS (프레임워크 없음)

---

## 8. 참조 파일

디자인을 정확히 복제하려면 이 파일들을 참조:
- `index.html` — HTML 구조 (sidebar, list-panel, detail-panel)
- `style.css` — 전체 CSS (700+ lines)
- `app.js` — 필터링, 목록 렌더, 상세보기 로직 패턴
- `firebase-config.js` — Firebase 초기화 (.env 기반)
- `auth.js` — Google OAuth 로그인/로그아웃

모두 `/home/jon/projects/ai-collab/impact7DB2AIs/` 에 있음.
