# [상담] 탭 redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** [상담] 탭을 헤더(닫기)+입력/조회 서브탭으로 재구성, 입력 메타데이터(대상·형태·반명) 확장, starbucks 톤 redesign.

**Architecture:** 기존 render* 함수(renderInputForm·renderSummaryCard·renderBriefingCard·renderHistoryCard·renderSearchBar)를 재사용·재배치한다. `renderConsultationTab`을 헤더+서브탭 디스패처로 개편하고 `renderInputTab`/`renderSearchTab` wrapper를 추가. 입력값→Firestore 객체 변환은 순수 함수 `buildConsultationPayload`로 분리(node:test). `addConsultation`은 `{...data}` spread라 신규 필드 자동 통과 — data-layer 변경 불필요. rules 변경 없음(hasAll 방식).

**Tech Stack:** Vite + vanilla JS (ESM, `"type":"module"`). 테스트 `node:test`. firebase 12.

대상 spec: `docs/superpowers/specs/2026-05-20-consultation-tab-redesign-design.md`

---

## File Structure

| 파일 | 책임 | 종류 |
|------|------|------|
| `consultation-payload.js` | 순수 함수 `buildConsultationPayload` (입력값→Firestore 객체) | Create |
| `consultation-payload.test.js` | 위 단위 테스트 | Create |
| `consultation-card.js` | 헤더+서브탭 디스패처, 입력/조회 탭, 입력폼 신규 필드, 이력 배지, 핸들러 | Modify |
| `daily-ops.css` | `.consultation-*` 스타일 (헤더·서브탭·입력폼·배지) | Modify |
| `package.json` | test 스크립트를 2개 테스트 파일로 확장 | Modify |

**data-layer.js 변경 불필요:** `addConsultation`(data-layer.js:808-820)은 `{ ...data, ai_processed:false, ... }`로 전달 객체를 spread하므로 신규 필드(target·method·class_name)가 자동 포함됨.

---

## Task 1: buildConsultationPayload 순수 함수 + 테스트

**Files:**
- Create: `consultation-payload.js`
- Create: `consultation-payload.test.js`
- Modify: `package.json`

- [ ] **Step 1: package.json test를 2개 파일로 확장**

`package.json`의 `"test"` 스크립트를 교체:

```json
    "test": "node --test consultation-filter.test.js consultation-payload.test.js"
```

- [ ] **Step 2: 실패 테스트 작성**

`consultation-payload.test.js` 신규 생성:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConsultationPayload } from './consultation-payload.js';

const base = {
  studentId: 's1', studentName: '홍길동', className: '고1A',
  teacherId: 'uid1', teacherName: 'kim',
  date: '2026-05-20', target: '학생', method: '대면',
  consultationType: '정기', text: '  메모 내용  ',
};

test('필드 매핑 + text trim', () => {
  const p = buildConsultationPayload(base);
  assert.equal(p.student_id, 's1');
  assert.equal(p.student_name, '홍길동');
  assert.equal(p.class_name, '고1A');
  assert.equal(p.teacher_id, 'uid1');
  assert.equal(p.teacher_name, 'kim');
  assert.equal(p.date, '2026-05-20');
  assert.equal(p.target, '학생');
  assert.equal(p.method, '대면');
  assert.equal(p.consultation_type, '정기');
  assert.equal(p.text, '메모 내용');
});

test('신규 필드가 모두 포함된다 (rules 필수 8필드 + 신규 3)', () => {
  const p = buildConsultationPayload(base);
  for (const k of ['student_id', 'teacher_id', 'date', 'consultation_type', 'text']) {
    assert.ok(k in p, `${k} 누락`);
  }
  for (const k of ['target', 'method', 'class_name']) {
    assert.ok(k in p, `신규 ${k} 누락`);
  }
});

test('className 비어도 키는 존재 (빈 문자열)', () => {
  const p = buildConsultationPayload({ ...base, className: '' });
  assert.equal(p.class_name, '');
});
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `npm test`
Expected: FAIL — `Cannot find module './consultation-payload.js'`

- [ ] **Step 4: consultation-payload.js 구현**

`consultation-payload.js` 신규 생성:

```js
// 입력 탭 값 → Firestore consultations 문서 객체. firebase 의존 없음 → node:test 가능.
// teacher/ai_processed/created_at은 addConsultation(data-layer)이 추가.

export function buildConsultationPayload({
  studentId, studentName, className,
  teacherId, teacherName,
  date, target, method, consultationType, text,
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
  };
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `npm test`
Expected: PASS (consultation-filter 7건 + consultation-payload 3건 = 10건)

- [ ] **Step 6: Commit**

```bash
cd /Users/jongsooyi/IMPACT7/impact7newDSC
git add consultation-payload.js consultation-payload.test.js package.json
git commit -m "feat(consultation): add buildConsultationPayload pure fn (target/method/class_name)"
```

---

## Task 2: 헤더 + 서브탭 디스패처

**Files:**
- Modify: `consultation-card.js` (import 추가 + 모듈 변수 + renderConsultationTab 개편 + 헤더/서브탭 렌더 + onConsultationSubtab)

**현재 구조:** `renderConsultationTab(studentId)`(약 line 103~)이 `detail-content`를 입력폼+요약+브리핑+검색+이력으로 한 번에 채움. 이를 헤더+서브탭 디스패처로 바꾼다. 기존 `renderInputForm`·`renderSummaryCard`·`renderBriefingCard`·`renderHistoryCard`·`renderSearchBar`·`getSearchEls`·`replaceHistoryCard`는 유지(Task 3·4에서 재사용).

- [ ] **Step 1: import에 헬퍼 + 모듈 변수 추가**

`consultation-card.js` 상단 import 블록(`consultation-filter.js` import 줄) 다음에 추가:

```js
import { buildConsultationPayload } from './consultation-payload.js';
import { activeClassCodes } from './student-helpers.js';
```

`let _deps = {};` 아래에 서브탭 상태 변수 추가:

```js
let _activeSubtab = 'input';  // 'input' | 'search'
```

- [ ] **Step 2: renderConsultationTab을 헤더+서브탭 디스패처로 교체**

기존 `export async function renderConsultationTab(studentId) { ... }` 전체를 다음으로 교체:

```js
function renderConsultationHeader() {
  return `
    <div class="consultation-header">
      <h3>🗨 상담</h3>
      <button class="consultation-close" onclick="switchDetailTab('daily')">× 닫기</button>
    </div>
    <div class="consultation-subtabs">
      <button class="consultation-subtab ${_activeSubtab === 'input' ? 'active' : ''}"
        onclick="onConsultationSubtab('input')">입력</button>
      <button class="consultation-subtab ${_activeSubtab === 'search' ? 'active' : ''}"
        onclick="onConsultationSubtab('search')">조회</button>
    </div>
  `;
}

export async function renderConsultationTab(studentId) {
  const container = document.getElementById('detail-content');
  if (!container) return;
  container.innerHTML = `
    ${renderConsultationHeader()}
    <div id="consult-subtab-body"><em>로딩 중…</em></div>
  `;
  if (_activeSubtab === 'input') {
    await renderInputTab(studentId);
  } else {
    await renderSearchTab(studentId);
  }
}

window.onConsultationSubtab = function (tab) {
  _activeSubtab = tab;
  const studentId = window.__consultStudentId;
  if (studentId) renderConsultationTab(studentId);  // 헤더가 active 상태를 다시 그림
};
```

> 참고: studentId 재참조를 위해 renderConsultationTab 진입 시 `window.__consultStudentId = studentId;`를 저장한다. Step 3에서 renderInputTab/renderSearchTab가 studentId를 받으므로, onConsultationSubtab은 저장된 id로 재렌더.

`renderConsultationTab` 첫 줄(`const container...`) 위에 추가:

```js
  window.__consultStudentId = studentId;
```

- [ ] **Step 3: 구문 검증**

Run: `node --check consultation-card.js`
Expected: 에러 없음

> renderInputTab/renderSearchTab는 Task 3·4에서 정의. 이 시점에서는 미정의라 런타임 호출 시 에러나지만 `node --check`는 구문만 보므로 통과. Task 4까지 완료 후 통합 동작.

- [ ] **Step 4: Commit**

```bash
cd /Users/jongsooyi/IMPACT7/impact7newDSC
git add consultation-card.js
git commit -m "feat(consultation): add header + input/search subtab dispatcher"
```

---

## Task 3: 입력 탭 (브리핑 + 신규 필드 입력폼)

**Files:**
- Modify: `consultation-card.js` (renderInputTab + renderInputForm 신규 필드 + onSaveConsultation 갱신)

- [ ] **Step 1: renderInputForm을 신규 필드 포함으로 교체**

기존 `function renderInputForm(studentId, readonly) { ... }` 전체를 교체:

```js
const TARGETS = ['학생', '학부모'];
const METHODS = ['전화', '문자', '대면', '기타'];

function renderInputForm(studentId, readonly) {
  const today = new Date().toISOString().slice(0, 10);
  const dis = readonly ? 'disabled' : '';
  const teacher = _deps.getCurrentTeacher?.() || { name: '?' };
  const student = _deps.getStudent?.(studentId) || {};
  const className = activeClassCodes(student, today).join(', ');
  const typeOpts = TYPES.map(t => `<option value="${t}">${t}</option>`).join('');
  const methodOpts = METHODS.map(m => `<option value="${m}">${m}</option>`).join('');
  const targetRadios = TARGETS.map((t, i) =>
    `<label class="consult-radio"><input type="radio" name="consult-target" value="${t}" ${i === 0 ? 'checked' : ''} ${dis}> ${t}</label>`
  ).join('');
  return `
    <div class="card consultation-input ${readonly ? 'readonly' : ''}">
      <h4>이번 상담 입력</h4>
      <div class="consult-meta-grid">
        <label>상담일 <input type="date" id="consult-date" value="${today}" ${dis}></label>
        <span class="consult-meta-field">입력일 <strong>저장 시 자동</strong></span>
        <span class="consult-meta-field">반명 <strong>${escapeHtml(className || '-')}</strong></span>
        <span class="consult-meta-field">학생명 <strong>${escapeHtml(student.name || '-')}</strong></span>
      </div>
      <div class="consult-row">
        <span class="consult-label">대상</span> ${targetRadios}
      </div>
      <div class="consult-row">
        <label>형태 <select id="consult-method" ${dis}>${methodOpts}</select></label>
        <label>유형 <select id="consult-type" ${dis}>${typeOpts}</select></label>
      </div>
      <textarea id="consult-text" rows="6" placeholder="상담 메모를 자유롭게 입력하세요" ${dis}></textarea>
      <div class="consult-row consult-actions">
        <button id="consult-save-btn" class="consult-save" onclick="onSaveConsultation('${escapeHtml(studentId)}')" ${dis}>저장</button>
        ${readonly ? '<span class="hint">READ-ONLY 모드</span>' : ''}
      </div>
    </div>
  `;
}
```

> `TYPES`(기존 정의)·`escapeHtml`(기존)·`activeClassCodes`(Task 2 import)는 그대로. `_deps.getStudent`는 student-detail.js에서 이미 주입됨(student-detail.js:403).

- [ ] **Step 2: renderInputTab 추가 (브리핑 + 입력폼)**

`renderConsultationHeader` 함수 아래에 추가:

```js
async function renderInputTab(studentId) {
  const body = document.getElementById('consult-subtab-body');
  if (!body) return;
  const readonly = _deps.readonly === true;
  body.innerHTML = `
    <div id="consult-briefing-slot"><em>브리핑 로딩 중…</em></div>
    ${renderInputForm(studentId, readonly)}
  `;
  const briefing = await getStudentBriefing(studentId).catch(() => null);
  const slot = document.getElementById('consult-briefing-slot');
  if (slot) slot.outerHTML = renderBriefingCard(briefing);
}
```

- [ ] **Step 3: onSaveConsultation을 신규 필드 + buildConsultationPayload로 교체**

기존 `window.onSaveConsultation = async function (studentId) { ... }` 전체를 교체:

```js
window.onSaveConsultation = async function (studentId) {
  const dateEl = document.getElementById('consult-date');
  const methodEl = document.getElementById('consult-method');
  const typeEl = document.getElementById('consult-type');
  const textEl = document.getElementById('consult-text');
  const btn = document.getElementById('consult-save-btn');
  const targetEl = document.querySelector('input[name="consult-target"]:checked');
  if (!dateEl.value || !textEl.value.trim()) {
    _deps.toast?.('상담일과 메모를 입력하세요', 'warn');
    return;
  }
  const student = _deps.getStudent?.(studentId);
  const teacher = _deps.getCurrentTeacher?.();
  if (!student || !teacher) {
    _deps.toast?.('학생/강사 정보 로드 실패', 'error');
    return;
  }
  btn.disabled = true;
  btn.textContent = '저장 중...';
  try {
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
    });
    await addConsultation(payload);
    _deps.toast?.('상담 저장됨', 'success');
    textEl.value = '';
  } catch (err) {
    console.error('[consultation] save failed:', err);
    _deps.toast?.(`저장 실패: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '저장';
  }
};
```

> 저장 후 이력 갱신은 조회 탭에서 보므로 입력 탭에서는 메모만 비운다(기존의 `.consultation-history` 재페치 제거 — 입력 탭엔 이력 카드 없음).

- [ ] **Step 4: 구문 검증**

Run: `node --check consultation-card.js`
Expected: 에러 없음

- [ ] **Step 5: Commit**

```bash
cd /Users/jongsooyi/IMPACT7/impact7newDSC
git add consultation-card.js
git commit -m "feat(consultation): input subtab with 대상/형태/반명 fields + briefing"
```

---

## Task 4: 조회 탭 (요약 + 검색 + 이력 배지)

**Files:**
- Modify: `consultation-card.js` (renderSearchTab + renderHistoryCard 배지)

- [ ] **Step 1: renderHistoryCard 배지에 형태·대상 추가**

기존 `function renderHistoryCard(consultations) { ... }`의 `<summary>` 내 배지 부분을 교체. 기존:

```js
        <span class="type-badge">${escapeHtml(c.consultation_type)}</span>
```

을 다음으로:

```js
        <span class="type-badge">${escapeHtml([c.consultation_type, c.method, c.target].filter(Boolean).join('·'))}</span>
```

> 구 데이터(method·target 없음)는 `filter(Boolean)`으로 빠지고 `consultation_type`만 표시.

- [ ] **Step 2: renderSearchTab 추가 (요약 + 검색 + 이력)**

`renderInputTab` 함수 아래에 추가:

```js
async function renderSearchTab(studentId) {
  const body = document.getElementById('consult-subtab-body');
  if (!body) return;
  body.innerHTML = `
    <div id="consult-summary-slot"><em>요약 로딩 중…</em></div>
    ${renderSearchBar(studentId)}
    <div id="consult-history-slot"><em>이력 로딩 중…</em></div>
  `;
  const [summary, history] = await Promise.allSettled([
    getStudentSummary(studentId),
    listStudentConsultations(studentId, DEFAULT_HISTORY_LIMIT),
  ]);
  const sumSlot = document.getElementById('consult-summary-slot');
  if (sumSlot) {
    sumSlot.outerHTML = summary.status === 'fulfilled'
      ? renderSummaryCard(summary.value)
      : `<div class="card"><h4>AI 누적 요약</h4><em>로드 실패</em></div>`;
  }
  const histSlot = document.getElementById('consult-history-slot');
  if (histSlot) {
    histSlot.outerHTML = history.status === 'fulfilled'
      ? renderHistoryCard(history.value)
      : `<div class="card consultation-history"><h4>상담 이력</h4><em>로드 실패</em></div>`;
  }
}
```

> `renderSearchBar`·`getSearchEls`·`replaceHistoryCard`·`onSearchConsultations`·`onResetConsultationSearch`(PR #1)는 그대로 유지·재사용. `getStudentSummary`·`listStudentConsultations`·`DEFAULT_HISTORY_LIMIT`·`renderSummaryCard`는 기존 import·정의.

- [ ] **Step 3: 구문 검증 + 테스트 회귀**

Run: `node --check consultation-card.js && npm test`
Expected: 구문 OK + 10건 PASS

- [ ] **Step 4: Commit**

```bash
cd /Users/jongsooyi/IMPACT7/impact7newDSC
git add consultation-card.js
git commit -m "feat(consultation): search subtab (요약+검색+이력 배지 형태·대상)"
```

---

## Task 5: daily-ops.css `.consultation-*` 스타일 (starbucks 톤)

**Files:**
- Modify: `daily-ops.css` (파일 끝에 추가)

- [ ] **Step 1: 스타일 블록 추가**

`daily-ops.css` 끝에 추가 (기존 변수 `--primary` `#00754A`, `--surface` `#f2f0eb`, `--border` `#e7e3db` 재사용):

```css
/* ── 상담 탭 redesign ─────────────────────────────── */
.consultation-header {
  display: flex; align-items: center; justify-content: space-between;
  background: #1E3932; color: #fff;
  padding: 10px 16px; border-radius: 12px 12px 0 0;
}
.consultation-header h3 { margin: 0; font-size: 1.05rem; }
.consultation-close {
  background: transparent; color: #fff; border: 1px solid rgba(255,255,255,.4);
  border-radius: 50px; padding: 4px 14px; cursor: pointer; font-size: .85rem;
}
.consultation-close:hover { background: rgba(255,255,255,.12); }
.consultation-subtabs {
  display: flex; gap: 4px; border-bottom: 1px solid var(--border, #e7e3db);
  background: var(--surface, #f2f0eb); padding: 6px 8px 0;
}
.consultation-subtab {
  background: transparent; border: none; padding: 8px 20px; cursor: pointer;
  font-size: .9rem; color: rgba(0,0,0,.58); border-bottom: 2px solid transparent;
}
.consultation-subtab.active { color: var(--primary, #00754A); border-bottom-color: var(--primary, #00754A); font-weight: 600; }
.consultation-input, .consultation-history, .consultation-summary, .consultation-briefing, .consultation-search {
  border: 1px solid var(--border, #e7e3db); border-radius: 12px; padding: 14px 16px;
  margin: 12px 0; background: #fff; box-shadow: 0 0 6px rgba(0,0,0,.06);
}
.consult-meta-grid {
  display: grid; grid-template-columns: 1fr 1fr; gap: 8px 16px; margin-bottom: 10px;
}
.consult-meta-field { font-size: .85rem; color: rgba(0,0,0,.58); }
.consult-meta-field strong { color: rgba(0,0,0,.87); }
.consult-row { display: flex; gap: 16px; align-items: center; margin: 8px 0; flex-wrap: wrap; }
.consult-label { font-size: .85rem; color: rgba(0,0,0,.58); }
.consult-radio { font-size: .9rem; cursor: pointer; }
.consult-actions { justify-content: flex-end; }
.consult-save {
  background: var(--primary, #00754A); color: #fff; border: none;
  border-radius: 50px; padding: 8px 28px; cursor: pointer; font-size: .9rem;
}
.consult-save:active { transform: scale(.97); }
.consult-save:disabled { opacity: .5; cursor: default; }
.type-badge {
  display: inline-block; background: #d4e9e2; color: #1E3932;
  border-radius: 50px; padding: 1px 10px; font-size: .78rem; margin: 0 4px;
}
```

- [ ] **Step 2: 빌드 확인**

Run: `npm run build`
Expected: 성공, CSS 번들에 `.consultation-` 포함

- [ ] **Step 3: Commit**

```bash
cd /Users/jongsooyi/IMPACT7/impact7newDSC
git add daily-ops.css
git commit -m "style(consultation): starbucks-tone tab/subtab/form/badge styles"
```

---

## Task 6: 빌드 + 검증 + simplify/review + PR

**Files:** 없음 (검증·PR)

- [ ] **Step 1: 단위 테스트 + 빌드**

Run: `npm test && npm run build`
Expected: 10건 PASS + 빌드 성공

- [ ] **Step 2: simplify + review (메모리 워크플로우)**

코드 변경(consultation-card.js·consultation-payload.js)에 대해 `simplify` → `review` 스킬 순차 실행. 결과 수정 시 follow-up commit.

- [ ] **Step 3: 브라우저 수동 검증 (가능 시; 불가 시 명시)**

`npm run dev` → 학생 상세 [상담] 탭:
- [ ] 헤더 × 닫기 → 일일현황 탭 전환
- [ ] 입력↔조회 서브탭 전환
- [ ] 입력: 반명·학생명 자동 표시, 대상 라디오·형태·유형 선택, 메모 → 저장 → Firestore에 target·method·class_name 포함 확인
- [ ] 조회: 요약 + 검색(PR#1) + 이력 배지 `[유형·형태·대상]`
- [ ] READ_ONLY 모드 입력 disabled

> dev/브라우저 검증 불가 환경이면 그 사실을 사용자에게 명시하고 test+build+node --check 결과로만 보고.

- [ ] **Step 4: PR 생성**

```bash
cd /Users/jongsooyi/IMPACT7/impact7newDSC
git push -u origin feat/consultation-tab-redesign
```

그 다음 `gh pr create`로 PR 생성. body는 다음 요소를 포함해 executing 시점에 작성:
- Summary: 헤더(닫기)+입력/조회 서브탭, 입력 신규 필드(대상·형태·반명), starbucks redesign, 스키마 신규 3필드(rules 무변경)
- 변경 파일: consultation-payload.js(신규), consultation-card.js, daily-ops.css, package.json
- 검증: node:test 10건 + npm run build + (브라우저 수동 또는 미검증 명시)
- Test plan: Step 3의 브라우저 체크리스트
- Spec/Plan 경로
- 후속(범위 외): 퇴원생 UI, Excel import

---

## 검증 요약 체크리스트

- [ ] **Task 1**: buildConsultationPayload + node:test 10건(7+3) PASS
- [ ] **Task 2**: 헤더 + 서브탭 디스패처 + onConsultationSubtab + 닫기
- [ ] **Task 3**: 입력 탭 (대상·형태·반명·학생명·입력일 + 브리핑) + buildConsultationPayload 저장
- [ ] **Task 4**: 조회 탭 (요약 + 검색 PR#1 + 이력 배지 형태·대상)
- [ ] **Task 5**: daily-ops.css starbucks 톤 스타일
- [ ] **Task 6**: test+build + simplify/review + 브라우저 + PR

## 범위 외 (spec 12절)
- 퇴원생 상담 UI, Excel import, tagger/trends의 target·method 활용, AI markdown starbucks HTML 렌더

## 참고
- Spec: `docs/superpowers/specs/2026-05-20-consultation-tab-redesign-design.md`
- 닫기: `switchDetailTab('daily')` 전역 (index.html:240 패턴)
- 반명: `activeClassCodes(student, date)` (student-helpers.js:77)
- addConsultation spread → 신규 필드 자동 (data-layer.js:810), rules hasAll → 변경 없음 (impact7DB firestore.rules:1024)
