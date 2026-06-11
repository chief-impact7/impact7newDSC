# UI/UX 감사 및 14건 수정 (2026-06-11)

프로덕션 사이트를 Chrome 자동화로 감사 → `ui-ux-audit-2026-06-11.json` 체크리스트(루트) 생성 → P1→P2→P3→blocked 순으로 전건 수정. 커밋 cfe5b5e → 13f2fb8 (5개), 전부 배포 완료. **체크리스트 JSON이 재감사·후속 점검의 기준 문서.**

## 다시 만날 함정 (중요)

- **detail 패널 `mobile-visible` 수명주기**: 렌더 함수(renderStudentDetail·renderNaesinDetail·renderTeukangDetail)가 add하는 게 정답이다. add를 클릭 핸들러(selectStudent)로 옮기면 안 됨 — naesin.js·visit-list-render.js·leave-request.js의 inline onclick들이 renderStudentDetail을 **직접 호출**해서 모바일에서 패널이 안 열리는 회귀가 남(코드리뷰로 잡았음). 대신 빈 상태(studentId 없음/학생 미발견)에서 remove하여 stale 클래스를 방지한다.
- **반응형 브레이크포인트 이원화**: `<=768px` 풀스크린 오버레이, `<=1100px` 우측 오버레이(공통 블록). JS는 `matchMedia('(max-width: 1100px)')` change에서만 stale 클래스 정리 — 768 경계(모바일↔태블릿)에서 정리하면 회전 시 보던 detail이 사라진다. CSS 브레이크포인트 바꿀 때 daily-ops.js의 matchMedia 1100도 함께.
- **native `input[type=date]` 캘린더는 페이지 lang 무시**하고 브라우저 UI 언어를 따름 → `date-picker.js`(루트)의 `openKoreanDatePicker(anchorEl, valueStr, onSelect)`로 대체했다. `var(--primary)` 기반이라 페이지 테마 자동 적응. 메인 앱·로그북(React)·excel 3곳 사용 중 — **새 날짜 입력 UI는 native input 대신 이걸 쓸 것.**
- **로그북(dashboard.css) 컬러 토큰은 메인 앱(daily-ops.css :root)과 정합 상태** (2026-06-11부터). 메인 토큰 바꾸면 로그북도 같이 갱신해야 함. 명단 카드 의미 색(퇴원 빨강·결석 보라 등)은 의도적으로 별도.

## 검증 패턴 (재사용)

`.env.development.local`에 `VITE_READ_ONLY=true` 켜고 dev 서버 → Chrome 자동화로 클릭·리사이즈 검증 → write는 콘솔 `[READ-ONLY] auditSet 차단` 로그로 차단 확인 → 검증 후 주석 원복. 프로덕션 클릭 검증 시 출석/지각 등 상태 버튼 절대 클릭 금지(행 이름 영역만).

## 기타 확정 사실

- 반 번호 첫 자리 = 단지 (`branchFromStudent`: 1xx→2단지, 2xx→10단지). "10단지 그룹에 PX202"는 정상.
- 사이드바 카운트 의미는 filter-nav.js `COUNT_TOOLTIPS`에 정의 — `getSubFilterCount` 산식 바꾸면 툴팁도 짝 맞출 것.
- 과거/미래 날짜 배너는 날짜 민감 카테고리(출결·숙제·테스트)에서만 표시 (`DATE_SENSITIVE_CATEGORIES`).
- Material Symbols는 4개 HTML 모두 `display=block` — swap으로 되돌리면 아이콘 ligature 텍스트 플래시 재발.
