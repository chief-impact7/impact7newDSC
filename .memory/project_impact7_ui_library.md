# @impact7/ui — 에코시스템 공유 React 컴포넌트 라이브러리 (2026-06-28)

프레임워크 분열(바닐라 DSC·DB / Svelte HR / Next exam)을 강제 통합 않고 점진 수렴하기 위한
공유 컴포넌트 라이브러리. 두 목적: ① 한 번 만들어 여러 앱 재사용 ② 신규를 React로 수렴.

## 위치·배포
- 로컬: `/Users/jongsooyi/IMPACT7/impact7-ui`, github: `chief-impact7/impact7-ui` (public — 2026-07-05 전환: private라서 CI npm ci가 ssh publickey로 실패, 통합 호스팅·DB 함수 배포가 하루 멈췄던 원인)
- 설치: `github:chief-impact7/impact7-ui#v0.1.0` (shared와 동일 태그 방식)
- **github 태그 설치 시 `prepare`(=build:tokens + vite build)가 dist 자동 생성** (dist는 gitignore).
  exam에서 설치→resolve→빌드 동작 검증 완료(2026-06-28).

## 구조 (핵심)
- `Button`(variant primary/secondary/danger) — 토큰 기반, a11y(focus-visible) 내장.
- 토큰: `scripts/build-tokens.mjs`가 `design-tokens.json` SSoT → `src/tokens.css`(--i7-*) 자동 생성.
  **라이브러리가 토큰 SSoT의 소비자** — 토큰을 SSoT에서 바꾸면 라이브러리도 따라감.
- Vite lib 빌드(ESM), react/react-dom **external + peer**(소비 앱 것 사용, hook 충돌·중복 방지).

## 멀티프레임워크 사용 (핵심 패턴)
- **React 앱(exam)**: `import { Button } from '@impact7/ui'` + `import '@impact7/ui/styles.css'` (1회).
- **바닐라·Svelte(DSC·DB·HR)**: `import { mount } from '@impact7/ui/mount'`; `const h = mount(el, Button, props)`;
  `h.update(next)` / `h.unmount()` (islands). 데모(demo/)에서 React·mount 둘 다 브라우저 렌더 검증.
  ⚠️ mount는 react/react-dom **peer 필요**(DSC는 react 19 보유 — dashboard/messages가 React라; DB는 확인 필요).
  ⚠️ 한 앱 *내부* 프레임워크 혼용 남발 금지 — ROI 높은 영역만, 반드시 `unmount` 정리(누수 방지).

## 수렴 정책 (5 repo AGENTS.md 명문화)
"신규 화면·앱은 React(Next), 공유 UI는 @impact7/ui, 공유 레이어(토큰/shared/a11y) 재사용,
앱 내부 혼용 금지." — DSC·DB·HR·exam·shared AGENTS.md "프론트엔드 수렴 정책" 섹션.

## 정식 code-review 완료 (2026-06-28)

라이브러리·검증 스크립트에 정식 code-review 실행(처음엔 직접 점검으로 갈음했다가 사용자
지적으로 정식 수행 — Critical/런타임 0이나 footgun·가드무력화 다수 발견). 수정·배포:
- **@impact7/ui v0.1.1**(8378e6e): Button `type` 기본 'button'(폼 암묵 submit 방지), mount
  WeakMap 멱등화(같은 el 재마운트 누수·unmount후 update 방지), CSS 추출 문서화.
- **검증 스크립트**(DB 67e1ff4): `--app` 오타·누락이 "0건 검사 후 ✅통과"하던 **silent bypass
  차단**(가드 무력화) + `checked===0` 실패 + check-design-tokens 첫 `:root` 블록만 추출(다크
  블록 오매칭 방지, 소스 순서 비의존).

**보류(실해 낮음, NOTES)**: ① 검증 스크립트 절대경로 — 1인 로컬 전용(CI/협업 시 상대경로화
필요). ② a11y-dom `installKeyboardActivation` install-once 가드·`closest→matches` 단순화 —
앱당 1회 호출이라 실해 낮음 + 마스터+2복사본 동기화 비용으로 보류. ③ topVisibleModal의
visibility:hidden 엣지. — 정규식 prefix 충돌(`--warn` vs `--warn-bg`)은 `:` 경계로 이미 방어됨(확인).

## 미해소 / 다음
- **실제 운영 화면 첫 교체 미적용** — 통합은 검증됐으나 운영 화면은 시각 변화·회귀가 일선에
  노출되므로 "어느 화면부터" 정한 뒤 설치+사용+커밋해야 안전. exam(React 직접)이 1차 후보.
- 컴포넌트 확장(Badge·Card·Modal·Input) — 점진.
- design-sync용 `.d.ts`: 컴포넌트 늘면 **TS 전환**으로 자동 생성(지금 Button 1개엔 수동 d.ts+dist
  복사 인프라가 과투자라 보류). 그 후 `/design-sync`로 claude.ai/design 연동 가능(package shape).

관련: [[project_a11y_shared_snippet_2026-06-28]]
