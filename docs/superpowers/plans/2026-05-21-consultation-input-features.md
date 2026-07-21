# 상담 입력/조회 기능 4건 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 상담에 AI 자동 제목 부여, 조회 날짜 기본값(3개월), 제목 기반 이력(3개월·최근순), 중요 상담 pin 고정을 추가한다.

**Architecture:** 순수 로직(날짜 범위·제목 fallback·정렬)은 `consultation-filter.js`에 모아 node:test로 검증한다. Gemini 호출은 `firebase-ai.js`의 `geminiModel`을 공유하되, 큐+rate-limit 래퍼를 신규 `gemini-queue.js`로 만들어 `consultation-ai.js`(제목 생성)가 사용한다. 학부모 알림장(`parent-message.js`)은 자기 큐를 그대로 유지한다(타 도메인 미변경). pin은 24h update window를 피해 별도 `consultation_pins` 컬렉션을 쓰며, 그 rules는 impact7DB에서 4앱 동기화 후 배포한다(DSC 기능의 선행).

**Tech Stack:** Vite + vanilla JS(ESM), firebase 12 (firestore + ai), Firebase AI(Gemini 3 Flash), node:test, Firestore rules.

**대상 spec:** `docs/superpowers/specs/2026-05-21-consultation-input-features-design.md`

**브랜치 전략(메모리):** DSC는 master push=production 자동배포 → Phase 2는 `feat/consultation-input-features` 브랜치 + PR. impact7DB rules는 별도 repo, 4앱 동기화 후 배포. 머지/`--delete-branch` 전 `git log origin/<branch>..HEAD`(미push) **그리고** `git log HEAD..origin/<branch>`(원격이 앞선 것, 병렬 세션 대비) 둘 다 확인.

---

## File Structure

| 파일 | repo | 책임 | 변경 |
|---|---|---|---|
| `firestore.rules` | impact7DB | `consultation_pins` 접근 규칙 | 신규 블록(1056행 뒤) → 4앱 동기화 |
| `consultation-filter.js` | DSC | [상담] 순수 함수(검색·정렬·날짜·제목 fallback) | 함수 4개 추가 |
| `consultation-filter.test.js` | DSC | 위 순수 함수 단위 테스트 | 테스트 추가 |
| `gemini-queue.js` | DSC | Gemini 요청 큐+rate-limit+429재시도 (신규) | 신규 |
| `consultation-ai.js` | DSC | 상담 메모 → AI 제목 (fallback 포함, 신규) | 신규 |
| `consultation-payload.js` | DSC | 입력값 → Firestore 문서 객체 | `title` 필드 추가 |
| `consultation-payload.test.js` | DSC | payload 단위 테스트 | `title` 검증 추가 |
| `data-layer.js` | DSC | Firestore I/O | pin 함수 3개 + `auditDelete` import |
| `consultation-card.js` | DSC | [상담] 탭 렌더·핸들러 | 제목 생성·날짜 기본값·이력·pin UI |
| `daily-ops.css` | DSC | 스타일 | pin 토글·제목·고정 행 스타일 |

---

## Phase 1 — impact7DB: `consultation_pins` rules (DSC pin 기능의 선행)

### Task 1: consultation_pins rules 블록 추가 + 4앱 동기화 + 배포

**Files:**
- Modify: `/Users/jongsooyi/IMPACT7/impact7DB/firestore.rules` (1056행 `consultation_trends` 블록 뒤)

- [ ] **Step 1: rules 블록 추가**

`firestore.rules`에서 `match /consultation_trends/{periodKey} { ... }` 블록(1053–1056행) 바로 다음, `// 기본 거부` 주석(1058행) 앞에 삽입:

```
    // 상담 고정(pin) — 24h window 없는 별도 컬렉션 (consultations는 안 건드림)
    match /consultation_pins/{cid} {
      allow read: if isAuthorized();
      allow create, update: if isAuthorized()
        && request.resource.data.teacher_id == request.auth.uid;
      allow delete: if isAuthorized()
        && resource.data.teacher_id == request.auth.uid;
    }

```

- [ ] **Step 2: rules 문법 검증**

Run: `cd /Users/jongsooyi/IMPACT7/impact7DB && npx firebase deploy --only firestore:rules --dry-run` (또는 해당 repo의 표준 검증 명령)
Expected: 컴파일 에러 없음. (실패 시 중괄호/세미콜론 확인)

- [ ] **Step 3: 4앱 동기화**

impact7DB의 `/firestore-rules-sync` 스킬을 실행해 동일 rules를 DB/DSC/HR/exam 4앱에 반영한다. 스킬이 각 앱 repo로 rules를 전파한다.
(스킬 사용 불가 시: 4개 앱 각각의 `firestore.rules`에 동일 블록을 수동 복사.)

- [ ] **Step 4: 배포**

Run: `cd /Users/jongsooyi/IMPACT7/impact7DB && npx firebase deploy --only firestore:rules`
Expected: `Deploy complete`. (4앱 각각 배포가 필요하면 동기화 스킬 안내에 따른다.)

- [ ] **Step 5: 권한 수동 검증**

Firestore 콘솔/emulator에서:
- 로그인 강사 본인 `teacher_id`로 `consultation_pins/{cid}` create → 성공
- 다른 `teacher_id` 값으로 create → 거부
- 본인 문서 delete → 성공, 타인 문서 delete → 거부

- [ ] **Step 6: 커밋**

```bash
cd /Users/jongsooyi/IMPACT7/impact7DB
git add firestore.rules
git commit -m "feat(rules): add consultation_pins collection (상담 고정용, 본인만 쓰기)"
```

---

## Phase 2 — impact7newDSC: 4기능 구현 (feat 브랜치 + PR)

> 시작 전: `cd /Users/jongsooyi/IMPACT7/impact7newDSC && git checkout master && git pull --ff-only && git checkout -b feat/consultation-input-features`

### Task 2: 순수 함수 (날짜 범위·제목 fallback·프롬프트·정렬) + 테스트

**Files:**
- Modify: `consultation-filter.js`
- Test: `consultation-filter.test.js`

- [ ] **Step 1: 실패 테스트 작성**

`consultation-filter.test.js` 상단 import에 새 함수를 추가하고, 파일 끝에 테스트를 추가:

```js
import {
  filterConsultationsByKeyword, DEFAULT_HISTORY_LIMIT,
  defaultSearchRange, consultationTitleFallback, buildTitlePrompt, sortConsultationsForHistory,
} from './consultation-filter.js';
```

```js
test('defaultSearchRange: 오늘과 3개월 전 (UTC)', () => {
  const r = defaultSearchRange(new Date('2026-05-21T00:00:00Z'));
  assert.deepEqual(r, { start: '2026-02-21', end: '2026-05-21' });
});

test('defaultSearchRange: 연도 롤오버', () => {
  const r = defaultSearchRange(new Date('2026-01-15T00:00:00Z'));
  assert.deepEqual(r, { start: '2025-10-15', end: '2026-01-15' });
});

test('consultationTitleFallback: 앞 20자, trim', () => {
  assert.equal(consultationTitleFallback('  안녕하세요 학부모 상담 진행했습니다 추가로 더 길게  '), '안녕하세요 학부모 상담 진행했습니다 추');
  assert.equal(consultationTitleFallback(''), '');
  assert.equal(consultationTitleFallback(null), '');
});

test('buildTitlePrompt: 메모 포함 + 제목만 출력 지시', () => {
  const p = buildTitlePrompt('휴원 상담');
  assert.match(p, /휴원 상담/);
  assert.match(p, /제목/);
});

test('sortConsultationsForHistory: pin 먼저, 그 안에서 date desc', () => {
  const list = [
    { id: 'a', date: '2026-05-01' },
    { id: 'b', date: '2026-05-10' },
    { id: 'c', date: '2026-04-01' },
  ];
  const r = sortConsultationsForHistory(list, ['c']);
  assert.deepEqual(r.map(x => x.id), ['c', 'b', 'a']);
});

test('sortConsultationsForHistory: 원본 불변', () => {
  const list = [{ id: 'a', date: '2026-05-01' }, { id: 'b', date: '2026-05-10' }];
  sortConsultationsForHistory(list, []);
  assert.deepEqual(list.map(x => x.id), ['a', 'b']);
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd /Users/jongsooyi/IMPACT7/impact7newDSC && npm test`
Expected: FAIL — `defaultSearchRange is not a function` 등.

- [ ] **Step 3: 함수 구현**

`consultation-filter.js` 끝(파일 마지막 `}` 뒤)에 추가하고, 파일 상단 주석을 `// [상담] 탭 순수 함수 (검색·정렬·날짜 기본값·제목 fallback). firebase 의존 없음 → node:test 가능.` 으로 갱신:

```js
// 조회 기본 기간: 오늘(end) ~ 3개월 전(start), ISO YYYY-MM-DD. UTC 기준(결정적).
export function defaultSearchRange(now = new Date()) {
  const end = now.toISOString().slice(0, 10);
  const start = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth() - 3, now.getUTCDate()
  )).toISOString().slice(0, 10);
  return { start, end };
}

// 제목이 없을 때 메모 앞 20자.
export function consultationTitleFallback(text) {
  return (text || '').trim().slice(0, 20);
}

// 제목 생성용 Gemini 프롬프트.
export function buildTitlePrompt(text) {
  return `다음 상담 메모의 핵심을 20자 이내의 한국어 제목 한 줄로 요약해줘. 따옴표나 접두어 없이 제목만 출력해.\n\n상담 메모:\n${text}`;
}

// 이력 정렬: pin(pinnedIds에 포함된 id) 먼저, 그 안에서 date 내림차순. 원본 불변.
export function sortConsultationsForHistory(list, pinnedIds = []) {
  const pinned = new Set(pinnedIds);
  return [...list].sort((a, b) => {
    const ap = pinned.has(a.id) ? 1 : 0;
    const bp = pinned.has(b.id) ? 1 : 0;
    if (ap !== bp) return bp - ap;
    return String(b.date || '').localeCompare(String(a.date || ''));
  });
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test`
Expected: PASS (기존 + 신규 전부).

- [ ] **Step 5: 커밋**

```bash
git add consultation-filter.js consultation-filter.test.js
git commit -m "feat(consultation): 조회 날짜 기본값·제목 fallback·이력 정렬 순수 함수 + 테스트"
```

### Task 3: `gemini-queue.js` — Gemini 요청 큐 (신규, 학부모 알림장 미변경)

**Files:**
- Create: `gemini-queue.js`

- [ ] **Step 1: 모듈 작성**

`parent-message.js`의 큐 패턴(`generateContent` + 1200ms rate-limit + 429 지수백오프)을 독립 모듈로 신설. parent-message.js는 건드리지 않는다(타 도메인).

```js
// Gemini 요청 큐: 직렬화 + 1200ms rate-limit + 429 지수백오프 재시도.
// 상담 제목 생성(consultation-ai.js)이 사용. 학부모 알림장은 자기 큐 유지.
import { geminiModel } from './firebase-ai.js';

const _queue = [];
let _running = false;
let _lastCall = 0;
const MIN_INTERVAL = 1200;

async function _withRetry(prompt, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await geminiModel.generateContent(prompt);
    } catch (err) {
      const is429 = err?.message?.includes('429') || err?.message?.includes('Resource exhausted');
      if (!is429 || attempt === maxRetries - 1) throw err;
      const delay = Math.pow(2, attempt + 1) * 1000;
      console.warn(`Gemini 429 → ${delay / 1000}초 후 재시도 (${attempt + 1}/${maxRetries})`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

async function _process() {
  _running = true;
  while (_queue.length > 0) {
    const { prompt, resolve, reject } = _queue.shift();
    const elapsed = Date.now() - _lastCall;
    if (elapsed < MIN_INTERVAL) await new Promise(r => setTimeout(r, MIN_INTERVAL - elapsed));
    try {
      _lastCall = Date.now();
      resolve(await _withRetry(prompt));
    } catch (err) {
      reject(err);
    }
  }
  _running = false;
}

export function enqueueGemini(prompt) {
  return new Promise((resolve, reject) => {
    _queue.push({ prompt, resolve, reject });
    if (!_running) _process();
  });
}
```

- [ ] **Step 2: 문법 검증**

Run: `node --check gemini-queue.js`
Expected: 에러 없음.

- [ ] **Step 3: 커밋**

```bash
git add gemini-queue.js
git commit -m "feat: add gemini-queue.js (Gemini 요청 큐+rate-limit, 상담 제목용)"
```

### Task 4: `consultation-ai.js` — AI 제목 생성 (fallback 포함, 신규)

**Files:**
- Create: `consultation-ai.js`

- [ ] **Step 1: 모듈 작성**

```js
// 상담 메모 → AI 자동 제목. Gemini 큐 공유, 실패 시 메모 앞 20자 fallback.
import { enqueueGemini } from './gemini-queue.js';
import { buildTitlePrompt, consultationTitleFallback } from './consultation-filter.js';

export async function generateConsultationTitle(text) {
  const memo = (text || '').trim();
  if (!memo) return '';
  try {
    const result = await enqueueGemini(buildTitlePrompt(memo));
    const raw = result.response.text().trim().replace(/^["'\s]+|["'\s]+$/g, '');
    return raw ? raw.slice(0, 40) : consultationTitleFallback(memo);
  } catch (err) {
    console.error('[consultation] 제목 생성 실패, fallback 사용:', err);
    return consultationTitleFallback(memo);
  }
}
```

- [ ] **Step 2: 문법 검증**

Run: `node --check consultation-ai.js`
Expected: 에러 없음.

- [ ] **Step 3: 커밋**

```bash
git add consultation-ai.js
git commit -m "feat(consultation): generateConsultationTitle (Gemini 동기 제목 + fallback)"
```

### Task 5: `consultation-payload.js` — `title` 필드 추가

**Files:**
- Modify: `consultation-payload.js`
- Test: `consultation-payload.test.js`

- [ ] **Step 1: 실패 테스트 추가**

`consultation-payload.test.js` 끝에 추가:

```js
test('title 필드 포함', () => {
  const p = buildConsultationPayload({
    studentId: 's1', studentName: '홍길동', className: 'A반',
    teacherId: 't1', teacherName: 'kim',
    date: '2026-05-21', target: '학생', method: '대면',
    consultationType: '정기', text: '메모', title: '정기 상담 요약',
  });
  assert.equal(p.title, '정기 상담 요약');
});

test('title 없으면 빈 문자열', () => {
  const p = buildConsultationPayload({
    studentId: 's1', studentName: '홍', className: '',
    teacherId: 't1', teacherName: 'kim',
    date: '2026-05-21', target: '학생', method: '대면',
    consultationType: '정기', text: '메모',
  });
  assert.equal(p.title, '');
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npm test`
Expected: FAIL — `p.title`가 `undefined`.

- [ ] **Step 3: 구현**

`consultation-payload.js`의 `buildConsultationPayload` 시그니처에 `title`을 추가하고 반환 객체에 `title` 필드를 넣는다:

```js
export function buildConsultationPayload({
  studentId, studentName, className,
  teacherId, teacherName,
  date, target, method, consultationType, text, title,
}) {
  return {
    student_id: studentId,
    student_name: studentName,
    class_name: className || '',
    teacher_id: teacherId,
    teacher_name: teacherName,
    date,
    target,
    method,
    consultation_type: consultationType,
    text: (text || '').trim(),
    title: title || '',
  };
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add consultation-payload.js consultation-payload.test.js
git commit -m "feat(consultation): payload에 title 필드 추가 + 테스트"
```

### Task 6: `data-layer.js` — pin 함수 3개

**Files:**
- Modify: `data-layer.js` (import 11행, 함수는 857행 `searchStudentConsultations` 뒤)

- [ ] **Step 1: auditDelete import 추가**

11행을 다음으로 교체:

```js
import { auditUpdate, auditSet, auditAdd, auditDelete, batchUpdate, batchSet, READ_ONLY } from './audit.js';
```

- [ ] **Step 2: pin 함수 추가**

`searchStudentConsultations` 함수(857행) 다음에 추가:

```js
// ─── 상담 고정(pin): consultation_pins/{cid} (doc id = consultation id) ───
export async function listStudentPins(studentId) {
  const q = query(collection(db, 'consultation_pins'), where('student_id', '==', studentId));
  const snap = await getDocs(q);
  return snap.docs.map(d => d.id);
}

export async function pinConsultation(cid, studentId, teacherId) {
  await auditSet(doc(db, 'consultation_pins', cid), {
    consultation_id: cid,
    student_id: studentId,
    teacher_id: teacherId,
    pinned_at: serverTimestamp(),
  });
}

export async function unpinConsultation(cid) {
  await auditDelete(doc(db, 'consultation_pins', cid));
}
```

- [ ] **Step 3: 문법 검증**

Run: `node --check data-layer.js`
Expected: 에러 없음.

- [ ] **Step 4: 커밋**

```bash
git add data-layer.js
git commit -m "feat(consultation): consultation_pins I/O (list/pin/unpin)"
```

### Task 7: `consultation-card.js` — 저장 시 AI 제목 생성 연결

**Files:**
- Modify: `consultation-card.js` (import 블록, `onSaveConsultation`)

- [ ] **Step 1: import 추가**

상단 import 블록에 추가(기존 data-layer import 묶음 뒤):

```js
import { generateConsultationTitle } from './consultation-ai.js';
```

그리고 `consultation-filter.js` import 라인을 확장:

```js
import {
  filterConsultationsByKeyword, DEFAULT_HISTORY_LIMIT,
  defaultSearchRange, consultationTitleFallback, sortConsultationsForHistory,
} from './consultation-filter.js';
```

data-layer import 묶음에 pin 함수 추가:

```js
import {
  addConsultation,
  getStudentSummary,
  getStudentBriefing,
  listStudentConsultations,
  searchStudentConsultations,
  listStudentPins,
  pinConsultation,
  unpinConsultation,
} from './data-layer.js';
```

- [ ] **Step 2: onSaveConsultation에 제목 생성 삽입**

`onSaveConsultation`에서 `btn.textContent = '저장 중...';` 다음, `try {` 블록 안에서 payload 생성 직전에 제목을 만들고 payload에 전달:

```js
  btn.disabled = true;
  btn.textContent = '저장 중...';
  try {
    const title = await generateConsultationTitle(textEl.value);
    const payload = buildConsultationPayload({
      studentId,
      studentName: student.name,
      className: activeClassCodes(student, dateEl.value).join(', '),
      teacherId: teacher.id,
      teacherName: teacher.name,
      date: dateEl.value,
      target: targetEl?.value || '학생',
      method: methodEl.value,
      consultationType: typeEl.value,
      text: textEl.value,
      title,
    });
    await addConsultation(payload);
    _deps.toast?.('상담 저장됨', 'success');
    textEl.value = '';
  } catch (err) {
```

- [ ] **Step 3: 문법 검증 + 빌드**

Run: `node --check consultation-card.js && npm run build`
Expected: 빌드 성공.

- [ ] **Step 4: 커밋**

```bash
git add consultation-card.js
git commit -m "feat(consultation): 저장 시 AI 제목 동기 생성 연결"
```

### Task 8: `consultation-card.js` — 조회 날짜 기본값(3개월)

**Files:**
- Modify: `consultation-card.js` (`renderSearchBar`, `onResetConsultationSearch`)

- [ ] **Step 1: renderSearchBar 기본값 설정**

`renderSearchBar`를 다음으로 교체(시작/종료일 `value`에 3개월 기본값):

```js
function renderSearchBar(studentId) {
  const { start, end } = defaultSearchRange();
  return `
    <div class="card consultation-search">
      <div class="row consult-search-dates">
        <label>시작일 <input type="date" id="consult-search-start" value="${start}"></label>
        <label>종료일 <input type="date" id="consult-search-end" value="${end}"></label>
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

- [ ] **Step 2: onResetConsultationSearch — 빈 값이 아니라 기본 3개월로 복원**

```js
window.onResetConsultationSearch = async function (studentId) {
  const { startEl, endEl, kwEl, hintEl } = getSearchEls();
  const { start, end } = defaultSearchRange();
  if (startEl) startEl.value = start;
  if (endEl) endEl.value = end;
  if (kwEl) kwEl.value = '';
  if (hintEl) hintEl.textContent = '';
  await loadAndRenderHistory(studentId, { startDate: start, endDate: end, keyword: '' });
};
```

(`loadAndRenderHistory`는 Task 9에서 정의. 이 Task의 빌드 검증은 Task 9 직후 함께 수행해도 됨 — 또는 Task 9를 먼저 본 뒤 8·9를 연속 구현.)

- [ ] **Step 3: 커밋**

```bash
git add consultation-card.js
git commit -m "feat(consultation): 조회 시작/종료일 기본값 3개월"
```

### Task 9: `consultation-card.js` — 이력(3개월·제목·pin·정렬) + CSS

**Files:**
- Modify: `consultation-card.js` (`renderSearchTab`, `renderHistoryCard`, `replaceHistoryCard`, `onSearchConsultations`, pin 핸들러, 신규 `loadAndRenderHistory`)
- Modify: `daily-ops.css`

- [ ] **Step 1: 공용 로더 `loadAndRenderHistory` 추가**

`getSearchEls` 함수 근처(파일 상단 헬퍼 영역)에 추가:

```js
async function loadAndRenderHistory(studentId, { startDate, endDate, keyword = '' }) {
  const [raw, pinnedIds] = await Promise.all([
    searchStudentConsultations(studentId, { startDate, endDate }),
    listStudentPins(studentId).catch(() => []),
  ]);
  const filtered = filterConsultationsByKeyword(raw, keyword);
  const sorted = sortConsultationsForHistory(filtered, pinnedIds);
  replaceHistoryCard(sorted, pinnedIds, studentId);
}
```

- [ ] **Step 2: `replaceHistoryCard` 시그니처 확장**

```js
function replaceHistoryCard(consultations, pinnedIds = [], studentId = '') {
  const slot = document.querySelector('.consultation-history');
  if (slot) slot.outerHTML = renderHistoryCard(consultations, pinnedIds, studentId);
}
```

- [ ] **Step 3: `renderHistoryCard` — 제목 + 📌 토글 + pin 표식**

```js
function renderHistoryCard(consultations, pinnedIds = [], studentId = '') {
  if (!consultations.length) {
    return `<div class="card consultation-history"><h4>상담 이력</h4><em>최근 3개월 내역 없음</em></div>`;
  }
  const pinned = new Set(pinnedIds);
  const rows = consultations.map(c => {
    const isPinned = pinned.has(c.id);
    const title = escapeHtml(c.title || consultationTitleFallback(c.text));
    const badge = escapeHtml([c.consultation_type, c.method, c.target].filter(Boolean).join('·'));
    return `
    <details class="consult-hist-item${isPinned ? ' pinned' : ''}">
      <summary>
        <button class="pin-toggle${isPinned ? ' active' : ''}" title="${isPinned ? '고정 해제' : '상단 고정'}"
          onclick="event.preventDefault(); event.stopPropagation(); onTogglePin('${escapeHtml(studentId)}','${escapeHtml(c.id)}')">📌</button>
        <strong>${escapeHtml(c.date)}</strong>
        <span class="type-badge">${badge}</span>
        <span class="hist-title">${title}</span>
      </summary>
      <pre class="consultation-text">${escapeHtml(c.text)}</pre>
    </details>`;
  }).join('');
  return `<div class="card consultation-history"><h4>상담 이력 (최근 3개월 · ${consultations.length}건)</h4>${rows}</div>`;
}
```

- [ ] **Step 4: `renderSearchTab` — 3개월 로드 + pin + 정렬**

```js
async function renderSearchTab(studentId) {
  const body = document.getElementById('consult-subtab-body');
  if (!body) return;
  body.innerHTML = `
    <div id="consult-summary-slot"><em>요약 로딩 중…</em></div>
    ${renderSearchBar(studentId)}
    <div id="consult-history-slot"><em>이력 로딩 중…</em></div>
  `;
  const { start, end } = defaultSearchRange();
  const [summary, history, pins] = await Promise.allSettled([
    getStudentSummary(studentId),
    searchStudentConsultations(studentId, { startDate: start, endDate: end }),
    listStudentPins(studentId),
  ]);
  replaceSlot('consult-summary-slot', summary.status === 'fulfilled'
    ? renderSummaryCard(summary.value)
    : `<div class="card consultation-summary"><h4>AI 누적 요약</h4><em>로드 실패</em></div>`);
  if (history.status === 'fulfilled') {
    const pinnedIds = pins.status === 'fulfilled' ? pins.value : [];
    const sorted = sortConsultationsForHistory(history.value, pinnedIds);
    replaceSlot('consult-history-slot', renderHistoryCard(sorted, pinnedIds, studentId));
  } else {
    replaceSlot('consult-history-slot', `<div class="card consultation-history"><h4>상담 이력</h4><em>로드 실패</em></div>`);
  }
}
```

- [ ] **Step 5: `onSearchConsultations` — 로더 재사용**

```js
window.onSearchConsultations = async function (studentId) {
  const { startEl, endEl, kwEl, hintEl } = getSearchEls();
  const startDate = startEl.value || null;
  const endDate = endEl.value || null;
  const keyword = kwEl.value || '';
  if (startDate && endDate && startDate > endDate) {
    _deps.toast?.('시작일이 종료일보다 늦습니다', 'warn');
    return;
  }
  try {
    await loadAndRenderHistory(studentId, { startDate, endDate, keyword });
    if (hintEl) hintEl.textContent = '검색 완료';
  } catch (err) {
    console.error('[consultation] search failed:', err);
    _deps.toast?.(`검색 실패: ${err.message}`, 'error');
  }
};
```

- [ ] **Step 6: pin 토글 핸들러 추가**

`window.onSearchConsultations` 근처에 추가:

```js
window.onTogglePin = async function (studentId, cid) {
  if (_deps.readonly === true) { _deps.toast?.('읽기 전용 모드', 'warn'); return; }
  const teacher = _deps.getCurrentTeacher?.();
  if (!teacher) { _deps.toast?.('강사 정보 로드 실패', 'error'); return; }
  try {
    const pinnedIds = await listStudentPins(studentId);
    if (pinnedIds.includes(cid)) await unpinConsultation(cid);
    else await pinConsultation(cid, studentId, teacher.id);
    const { startEl, endEl, kwEl } = getSearchEls();
    await loadAndRenderHistory(studentId, {
      startDate: startEl?.value || null,
      endDate: endEl?.value || null,
      keyword: kwEl?.value || '',
    });
  } catch (err) {
    console.error('[consultation] pin toggle failed:', err);
    _deps.toast?.(`고정 변경 실패: ${err.message}`, 'error');
  }
};
```

- [ ] **Step 7: 미사용 import 정리**

Task 9 적용 후 `renderSearchTab`·`onResetConsultationSearch`가 `searchStudentConsultations`로 전환되어 `listStudentConsultations`와 `DEFAULT_HISTORY_LIMIT`가 `consultation-card.js`에서 미사용이 된다. 확인 후 import에서 제거:

```bash
grep -n "listStudentConsultations\|DEFAULT_HISTORY_LIMIT" consultation-card.js
```
사용처가 import 라인뿐이면 `listStudentConsultations`(data-layer import 묶음)와 `DEFAULT_HISTORY_LIMIT`(consultation-filter import 묶음)를 삭제. (data-layer.js의 `listStudentConsultations` export 자체는 유지 — 다른 모듈이 쓸 수 있음.)

- [ ] **Step 8: CSS 추가**

`daily-ops.css`의 `.type-badge { ... }` 규칙 뒤(`/* 조회 탭 검색 바 */` 앞)에 추가:

```css
.consult-hist-item summary { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pin-toggle {
  border: none; background: none; cursor: pointer; font-size: .9rem;
  opacity: .3; padding: 0 2px; line-height: 1; filter: grayscale(1);
}
.pin-toggle:hover { opacity: .7; }
.pin-toggle.active { opacity: 1; filter: none; }
.consult-hist-item.pinned { background: #f6fbf9; border-radius: 8px; }
.hist-title { font-size: .9rem; color: rgba(0,0,0,.8); }
```

- [ ] **Step 9: 문법 검증 + 빌드**

Run: `node --check consultation-card.js && npm run build`
Expected: 빌드 성공.

- [ ] **Step 10: 커밋**

```bash
git add consultation-card.js daily-ops.css
git commit -m "feat(consultation): 이력 3개월·제목 표시·pin 고정·최근순 정렬"
```

### Task 10: simplify + review + 브라우저 검증 + PR

**Files:** (검증 only)

- [ ] **Step 1: 단위 테스트 + 빌드 재확인**

Run: `npm test && npm run build`
Expected: 테스트 PASS, 빌드 성공.

- [ ] **Step 2: simplify → review (메모리 워크플로우)**

`feat/consultation-input-features` 변경분(master 대비)에 대해 simplify 스킬로 정리 후 review 스킬로 점검. 중점: 신규 모듈 경계, XSS(제목·메모 escape), pin 토글의 `preventDefault/stopPropagation`로 details 펼침과 충돌 없는지, Promise.allSettled 분기.

- [ ] **Step 3: 브라우저 수동 검증**

Run: `npm run dev` → localhost:5174, 학생 상세 [상담] 탭:
- 입력: 메모 작성 → 저장 → "저장 중..." → 저장됨. (제목 자동 생성은 조회 탭 이력에서 확인)
- 조회: 시작/종료일이 오늘−3개월~오늘로 자동 입력됨. 초기화 → 같은 기본값 복원.
- 이력: 최근 3개월·최근순, 각 항목에 제목 표시(구 상담은 메모 앞 20자). 📌 클릭 → 상단 고정/해제, details 펼침과 충돌 없음. 24h 지난 상담도 pin 가능(Phase 1 rules 배포 후).
- Firebase 로그인/데이터 없어 검증 불가한 항목은 명시.

- [ ] **Step 4: PR 생성**

```bash
git push -u origin feat/consultation-input-features
gh pr create --base master --head feat/consultation-input-features \
  --title "feat: 상담 AI 제목·조회 날짜 기본값·이력 제목/3개월·pin 고정" \
  --body "spec: docs/superpowers/specs/2026-05-21-consultation-input-features-design.md / 선행: impact7DB consultation_pins rules(Phase 1) 배포"
```

- [ ] **Step 5: 머지 (선행 조건 충족 후)**

Phase 1 rules가 4앱 배포된 뒤 머지. 머지 전 `git log origin/feat/consultation-input-features..HEAD`(미push) **+** `git log HEAD..origin/feat/consultation-input-features`(원격 앞섬, 병렬 세션) 둘 다 확인. 머지 = production 자동배포.

---

## 검증 요약

- **node:test:** `defaultSearchRange`, `consultationTitleFallback`, `buildTitlePrompt`, `sortConsultationsForHistory`, payload `title` (Task 2·5)
- **node --check + build:** 모든 DSC JS 변경 (Task 3·4·6·7·9·10)
- **rules:** consultation_pins 본인만 create/delete (Task 1 Step 5)
- **수동 브라우저:** 4기능 e2e (Task 10 Step 3) — Firebase 의존이라 제한적, 불가 항목 명시

## 의존성 / 순서

```
Task 1 (rules, impact7DB) ──────────────┐ (pin 동작의 선행)
Task 2 (순수함수) ─┬─ Task 4 (제목 AI) ─ Task 7 (저장 연결)
Task 3 (큐) ───────┘                      │
Task 2 ── Task 8 (날짜 기본값) ──┐
Task 2 ── Task 9 (이력+pin UI) ──┤ (Task 6 pin I/O 필요)
Task 5 (payload title) ── Task 7 │
Task 6 (pin I/O) ────────────────┘
모두 ── Task 10 (검증·PR)
```

Phase 1(Task 1)은 impact7DB에서 독립 수행·배포. Phase 2(Task 2~10)는 DSC feat 브랜치. pin 기능은 Task 1 배포 후 실동작.

## 후속 (범위 외)

- `parent-message.js`의 큐를 `gemini-queue.js`로 통합(이번엔 학부모 알림장 미변경)
- pin 정렬을 Firestore composite index로
- 제목을 파이프라인 tagger 입력 신호로 / 제목 수동 편집 UI
