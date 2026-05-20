# 상담 이력 검색 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 학생 상세 [상담] 탭에서 해당 학생의 상담 이력을 기간 + 키워드로 검색.

**Architecture:** 순수 필터 함수를 의존성 없는 신규 모듈(`consultation-filter.js`)로 분리해 `node:test`로 TDD. firebase 의존 쿼리(`searchStudentConsultations`)는 `data-layer.js`에 추가하고 수동 브라우저 검증. UI는 `consultation-card.js`에 검색 바 + 핸들러 추가. Firestore 스키마/rules/인덱스 변경 없음.

**Tech Stack:** Vite + React 19 + firebase 12 (ESM, `"type": "module"`). 테스트는 Node 내장 `node:test` (설치 불필요).

대상 spec: `docs/superpowers/specs/2026-05-20-consultation-history-search-design.md`

---

## File Structure

| 파일 | 책임 | 종류 |
|------|------|------|
| `consultation-filter.js` | 순수 함수 `filterConsultationsByKeyword` + `DEFAULT_HISTORY_LIMIT` 상수 (firebase 무관) | Create |
| `consultation-filter.test.js` | 위 순수 함수 단위 테스트 (`node:test`) | Create |
| `data-layer.js` | `searchStudentConsultations` 하이브리드 쿼리 추가 | Modify |
| `consultation-card.js` | 검색 바 렌더 + onSearch/onReset 핸들러 + filter 연결 + 초기 limit 20 | Modify |
| `package.json` | `test` 스크립트 추가 | Modify |

---

## Task 1: 순수 필터 모듈 + TDD 인프라

**Files:**
- Create: `consultation-filter.js`
- Create: `consultation-filter.test.js`
- Modify: `package.json` (scripts에 test 추가)

- [ ] **Step 1: package.json에 test 스크립트 추가**

`package.json`의 `scripts`를 다음으로 교체:

```json
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "node --test consultation-filter.test.js"
  },
```

- [ ] **Step 2: 실패 테스트 작성**

`consultation-filter.test.js` 신규 생성:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterConsultationsByKeyword, DEFAULT_HISTORY_LIMIT } from './consultation-filter.js';

const sample = [
  { text: '수학 보강 권유', consultation_type: '정기', teacher_name: 'kim' },
  { text: '휴원 상담 진행', consultation_type: '휴원', teacher_name: 'park' },
  { text: '진로 면담', consultation_type: '학부모요청', teacher_name: 'lee' },
];

test('키워드 없으면 전체 반환', () => {
  assert.equal(filterConsultationsByKeyword(sample, '').length, 3);
  assert.equal(filterConsultationsByKeyword(sample, '   ').length, 3);
  assert.equal(filterConsultationsByKeyword(sample, null).length, 3);
});

test('본문 부분일치', () => {
  const r = filterConsultationsByKeyword(sample, '보강');
  assert.equal(r.length, 1);
  assert.equal(r[0].consultation_type, '정기');
});

test('유형 일치', () => {
  const r = filterConsultationsByKeyword(sample, '학부모요청');
  assert.equal(r.length, 1);
  assert.equal(r[0].text, '진로 면담');
});

test('강사명 대소문자 무시', () => {
  assert.equal(filterConsultationsByKeyword(sample, 'KIM').length, 1);
});

test('일치 없으면 0건', () => {
  assert.equal(filterConsultationsByKeyword(sample, 'zzz').length, 0);
});

test('null/undefined 필드 안전', () => {
  const list = [{ text: null, consultation_type: undefined, teacher_name: null }];
  assert.equal(filterConsultationsByKeyword(list, 'x').length, 0);
});

test('DEFAULT_HISTORY_LIMIT은 20', () => {
  assert.equal(DEFAULT_HISTORY_LIMIT, 20);
});
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `npm test`
Expected: FAIL — `Cannot find module './consultation-filter.js'`

- [ ] **Step 4: consultation-filter.js 구현**

`consultation-filter.js` 신규 생성:

```js
// [상담] 탭 검색용 순수 함수. firebase 의존 없음 → node:test로 단위 테스트 가능.

export const DEFAULT_HISTORY_LIMIT = 20;

// 상담 목록을 키워드로 부분일치 필터 (본문·유형·강사명, 소문자 정규화).
// 키워드가 비어 있으면 원본 그대로 반환.
export function filterConsultationsByKeyword(list, keyword) {
  const kw = (keyword || '').trim().toLowerCase();
  if (!kw) return list;
  return list.filter(c =>
    [c.text, c.consultation_type, c.teacher_name]
      .some(field => String(field || '').toLowerCase().includes(kw))
  );
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `npm test`
Expected: PASS (7 tests)

- [ ] **Step 6: Commit**

```bash
git add consultation-filter.js consultation-filter.test.js package.json
git commit -m "feat(consultation): add keyword filter pure fn + node:test infra"
```

---

## Task 2: data-layer.js 하이브리드 쿼리

**Files:**
- Modify: `data-layer.js` (import 추가 + `searchStudentConsultations` 신규 함수)

**참고:** `listStudentConsultations(studentId, limitCount = 10)`는 이미 존재 (`where('student_id','==',studentId) + orderBy('date','desc') + limit(limitCount)`). `collection, query, where, orderBy, getDocs`는 이미 import됨 (line 5-7). firebase 의존이라 단위 테스트 대신 수동 검증 (Task 4).

- [ ] **Step 1: consultation-filter.js에서 DEFAULT_HISTORY_LIMIT import**

`data-layer.js` 상단 import 블록(line 10-15 근처, 다른 로컬 import들 아래)에 추가:

```js
import { DEFAULT_HISTORY_LIMIT } from './consultation-filter.js';
```

- [ ] **Step 2: searchStudentConsultations 함수 추가**

`data-layer.js`의 `listStudentConsultations` 함수 정의 바로 아래에 추가:

```js
// 하이브리드: 기간 지정 시 Firestore date 범위 쿼리, 미지정 시 최근 N건(listStudentConsultations 재사용).
// 키워드 필터는 호출측(consultation-card)에서 filterConsultationsByKeyword로 처리.
export async function searchStudentConsultations(studentId, { startDate, endDate, limitCount = DEFAULT_HISTORY_LIMIT } = {}) {
  const hasRange = Boolean(startDate || endDate);
  if (!hasRange) {
    return listStudentConsultations(studentId, limitCount);
  }
  const clauses = [where('student_id', '==', studentId)];
  if (startDate) clauses.push(where('date', '>=', startDate));
  if (endDate)   clauses.push(where('date', '<=', endDate));
  const q = query(collection(db, 'consultations'), ...clauses, orderBy('date', 'desc'));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
```

- [ ] **Step 3: 구문 검증 (import 해석)**

Run: `node --check data-layer.js`
Expected: 에러 없음 (exit 0)

> 참고: `node --check`는 구문만 검증. firebase 런타임 동작은 Task 4 브라우저에서 검증.

- [ ] **Step 4: Commit**

```bash
git add data-layer.js
git commit -m "feat(consultation): add searchStudentConsultations hybrid query"
```

---

## Task 3: consultation-card.js 검색 바 + 핸들러

**Files:**
- Modify: `consultation-card.js` (import 교체 + 검색 바 렌더 + 핸들러 + 초기 limit)

**현재 구조 (참고):**
- line 4-9: `import { addConsultation, getStudentSummary, getStudentBriefing, listStudentConsultations } from './data-layer.js';`
- line 85-101: `renderHistoryCard(consultations)`
- line 103-134: `renderConsultationTab(studentId)` — line 120에서 `listStudentConsultations(studentId, 10)`
- line 136-175: `window.onSaveConsultation` — line 166에서 `listStudentConsultations(studentId, 10)`

- [ ] **Step 1: import 교체 (searchStudentConsultations + filter)**

`consultation-card.js` line 4-9의 import 블록을 다음으로 교체:

```js
import {
  addConsultation,
  getStudentSummary,
  getStudentBriefing,
  listStudentConsultations,
  searchStudentConsultations,
} from './data-layer.js';
import { filterConsultationsByKeyword, DEFAULT_HISTORY_LIMIT } from './consultation-filter.js';
```

- [ ] **Step 2: 검색 바 렌더 함수 추가**

`renderHistoryCard` 함수 정의(line 85) 바로 위에 추가:

```js
function renderSearchBar(studentId) {
  return `
    <div class="card consultation-search">
      <div class="row">
        <label>시작일 <input type="date" id="consult-search-start"></label>
        <label>종료일 <input type="date" id="consult-search-end"></label>
      </div>
      <div class="row">
        <input type="text" id="consult-search-kw" placeholder="키워드 (메모·유형·강사명)">
        <button id="consult-search-btn" onclick="onSearchConsultations('${escapeHtml(studentId)}')">검색</button>
        <button id="consult-search-reset" onclick="onResetConsultationSearch('${escapeHtml(studentId)}')">초기화</button>
      </div>
      <span class="hint" id="consult-search-hint"></span>
    </div>
  `;
}
```

- [ ] **Step 3: renderConsultationTab에 검색 바 결합 + 초기 limit 20**

`renderConsultationTab`의 초기 렌더 HTML(line 109-114)에서 history slot 앞에 검색 바를 넣고, line 120의 `listStudentConsultations(studentId, 10)`을 `listStudentConsultations(studentId, DEFAULT_HISTORY_LIMIT)`로 변경.

`container.innerHTML` 템플릿의 `<div id="consult-history-slot">` 줄 앞에 검색 바를 추가:

```js
  container.innerHTML = `
    ${renderInputForm(studentId, readonly)}
    <div id="consult-summary-slot"><em>요약 로딩 중…</em></div>
    <div id="consult-briefing-slot"><em>브리핑 로딩 중…</em></div>
    ${renderSearchBar(studentId)}
    <div id="consult-history-slot"><em>이력 로딩 중…</em></div>
  `;
```

그리고 `Promise.allSettled` 안의 history 페치를 변경:

```js
    listStudentConsultations(studentId, DEFAULT_HISTORY_LIMIT),
```

- [ ] **Step 4: 검색/초기화 핸들러 추가**

`window.onSaveConsultation` 함수 정의(line 136) 바로 위에 추가:

```js
window.onSearchConsultations = async function (studentId) {
  const startEl = document.getElementById('consult-search-start');
  const endEl = document.getElementById('consult-search-end');
  const kwEl = document.getElementById('consult-search-kw');
  const hintEl = document.getElementById('consult-search-hint');
  const startDate = startEl.value || null;
  const endDate = endEl.value || null;
  const keyword = kwEl.value || '';

  if (startDate && endDate && startDate > endDate) {
    _deps.toast?.('시작일이 종료일보다 늦습니다', 'warn');
    return;
  }
  try {
    const raw = await searchStudentConsultations(studentId, { startDate, endDate });
    const filtered = filterConsultationsByKeyword(raw, keyword);
    const slot = document.querySelector('.consultation-history');
    if (slot) slot.outerHTML = renderHistoryCard(filtered);
    if (hintEl) {
      hintEl.textContent = (!startDate && !endDate)
        ? `최근 ${DEFAULT_HISTORY_LIMIT}건 범위에서 검색됨`
        : `${filtered.length}건 검색됨`;
    }
  } catch (err) {
    console.error('[consultation] search failed:', err);
    _deps.toast?.(`검색 실패: ${err.message}`, 'error');
  }
};

window.onResetConsultationSearch = async function (studentId) {
  const startEl = document.getElementById('consult-search-start');
  const endEl = document.getElementById('consult-search-end');
  const kwEl = document.getElementById('consult-search-kw');
  const hintEl = document.getElementById('consult-search-hint');
  if (startEl) startEl.value = '';
  if (endEl) endEl.value = '';
  if (kwEl) kwEl.value = '';
  if (hintEl) hintEl.textContent = '';
  const history = await listStudentConsultations(studentId, DEFAULT_HISTORY_LIMIT);
  const slot = document.querySelector('.consultation-history');
  if (slot) slot.outerHTML = renderHistoryCard(history);
};
```

- [ ] **Step 5: onSaveConsultation의 재페치 건수 통일**

`window.onSaveConsultation` 안의 저장 후 재페치(line 166) `listStudentConsultations(studentId, 10)`을 다음으로 변경:

```js
    const history = await listStudentConsultations(studentId, DEFAULT_HISTORY_LIMIT);
```

- [ ] **Step 6: 구문 검증**

Run: `node --check consultation-card.js`
Expected: 에러 없음 (exit 0)

- [ ] **Step 7: Commit**

```bash
git add consultation-card.js
git commit -m "feat(consultation): add 기간+키워드 검색 바 to [상담] tab"
```

---

## Task 4: 빌드 검증 + 브라우저 수동 검증

**Files:** 없음 (검증만)

- [ ] **Step 1: 단위 테스트 회귀**

Run: `npm test`
Expected: PASS (7 tests, Task 1)

- [ ] **Step 2: 프로덕션 빌드 확인**

Run: `npm run build`
Expected: `dist/` 생성, 에러 없음. consultation-card·consultation-filter가 번들에 포함.

- [ ] **Step 3: dev 서버 브라우저 검증**

Run: `npm run dev` → 브라우저에서 학생 상세 → [상담] 탭. 다음 체크:
- [ ] 검색 바 렌더 (시작일/종료일/키워드/검색/초기화)
- [ ] 초기 이력이 최근 20건까지 표시 (기존 10 → 20)
- [ ] 기간만 지정 → 해당 기간 상담만 (date desc)
- [ ] 키워드만 지정 → 최근 20건 중 일치분 + hint "최근 20건 범위에서 검색됨"
- [ ] 기간+키워드 → 교집합 + hint "N건 검색됨"
- [ ] 시작일 > 종료일 → 경고 토스트, 쿼리 안 함
- [ ] 결과 0건 → renderHistoryCard의 "없음" 표시
- [ ] [초기화] → 입력 비우고 최근 20건 복원
- [ ] 상담 저장 후 이력 재페치도 정상 (20건)

> dev 서버·브라우저 검증이 불가능한 환경이면, 그 사실을 사용자에게 명시하고 단위 테스트 + `node --check` + `npm run build` 결과만으로 보고한다 (UI 동작은 미검증으로 표기).

- [ ] **Step 4: AGENTS.md / 변경 이력 (있으면) 갱신 후 최종 정리**

impact7newDSC에 변경 이력 문서가 있으면 한 줄 추가. 없으면 skip.

---

## 검증 요약 체크리스트

- [ ] **Task 1**: `consultation-filter.js` (순수 함수 + 상수) + `node:test` 7건 PASS
- [ ] **Task 2**: `data-layer.js` `searchStudentConsultations` 하이브리드 쿼리 + `node --check`
- [ ] **Task 3**: `consultation-card.js` 검색 바 + onSearch/onReset 핸들러 + 초기 limit 20
- [ ] **Task 4**: `npm test` + `npm run build` + 브라우저 9개 체크

---

## 범위 외 (spec 8절)

- 퇴원생 상담 UI 접근 (데이터는 보존됨, 진입 UI는 후속)
- Excel/Google Sheets import (별도 spec; `xlsx` 의존성은 이미 존재)
- 학원 전체 상담 검색 (한 학생 범위만)

## 참고

- Spec: `docs/superpowers/specs/2026-05-20-consultation-history-search-design.md`
- 기존 인덱스: impact7DB에 `consultations` `student_id ASC + date DESC` composite 배포됨 — 재사용, 추가 불필요
