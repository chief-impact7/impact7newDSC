# Impact7 DSC - Project Rules

> 이 문서는 **모든 AI 코딩 도구(Claude Code, Gemini Antigravity 등)가 공통으로 따라야 할 규칙**입니다.
> 작업 전 반드시 읽고 준수하세요.

---

## 1. 프로젝트 개요

- **이름**: Impact7 DSC (Daily Students Checklist)
- **목적**: 학원(Impact7) 선생님들이 매일 학생별 출결, 숙제, 테스트, 전달사항 등을 기록하는 웹 앱
- **사용자**: 학원 선생님 (내부 직원 전용, Google Workspace 계정 인증)
- **언어**: 한국어 UI, 코드 주석도 한국어 허용

---

## 2. 기술 스택
| 영역 | 기술 |
|------|------|
| 언어 | JavaScript (ES Modules) |
| DSC 입력 페이지 | Vanilla JS + Vite (`index.html`, `app.js`) |
| 대시보드 페이지 | React + Vite (`dashboard.html`, `src/dashboard/`) |
| 차트 | Recharts |
| 스타일링 | CSS (`:root` 변수 기반) |
| 디자인 시스템 | Google Material Design 3 |
| Backend/DB | Firebase (Auth, Firestore) |
| Auth | Google Sign-In (popup), `@gw.impact7.kr` / `@impact7.kr` 도메인만 허용 |
---

## 3. 파일 구조

```
impact7newDSC/
├── index.html              # DSC 입력 페이지 (Vanilla JS)
├── app.js                  # DSC 메인 로직 (state, render, Firestore CRUD)
├── dashboard.html          # 대시보드 페이지 (React)
├── auth.js                 # Google 로그인/로그아웃 (공유)
├── firebase-config.js      # Firebase 초기화 (공유)
├── style.css               # DSC 입력 페이지 스타일
├── vite.config.js          # Vite 멀티페이지 설정
├── package.json
├── .env                    # Firebase 환경변수 (git 제외)
├── .gitignore
├── RULES.md                # 이 파일 (공통 규칙)
├── CLAUDE.md               # Claude Code 전용 설정
├── GEMINI_PROMPT.md        # Gemini 온보딩 프롬프트
└── src/
    └── dashboard/
        ├── main.jsx        # React 진입점
        ├── App.jsx         # 대시보드 메인 컴포넌트
        ├── dashboard.css   # 대시보드 스타일
        ├── components/     # 섹션별 컴포넌트
        └── hooks/          # Firestore 커스텀 훅
```

### 파일 역할 - 수정 시 주의

- **app.js**: 모든 핵심 로직이 여기에 있음. 파일이 커지면 모듈 분리 가능하지만, 분리 시 반드시 ES Module (`import/export`) 사용
- **index.html**: 구조적 변경(섹션 추가/삭제) 시 `app.js`의 `SECTIONS` 배열과 반드시 동기화
- **style.css**: CSS 변수(`:root`)를 적극 활용. 섹션별 컬러는 `--sec-*` 변수로 관리
- **.env**: 절대 커밋하지 않음. `VITE_` 접두사 필수

---

## 4. Firestore 데이터 구조

### `students` 컬렉션
```
students/{studentId}
├── name: string              # 학생 이름
├── status: string            # "등원예정" | "재원" | "실휴원" | "가휴원" | "퇴원" | "상담" | "종강"
├── status2: string           # "특강" | null  — 현재 특강 수강 중 여부 (재원생도 특강 수강 시 설정)
├── branch: string            # "2단지" | "10단지" (optional)
├── school: string            # 학교명 (optional)
├── grade: string             # 학년 (optional)
├── enrollments: array        # 수강 정보 배열
│   └── [0]
│       ├── class_type: string       # "정규" | "특강"
│       ├── level_symbol: string     # 레벨 기호 (예: "A", "B")
│       ├── class_number: string     # 반 번호 (예: "101", "202")
│       ├── day: array<string>       # 수업 요일 ["월", "수", "금"]
│       ├── start_time: string       # 수업 시작 시간 "16:00"
│       ├── start_date: string       # 수강 시작일
│       ├── end_date: string         # (특강일 경우) 종료일
│       ├── naesin_days: array       # 학생 개별 내신 등원 요일 (optional, 없으면 반 schedule 전체)
│       ├── naesin_schedule: map     # 내신 시간 개별 override (optional)
│       │   └── {요일}: string       # 예: { "월": "17:30" }
│       └── naesin_class_override: string  # 내신 반 수동 매핑 (optional)
│                                    #  - undefined: 자동 유도 (기본)
│                                    #  - "<csKey>":  해당 반으로 수동 강제 매핑
│                                    #  - "":         내신 대상에서 명시적 배제
```

> **내신 반 코드** 자동 유도: `level_symbol` + `school` + `grade` + A/B(홀짝)
> 내신 기간은 `class_settings` 문서의 `naesin_start ~ naesin_end`로 판단.
> 내신 기간 중에는 정규 enrollment가 DSC 목록에서 숨겨지고 내신 탭으로 이동.
> 반설정상세패널의 "학생 추가"로 `naesin_class_override`를 세팅해 자동 유도를 override할 수 있다.

### `class_settings` 컬렉션 (정규 + 내신 공용)
```
class_settings/{classCode}
├── teacher: string           # 담당 선생님 이메일
├── fee_type: string          # 특강 전용: "유료" | "무료" (특강 외 반에는 없음)
│
│   # 내신 반 전용 필드 (정규 반에는 없음)
├── naesin_start: string      # 내신 시작일 "2026-03-09"
├── naesin_end: string        # 내신 종료일 "2026-05-03"
└── schedule: map             # 요일별 기본 시간
    └── {요일}: string        # 예: { "월": "18:00", "수": "17:00" }
```

### `daily_checks` 컬렉션
```
daily_checks/{date}_{studentId}_{enrollIdx}
├── date: string              # "2026-02-23"
├── student_id: string
├── enrollment_index: number
├── student_name: string
├── class_code: string        # "A101" 등
├── branch: string
├── attendance: string        # "" | "출석" | "결석" | "지각" | "조퇴"
├── attendance_time: string
├── attendance_reason: string
├── hw_reading: string        # "O" | "X" | "△" | ""
├── hw_grammar: string        # (동일 패턴)
├── ... (SECTIONS 배열의 모든 field.key)
├── updated_by: string        # 수정자 이메일
├── updated_at: timestamp     # 서버 타임스탬프
```

### `postponed_tasks` 컬렉션
```
postponed_tasks/{autoId}
├── student_id: string
├── student_name: string
├── original_date: string     # 원래 날짜
├── scheduled_date: string    # 연기된 날짜
├── scheduled_time: string
├── content: string           # 미룬 내용
├── handler: string           # 담당 선생님
├── status: string            # "pending" | "done" | "absent"
├── result: string
├── created_by: string
├── created_at: timestamp
```

### `daily_records` 컬렉션 (daily-ops.js 전용)
```
daily_records/{studentId}_{date}
├── student_id: string
├── date: string                 # "2026-02-27"
├── branch: string
├── hw_fail_action: map          # 숙제 2차 미통과 처리 (domain별)
│   └── {domain}: map            # 예: "Gr", "A/G", "R/C"
│       ├── type: string         # "등원" | "대체숙제"
│       ├── handler: string      # 담당자 이메일
│       ├── scheduled_date: string  # 등원 예약 날짜
│       ├── scheduled_time: string  # 등원 예약 시간 (예: "16:00")
│       ├── alt_hw: string       # 대체숙제 내용
│       └── updated_at: string   # ISO 8601 타임스탬프
├── updated_by: string
├── updated_at: timestamp
```

### `hw_fail_tasks` 컬렉션 (숙제 미통과 처리 태스크)
```
hw_fail_tasks/{studentId}_{domain}_{sourceDate}
├── student_id: string
├── student_name: string
├── domain: string               # "Gr" | "A/G" | "R/C" 등
├── type: string                 # "등원" | "대체숙제"
├── source_date: string          # 원래 미통과 발생 날짜
├── scheduled_date: string       # 등원 예약 날짜
├── scheduled_time: string       # 등원 예약 시간
├── alt_hw: string               # 대체숙제 내용
├── handler: string              # 담당자
├── status: string               # "pending" | "완료" | "취소"
├── branch: string
├── created_by: string
├── created_at: string           # ISO 8601 타임스탬프
├── completed_by: string         # (완료 시)
├── completed_at: string         # (완료 시)
├── cancelled_by: string         # (취소 시)
├── cancelled_at: string         # (취소 시)
```

---

## 5. 핵심 비즈니스 로직

### 5.1 학생 필터링
- 선택한 날짜의 **요일**에 수업이 있는 학생만 표시
- `enrollments[].day` 배열에 해당 요일이 포함된 경우만
- `status === '퇴원'`인 학생 제외

### 5.2 Branch(소속) 판별
- `student.branch` 필드 우선
- 없으면 `class_number` 첫 자리로 추론: `1` → 2단지, `2` → 10단지

### 5.3 OX 순환
- 클릭 순서: `""` → `"O"` → `"△"` → `"X"` → `""`
- 색상: O=green, X=red, △=yellow

### 5.4 자동 저장
- 2초 디바운스
- `setDoc(..., { merge: true })` 사용
- 저장 상태 인디케이터: 저장 중 → 저장 완료(1.5초 후 사라짐) / 저장 실패(3초)

### 5.5 반응형
- **PC (>768px)**: 가로 스크롤 테이블 (sticky 왼쪽 3열)
- **모바일 (<=768px)**: 카드 리스트 (접기/펼치기)

---

## 6. 코딩 컨벤션

### 일반
- ES Module 사용 (`import/export`), CommonJS 금지
- 변수명: camelCase
- 상수: UPPER_SNAKE_CASE (예: `SECTIONS`)
- 함수: camelCase, 동사로 시작 (예: `loadAllStudents`, `renderTable`)
- DOM ID: kebab-case (예: `date-picker`, `filter-branch`)
- CSS 클래스: kebab-case (예: `card-header`, `sec-attendance`)

### Firebase
- 환경변수는 반드시 `import.meta.env.VITE_*` 사용
- Firestore 문서 ID 규칙: `{date}_{studentId}_{enrollIdx}`
- `serverTimestamp()` 사용하여 시간 기록

### HTML
- `onclick` 인라인 핸들러 사용 중 (기존 패턴 유지)
- `window.*`로 전역 함수 노출 (Vite module 환경에서 필요)

### CSS
- CSS 변수 (`:root`)를 통한 테마 관리
- 섹션별 컬러: `--sec-attendance`, `--sec-homework` 등
- 모바일 대응: `@media (max-width: 768px)`

---

## 7. 협업 규칙 (Claude Code + Gemini Antigravity)

### 7.1 작업 분담 원칙
- 같은 파일을 동시에 수정하지 않는다
- 작업 시작 전, 어떤 파일을 수정할지 사용자에게 명시한다
- 충돌 방지를 위해 가능하면 새 파일/모듈로 분리하여 작업한다

### 7.2 커뮤니케이션
- 변경사항은 **무엇을 왜 바꿨는지** 간결히 설명한다
- 다른 AI가 만든 코드를 수정해야 할 때, 수정 이유를 명확히 밝힌다

### 7.3 충돌 방지 체크리스트
수정 전 확인:
- [ ] `SECTIONS` 배열 변경 시 → `index.html` thead도 동기화했는가?
- [ ] 새 Firestore 필드 추가 시 → 이 문서의 데이터 구조도 업데이트했는가?
- [ ] CSS 클래스명 변경 시 → `app.js`에서 참조하는 곳도 바꿨는가?
- [ ] 새 함수 추가 시 → `window.*`로 노출이 필요한가? (onclick 등에서 호출하는 경우)

### 7.4 금지사항
- `.env` 파일을 직접 수정하거나 값을 노출하지 않는다
- `node_modules/`, `dist/` 내부 파일 수정 금지
- Firestore 보안 규칙을 코드에서 우회하는 로직 금지

---

## 8. 앞으로 추가될 기능 (TODO)

> 우선순위는 사용자가 결정. 아래는 예상 기능 목록.

- [ ] 학생 관리 페이지 (CRUD)
- [ ] 통계/리포트 (기간별 출결률, 숙제 완료율)
- [ ] 인쇄 기능 (일일 체크리스트 PDF 출력)
- [ ] 권한 관리 (관리자/일반 선생님)
- [ ] 오프라인 지원 (Firestore offline persistence)
- [ ] PWA (앱 설치)

---

## 9. 개발 서버 실행

```bash
npm run dev        # Vite dev server (port 5174)
npm run build      # Production build
npm run preview    # Preview production build
```
