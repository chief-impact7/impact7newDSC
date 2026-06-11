# re-export 전용 구문은 로컬 바인딩 없음 (2026-06-11 사고)

`export { esc, escAttr } from '@impact7/shared/html-escape'` 같은 re-export 전용
구문은 **자기 파일 스코프에 심볼을 바인딩하지 않는다**. 같은 파일에서 그 심볼을
쓰면 빌드는 통과하고 **런타임 ReferenceError**로만 터진다.

**Why:** 6db7efc(shared drift 교정)가 ui-utils.js의 로컬 esc/escAttr 정의를
re-export로 바꿈 → 같은 파일의 `renderTime12hSelect`가 escAttr() 호출 시 throw →
상세패널 카드 조립(거대 템플릿 리터럴) 전체 중단 → 헤더만 갱신, 카드 빈 채/직전
학생 잔존. open 결석대장(보충 일시 입력) 보유 학생(유지민)에서만 발현되어 추적이
어려웠다. daily-ops 분리 사고(bare identifier)와 같은 "빌드 통과·런타임 전용" 클래스.

**How to apply:**
- shared 모듈로 중복 제거(drift 교정) 시 re-export 도입하면 **같은 파일 내 사용
  여부를 반드시 확인** — 사용하면 `import {...}; export {...};`로 분리
- 진단 기법: 빌드 산출물(dist/assets/*.js)에서 bare 심볼 grep — minify 후에도
  rename 안 된 식별자 = 스코프 누락 실증
- 전수 점검: `scripts/oneoff/check-reexport-usage.mjs` 패턴 (re-export 심볼의
  로컬 호출 검색)
- 관련: [[reference_codegraph_guide]], 학생 1명만 깨질 땐 그 학생만 가진 데이터
  (결석대장 등)가 어떤 렌더 분기를 깨우는지 역추적
