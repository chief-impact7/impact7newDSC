# a11y 공통 스니펫 + DSC 전 영역 접근성 확장 (2026-06-28)

메인 화면 접근성 개선(focus-visible·reduced-motion·터치영역·키보드·aria)을 DSC 전 영역과
에코시스템 공유 가능한 형태로 확장. 커밋 `6a20b4f`(전 영역), 선행 `429935a`(메인 1차).

## 핵심 결정 (비자명)

1. **`a11y.css` = 공유 SSoT 후보.** 토큰·클래스 무관 보편 규칙(`:focus-visible`,
   `prefers-reduced-motion`)만 담는다. 6개 페이지(index·class-setup·dashboard·messages·
   checkin·excel) head에 `<link href="a11y.css">`로 연결 → Vite가 공통청크(`auth-*.css`)로
   병합해 전 페이지 자동 적용. `:focus-visible`에 **border-radius 주지 말 것**(원형 버튼이
   사각형으로 변형됨 — outline은 요소 모서리를 자동으로 따른다).

2. **shared(@impact7/shared)는 순수 함수 전용** — AGENTS.md "DOM·CSS import 금지" 명시.
   그래서 a11y.css/DOM 유틸은 shared에 못 넣는다. a11y.css는 DSC 로컬 SSoT 후보로 두고,
   다른 앱 승격은 크로스앱 조율(impact7DB orchestrator). 스타일 방식이 분열돼 있어
   (DSC·DB=순수 CSS `:root` / HR·exam=Tailwind v4 `@theme --color-*`) **단일 CSS 파일
   공유는 불가**, 값(토큰)·보편 규칙만 복사/동기화 가능.

3. **`data-keyclick` 전역 위임은 app.js(메인 entry)에만 있다.** `<div onclick>` 인터랙티브
   요소를 `role="button" tabindex="0" data-keyclick`로 만들면 Enter/Space→click(요소 자신이
   포커스일 때만, `el!==e.target` 가드로 중첩 체크박스·토글 보호). 타 entry 페이지
   (class-setup 등)에서 쓰려면 그 entry에 위임을 따로 추가해야 한다. class-setup은 자체
   `#search-results` keydown 위임을 별도로 둠. nav-l1 전용이던 `handleNavL1Keydown`은
   이 단일 위임으로 통합·제거.

4. **aria 상태 동기화 위치**: 토글 `aria-pressed`·탭 `aria-selected`·트리 `aria-expanded`는
   해당 active/선택을 토글하는 렌더/핸들러 함수 안에서 class 토글과 같은 줄에 갱신
   (예: filter-nav setCategory, student-detail switchDetailTab, class-detail
   applyClassDetailTabMode, class-setup toggleDay).

5. dashboard/messages(React)는 P0(키보드 차단) 0건이었다 — 전부 native `<button>`.
   바닐라 JS 영역(메인 동적 렌더·class-detail)만 `<div onclick>` 다발.

## 다른 앱 전파 완료 (2026-06-28)

DB·HR·exam에 보편 규칙 + 구조 접근성 전파 완료. 각 앱 별도 repo·프레임워크라 방식이 다름:
- **DB**(바닐라 JS, 커밋 2833cf8): a11y.css 복사 + index.html link. app.js에 키보드 활성화
  위임은 `[role="button"][tabindex]` 기준(DB는 role=button이 span/li/div에 다 붙어 native
  button과 충돌 없음 — DSC의 data-keyclick 대신). 모달 Esc/Tab트랩은 .modal-overlay로 DSC와 동일.
- **HR**(SvelteKit, eb8c133): app.css(@theme)에 focus-visible(`--color-brand-accent`)·
  reduced-motion 인라인. P0 0건(native 위주). 내비 aria-current, 탭 role, label for/id.
- **exam**(Next.js, 4f8235c): globals.css(`--green-accent`)에 인라인. P0 0건. 채점 컴포넌트
  라벨·aria 다수.

⚠️ **exam 회귀 교훈**: a11y 위해 `{open && <panel>}` 조건부렌더를 `<div hidden={!open}>`
(상시 마운트)로 바꾸면 닫힌 섹션 children이 항상 마운트돼 성능·useEffect 부수효과 회귀.
**조건부 렌더는 유지하고 `aria-expanded`만** 부여하라(`aria-controls`는 패널 상시 존재를
요구하니 쓰지 말 것). code-review에서 잡아 되돌림.

## 디자인 토큰 통일 완료 (2026-06-28)

4개 앱 토큰을 DSC(Starbucks 톤) 기준으로 통일. 커밋 DB 8de9cd0 · HR 6d57bf4 · exam ef9ae6a.
- **코어(그린 #00754A·짙은그린 #006241·배경 #f2f0eb·본문 0.87)는 원래부터 4앱 일치**였음.
- 어긋나 있던 것만 맞춤: 보조텍스트 대비 **0.64**(AA), success **#006241**, danger **#c82014**,
  warning **#e37400**, border **#e7e3db**.
- 네이밍은 앱마다 다름(DSC/DB `--text-sec`·`--success`, HR `--color-*`, exam `--text-muted`·
  `--md-error`·`--hairline`) → 의미 단위로 매핑해 값만 통일.
- **변형 토큰(bg/strong/container/notice)·다크모드 토큰은 보존**(DSC에 대응 없음, 손대면 부조화).
- DB는 warning을 `--warn`으로, exam은 success/warning 전용 토큰이 없어 일부만 대상.
- ⚠️ 토큰은 여전히 **각 앱에 복제**된 상태(SSoT 파일 없음). shared는 순수 함수 전용이라 CSS
  토큰 SSoT를 못 둠. 향후 한쪽 값 변경 시 4곳 수동 동기화 필요(drift 재발 위험).

## 토큰 SSoT 구축 완료 (2026-06-28, impact7DB a5dfd3f)

토큰 값 4곳 분산 → 마스터 1개 + 검증 스크립트로 통합. shared(github 태그·앱마다
버전 제각각)에 안 넣고, 허브인 **impact7DB/.agents**에 둠(quality-guard와 동일 패턴,
4앱이 절대경로 호출):
- `impact7DB/.agents/design-tokens.json` — **값의 단일 진실**. 의미 토큰 8개
  (primary/surface/text-main/text-sec/success/danger/warning/border) + 4앱별 토큰명 매핑.
  토큰 값은 **여기서만** 바꾼다.
- `impact7DB/.agents/hooks/check-design-tokens.mjs` — 마스터 vs 각 앱 CSS 대조,
  drift 차단(공백/대소문자 정규화, 라이트 :root 우선). `node ...check-design-tokens.mjs`
  전체 / `--app <dsc|db|hr|exam>` 단일. 현재 30개 일치.
- ⚠️ files 경로가 **절대경로(로컬 전용)**. 다른 머신/CI에선 경로 조정 필요(파일 부재 시 skip).
- ✅ **4앱 pre-push 자동 연동 완료**: 각 앱 `scripts/pre-push.hook`에 `check-design-tokens.mjs
  --app <키>` 추가(install-hooks.sh가 .git/hooks/pre-push로 cp). 한 앱 토큰만 바꿔 push하면
  자동 차단 → drift 원천 봉쇄. negative test(drift 주입→exit1→복원→exit0)로 차단 검증.
  커밋: DSC 9399e97 · DB c58cd4e · HR 5db5d22 · exam 2133e80.
- 변형(bg/strong/container)·다크모드는 SSoT 밖(각 앱 자유).

## 공유 DOM 유틸(a11y-dom.js) 통합 완료 (2026-06-28, DB c4e390a · DSC 2529780)

DSC·DB가 복제하던 모달 Esc/Tab트랩 + 키보드 위임을 공유 모듈로 추출(토큰 SSoT와 동일
마스터+검증 패턴). 동기: DB Esc cleanup 버그가 DSC와 drift였던 사례.
- 마스터: `impact7DB/.agents/shared-dom/a11y-dom.js` — `installKeyboardActivation(selector)`
  + `installModalA11y({modalSelector, closeModal})`. 앱별 차이(셀렉터·닫기 동작)는 인자/콜백
  으로 흡수해 모듈 코드는 동일.
- 각 앱 루트로 복사 후 app.js에서 `import './a11y-dom.js'`. DSC=data-keyclick·display/remove,
  DB=role=button[tabindex]·onclick close 함수(cleanup). nav-l1-group aria-expanded는 DSC 고유.
- 검증: `impact7DB/.agents/hooks/check-shared-dom.mjs`(마스터-복사본 byte 일치) +
  DSC·DB pre-push 연동. negative test로 차단 확인. HR·exam은 프레임워크 컴포넌트라 비대상.
- ⚠️ 마스터 수정 시 각 앱 루트로 복사해야(pre-push가 불일치 차단). 절대경로(로컬 전용).

## 에코시스템 일관성 인프라 요약 (impact7DB/.agents 허브)

| 대상 | 마스터 | 검증(+pre-push) | 적용 앱 |
|------|--------|------|------|
| 디자인 토큰 | design-tokens.json | check-design-tokens.mjs | 4앱 |
| 공유 DOM 유틸 | shared-dom/a11y-dom.js | check-shared-dom.mjs | DSC·DB |
| 코드 품질 마커 | — | impact7-precommit-quality-guard.mjs | 4앱 |

미해소 과제 없음(이번 세션 범위). 추가 공유 후보 생기면 같은 마스터+검증 패턴 적용.

관련: [[project_ui_ux_audit_2026-06-11]], [[feedback_dashboard_reads_dsc_only]]
