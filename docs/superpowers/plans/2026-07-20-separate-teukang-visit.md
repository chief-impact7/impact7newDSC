# 같은 날 정규+특강 분리 등원 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 같은 날 정규+특강 별도 등원 학생의 특강 출결을 `daily_records.visit2`로 기록하고, 리스트에 이른 시간 우선 표시 + 출결 2줄 UI + 수업종류 태그 시각 구분을 추가한다.

**Architecture:** 순수 판정 함수(student-core.js) → state 래퍼(student-helpers.js) → UI(list-view.js)·저장(attendance.js). 기존 `attendance`/`arrival_time`(주 출결) 의미 불변, `visit2`는 additive 필드. 스펙: `docs/superpowers/specs/2026-07-20-separate-teukang-visit-design.md`.

**Tech Stack:** 바닐라 JS 멀티페이지(Vite), node:test, Firestore(rules 수정 불필요 — daily_records는 `withinFieldLimit(30)`, students enrollment 서브필드 제약 없음).

## Global Constraints

- 주 출결 = 대표 enrollment(내신>자유>특강만>비정규>정규). 시간순 아님.
- visit2는 등원시간 화면 전용 — filter-nav 카운트·parent-message·data-layer 통계·export-report·absence 경로는 절대 수정하지 않는다.
- `SEPARATE_VISIT_GAP_MIN = 180`(분). auto 판정 기준.
- 커밋은 사용자 요청 시에만(프로젝트 규칙). 태스크별 commit 없음 — 전체 완료 후 `/simplify` → `/code-review` → 사용자 승인 후 1커밋.
- 이모지 아이콘 금지, 기존 코드 스타일(주석 최소) 준수.

---

### Task 1: 분리 등원 판정 순수 함수

**Files:**
- Modify: `student-core.js` (파일 끝에 추가)
- Test: `student-core.test.js` (파일 끝에 추가)

**Interfaces:**
- Produces: `findSeparateTeukangVisit(dayEnrollments, getTime)` → `{ enrollment, time } | null`, `SEPARATE_VISIT_GAP_MIN = 180`. `dayEnrollments`는 이미 요일 필터된 활성 enrollment 배열, `getTime(e)` → `'HH:MM'` 또는 `''`.

- [ ] **Step 1: 실패하는 테스트 작성** — `student-core.test.js` 끝에 추가, import 목록에 `findSeparateTeukangVisit` 추가

```js
// ─── findSeparateTeukangVisit ────────────────────────────────────────────────

const _reg = { class_type: '정규', level_symbol: 'HA', class_number: '103' };
const _tk = (over = {}) => ({ class_type: '특강', class_number: 'T1', ...over });
const _times = (map) => (e) => map[e.class_type === '특강' ? 'tk' : 'reg'] ?? '';

test('findSeparateTeukangVisit: 간격 3시간 이상 → 분리', () => {
    const r = findSeparateTeukangVisit([_reg, _tk()], _times({ reg: '19:10', tk: '12:30' }));
    assert.equal(r.time, '12:30');
    assert.equal(r.enrollment.class_type, '특강');
});

test('findSeparateTeukangVisit: 간격 3시간 미만 → 통합(null)', () => {
    assert.equal(findSeparateTeukangVisit([_reg, _tk()], _times({ reg: '19:10', tk: '17:30' })), null);
});

test('findSeparateTeukangVisit: 경계 — 정확히 180분이면 분리, 179분이면 통합', () => {
    assert.ok(findSeparateTeukangVisit([_reg, _tk()], _times({ reg: '19:10', tk: '16:10' })));
    assert.equal(findSeparateTeukangVisit([_reg, _tk()], _times({ reg: '19:10', tk: '16:11' })), null);
});

test('findSeparateTeukangVisit: visit_mode=separate → 간격 무관 분리', () => {
    const r = findSeparateTeukangVisit([_reg, _tk({ visit_mode: 'separate' })], _times({ reg: '19:10', tk: '18:00' }));
    assert.equal(r.time, '18:00');
});

test('findSeparateTeukangVisit: visit_mode=combined → 간격 무관 통합', () => {
    assert.equal(findSeparateTeukangVisit([_reg, _tk({ visit_mode: 'combined' })], _times({ reg: '19:10', tk: '12:30' })), null);
});

test('findSeparateTeukangVisit: 특강만 있는 날(주=특강) → null', () => {
    assert.equal(findSeparateTeukangVisit([_tk()], _times({ tk: '12:30' })), null);
});

test('findSeparateTeukangVisit: 시간 없는 특강은 auto 판정 불가 → null', () => {
    assert.equal(findSeparateTeukangVisit([_reg, _tk()], _times({ reg: '19:10', tk: '' })), null);
});

test('findSeparateTeukangVisit: 내신도 주 수업으로 취급', () => {
    const naesin = { class_type: '내신', level_symbol: 'HA', class_number: '103' };
    const r = findSeparateTeukangVisit([naesin, _tk()], _times({ reg: '19:10', tk: '12:30' }));
    assert.equal(r.time, '12:30');
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `node --test student-core.test.js`
Expected: FAIL — `findSeparateTeukangVisit is not a function` (또는 import 에러)

- [ ] **Step 3: 구현** — `student-core.js` 끝에 추가

```js
// ─── 분리 등원 특강 판정 ─────────────────────────────────────────────────────
// 같은 날 주 수업(정규/내신/자유)과 특강이 모두 있을 때, 특강이 "별도 등원"인지 판정.
// visit_mode(수동 override) 우선, 없으면 시작 시간 간격 ≥ 180분으로 자동 판정.
export const SEPARATE_VISIT_GAP_MIN = 180;

function timeToMinutes(t) {
    const m = /^(\d{1,2}):(\d{2})/.exec(t || '');
    return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

export function findSeparateTeukangVisit(dayEnrollments, getTime) {
    const main = dayEnrollments.find(e => (e.class_type || '정규') !== '특강');
    if (!main) return null;
    const mainMin = timeToMinutes(getTime(main));
    for (const e of dayEnrollments) {
        if ((e.class_type || '정규') !== '특강') continue;
        if (e.visit_mode === 'combined') continue;
        const time = getTime(e);
        if (!time) continue;
        if (e.visit_mode === 'separate') return { enrollment: e, time };
        const tMin = timeToMinutes(time);
        if (mainMin !== null && tMin !== null && Math.abs(tMin - mainMin) >= SEPARATE_VISIT_GAP_MIN) {
            return { enrollment: e, time };
        }
    }
    return null;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `node --test student-core.test.js`
Expected: 신규 8개 포함 전부 PASS

### Task 2: state 래퍼

**Files:**
- Modify: `student-helpers.js` (`getStudentStartTime` 함수 아래, :205 부근)

**Interfaces:**
- Consumes: Task 1의 `findSeparateTeukangVisit`
- Produces: `getSeparateTeukangVisit(s, dateStr)` → `{ enrollment, time } | null`

- [ ] **Step 1: 구현** — student-helpers.js의 `./student-core.js` import 목록에 `findSeparateTeukangVisit`, `normalizeDays` 추가(이미 있으면 유지) 후:

```js
export function getSeparateTeukangVisit(s, dateStr) {
    const date = dateStr || todayStr();
    const dayName = getDayName(date);
    const dayEnrolls = getActiveEnrollments(s, date).filter(e => normalizeDays(e.day).includes(dayName));
    return findSeparateTeukangVisit(dayEnrolls, (e) => getStudentStartTime(e, dayName));
}
```

- [ ] **Step 2: 빌드 확인**

Run: `npm run build`
Expected: 성공 (bare identifier 누락 없음 — 모듈분리 회귀 클래스 방지)

### Task 3: 이른 시간 우선 (정렬 + 예정 표시)

**Files:**
- Modify: `list-view.js:72-79` (`getEffectiveAttendanceTime`), `list-view.js:710-724` (시간 블록 예정 시간)

**Interfaces:**
- Consumes: `getSeparateTeukangVisit`(list-view.js에서 `./student-helpers.js` import에 추가)

- [ ] **Step 1: 정렬 시간 수정** — `getEffectiveAttendanceTime`의 `find` 한 건 → 요일 매칭 전체 최소값

```js
export function getEffectiveAttendanceTime(s, date, dayName) {
    const times = [];
    for (const e of getActiveEnrollments(s, date)) {
        if (!(e.day || []).includes(dayName)) continue;
        const t = getStudentStartTime(e, dayName);
        if (t) times.push(t);
    }
    times.push(...collectVisitTimes(s, date));
    return times.length === 0 ? '99:99' : times.sort()[0];
}
```

- [ ] **Step 2: 예정 시간 수정** — :714 `todayEnroll`/`scheduledTime` 계산 교체. 학생 루프 상단(:520 `isLeave` 직후)에 판정 1회. **주의: 래퍼(`getSeparateTeukangVisit`)를 쓰면 `getActiveEnrollments` 재호출로 enrollment 객체 참조가 `_todayEnrolls`와 달라져 아래 `e !== sepVisit?.enrollment` 제외 필터가 깨진다. 리스트 루프에서는 순수 함수를 `_todayEnrolls`로 직접 호출해 참조 동일성을 보장한다** (list-view.js import: `findSeparateTeukangVisit`은 `./student-core.js`에서):

```js
const sepVisit = isLeave ? null : findSeparateTeukangVisit(_todayEnrolls, (e) => getStudentStartTime(e, dayN));
```

기존(:714, :719):
```js
const todayEnroll = getActiveEnrollments(s, state.selectedDate).find(e => e.day.includes(dayName));
...
let scheduledTime = getStudentStartTime(todayEnroll, dayName);
```
교체(분리 특강 제외한 매칭 enrollment 중 최소 시간 — 1회 등원 학생은 이른 시간이 예정으로 뜸):
```js
const mainEnrolls = _todayEnrolls.filter(e => e !== sepVisit?.enrollment);
...
let scheduledTime = mainEnrolls.map(e => getStudentStartTime(e, dayName)).filter(Boolean).sort()[0] || '';
```
(`_todayEnrolls`는 :508에 이미 존재. `todayEnroll` 변수는 이 두 곳 외 사용처 없음 — 제거.)

- [ ] **Step 3: 빌드 + 육안 확인**

Run: `npm run build` 후 READ-ONLY dev(`npm run dev`)로 확인.
Expected: 1회 등원(정규+근접 특강) 학생 '예정'이 이른 시간으로 표시, 리스트 정렬도 이른 시간 기준.

### Task 4: visit2 저장 로직

**Files:**
- Modify: `attendance.js` (`applyAttendance` 아래), `app.js:786` 부근(window 바인딩)

**Interfaces:**
- Consumes: `getSeparateTeukangVisit`, `saveImmediately(studentId, updates)`, `nowTimeStr`, `renderListPanel`(initAttendanceDeps 주입 — 기존)
- Produces: `toggleVisit2Attendance(studentId, displayStatus)` — 전역(window) 노출. `visit2 = { code, scheduled_time, status, arrival_time }` 저장.

- [ ] **Step 1: 구현** — attendance.js. import에 `getSeparateTeukangVisit`, `enrollmentCode`, `findStudent` 추가(기존 import 경로 `./student-helpers.js`·`./student-core.js` 확인):

```js
// 분리 등원 특강 보조 출결. 주 출결(attendance/arrival_time)과 독립 —
// 통계·알림·보고서 소비처는 visit2를 읽지 않는다(스펙 확정).
export function toggleVisit2Attendance(studentId, displayStatus) {
    const firestoreStatus = displayStatus === '특강' ? '미확인' : displayStatus;
    const rec = state.dailyRecords[studentId] || {};
    const currentStatus = rec.visit2?.status || '미확인';
    const newStatus = currentStatus === firestoreStatus ? '미확인' : firestoreStatus;

    const sv = getSeparateTeukangVisit(findStudent(studentId), state.selectedDate);
    const visit2 = {
        ...(rec.visit2 || {}),
        status: newStatus,
        code: (sv ? enrollmentCode(sv.enrollment) : rec.visit2?.code) || '',
        scheduled_time: (sv ? sv.time : rec.visit2?.scheduled_time) || '',
    };
    if (newStatus === '출석' || newStatus === '지각') {
        if (!visit2.arrival_time) visit2.arrival_time = nowTimeStr();
    } else if (newStatus === '미확인') {
        visit2.arrival_time = '';
    }
    return saveImmediately(studentId, { visit2 }).then(() => renderListPanel());
}
```

- [ ] **Step 2: 전역 바인딩** — app.js `window.toggleAttendance = toggleAttendance;`(:786) 옆에:

```js
window.toggleVisit2Attendance = toggleVisit2Attendance;
```
app.js의 attendance.js import 목록(:95 부근)에 `toggleVisit2Attendance` 추가.

- [ ] **Step 3: 빌드 확인**

Run: `npm run build`
Expected: 성공

### Task 5: 리스트 행 — 시간 블록 2개 + 출결 2줄

**Files:**
- Modify: `list-view.js` 출결 토글 분기(:528-556)와 시간 블록(:715-750)

**Interfaces:**
- Consumes: Task 3의 `sepVisit`(학생 루프 스코프), Task 4의 `window.toggleVisit2Attendance`

- [ ] **Step 1: 시간 블록** — 기존 timeHtml 조립(:731-749)을 블록 배열+시간순 정렬로 교체. 기존 주 블록·보충(`uniqueBonusTimes`) 로직 유지, visit2 블록 추가:

```js
let timeLabel = '', timeValue = '', timeClass = '';
if (arrivalTime) {
    timeLabel = '등원'; timeValue = formatTime12h(arrivalTime); timeClass = 'arrived';
} else if (scheduledTime) {
    timeLabel = '예정'; timeValue = formatTime12h(scheduledTime);
} else if (_todayEnrolls.length === 0 && isVisitStudent(s.docId)) {
    timeLabel = '예정'; timeValue = '(미정)'; timeClass = 'time-unset';
}
const timeBlocks = [];
if (timeValue) timeBlocks.push({ sort: scheduledTime || arrivalTime || '99:99', html: `<div class="item-time-block ${timeClass}">
    <span class="item-time-label">${timeLabel}</span>
    <span class="item-time-value">${esc(timeValue)}</span>
</div>` });
if (sepVisit) {
    const v2 = rec?.visit2;
    const v2Arrived = !!v2?.arrival_time;
    timeBlocks.push({ sort: sepVisit.time, html: `<div class="item-time-block ${v2Arrived ? 'arrived' : ''}">
    <span class="item-time-label">${v2Arrived ? '등원' : '예정'}</span>
    <span class="item-time-value">${esc(formatTime12h(v2Arrived ? v2.arrival_time : sepVisit.time))}</span>
</div>` });
}
timeBlocks.sort((a, b) => a.sort.localeCompare(b.sort));
timeHtml = [
    ...timeBlocks.map(b => b.html),
    ...uniqueBonusTimes.map(t => `<div class="item-time-block" style="color:var(--danger);">
        <span class="item-time-label" style="color:var(--danger);">보충</span>
        <span class="item-time-value" style="color:var(--danger);">${esc(formatTime12h(t))}</span>
    </div>`)
].join('');
```
(보충 필터도 visit2 시간 중복 제거: `.filter(t => t !== scheduledTime && t !== sepVisit?.time)`)

- [ ] **Step 2: 출결 2줄** — attendance 분기(:543-556)의 기존 `toggle-group` 생성 뒤에 추가. 버튼 마크업은 기존 statuses.map과 동일 구조(클래스·aria-pressed 동일), onclick만 `toggleVisit2Attendance`:

```js
if (sepVisit) {
    const v2Status = rec?.visit2?.status || '미확인';
    const v2Display = v2Status === '미확인' ? '특강' : v2Status;
    const v2Row = `<div class="toggle-group">` +
        ['특강', '출석', '지각', '결석', '조퇴', '기타'].map(st => {
            const classes = ['toggle-btn'];
            if (st === '특강') classes.push('type-tag', `default-tone-${DEFAULT_TONE['특강']}`);
            if (st === v2Display) {
                if (st === '출석') classes.push('active-present');
                else if (st === '결석') classes.push('active-absent');
                else if (st === '지각') classes.push('active-late');
                else if (st === '특강') classes.push('active-default');
                else classes.push('active-other');
            }
            return `<button class="${classes.join(' ')}" aria-pressed="${st === v2Display}" onclick="event.stopPropagation(); toggleVisit2Attendance('${escAttr(s.docId)}', '${st}')">${st}</button>`;
        }).join('') + `</div>`;
    // 시간순: 특강이 이르면 특강 줄을 위로
    toggleHtml = sepVisit.time < (scheduledTime || '99:99') ? v2Row + toggleHtml : toggleHtml + v2Row;
}
```
주의: `scheduledTime`은 Task 3에서 시간 블록 계산에 쓰는 값 — 출결 분기(:528)보다 아래에서 계산된다. 구현 시 `scheduledTime` 계산을 출결 분기 이전(sepVisit 계산 직후)으로 끌어올려 두 곳에서 재사용한다.

- [ ] **Step 3: 확인**

Run: `npm run dev` (READ-ONLY) — 분리 등원 학생(예: 임현준) 행에서 12:30 특강 줄이 위, 19:10 정규 줄이 아래, 시간 블록 2개 표시. 1회 등원 학생은 기존 1줄.

### Task 6: 수업종류 태그 시각 구분

**Files:**
- Modify: `list-view.js:546` (주 출결 줄 defaultLabel 버튼에 `type-tag` 클래스), `daily-ops.css:885` 부근

- [ ] **Step 1: 클래스 부여** — :546 교체:

```js
if (st === defaultLabel) classes.push('type-tag', `default-tone-${DEFAULT_TONE[defaultLabel]}`);
```

- [ ] **Step 2: CSS** — daily-ops.css `default-tone` 블록(:886) 위에 추가:

```css
/* 수업종류(첫 버튼)는 출결 pill과 형태로 구분 — 사각 태그 + 작은 크기.
   클릭(미확인 리셋) 동작은 유지하므로 button 그대로, 시각만 분리. */
.toggle-btn.type-tag {
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 10px;
  font-weight: 700;
}
```

- [ ] **Step 3: 확인**

Run: `npm run dev` — 모든 행에서 수업종류(정규/특강/내신/자유/비정규)가 사각 태그, 출결 5개는 pill. 클릭 시 미확인 리셋 동작 유지.

### Task 7: enrollment 모달 visit_mode

**Files:**
- Modify: `index.html:514-520` (수업종류 필드 아래), `modals.js` (`openEnrollmentModal` :284, `saveEnrollment` :330 부근)

- [ ] **Step 1: HTML** — 수업종류 form-field 아래 추가:

```html
<div class="form-field" id="enroll-visit-mode-field" style="display:none;">
    <label class="field-label">등원 방식 (같은 날 정규와 함께일 때)</label>
    <select id="enroll-visit-mode" class="field-input">
        <option value="">자동 (시간 간격 3시간 이상이면 별도 등원)</option>
        <option value="combined">통합 등원 (한 번 등원)</option>
        <option value="separate">별도 등원 (출결 따로)</option>
    </select>
</div>
```

- [ ] **Step 2: 모달 로드/토글** — `openEnrollmentModal`에서 기존 `syncEndDisabled` 회로에 visit_mode 필드 표시 연동:

```js
document.getElementById('enroll-visit-mode').value = enroll.visit_mode || '';
const visitModeField = document.getElementById('enroll-visit-mode-field');
const syncEndDisabled = () => {
    const isRegular = typeEl.value === '정규';
    endEl.disabled = isRegular;
    if (isRegular) endEl.value = '';
    visitModeField.style.display = isRegular ? 'none' : '';
};
```

- [ ] **Step 3: 저장** — `saveEnrollment`의 `updated` 조립 뒤에:

```js
const visitMode = document.getElementById('enroll-visit-mode').value;
if (classType === '특강' && visitMode) updated.visit_mode = visitMode;
else delete updated.visit_mode;
```

- [ ] **Step 4: 확인**

Run: `npm run dev` — 특강 enrollment 편집 시 셀렉트 표시, 정규 선택 시 숨김. 저장 후 재오픈 시 값 유지(READ-ONLY 모드에선 저장 stub — emulator 또는 코드 리뷰로 확인).

### Task 8: 전체 검증

- [ ] **Step 1: 테스트 전체**

Run: `npm test`
Expected: node:test + vitest 전부 PASS

- [ ] **Step 2: 빌드**

Run: `npm run build`
Expected: 성공. dist bare-심볼 회귀 없음.

- [ ] **Step 3: 화면 검증 (READ-ONLY dev)**

- 분리 등원 학생: 시간 블록 2개(이른 시간 위) + 출결 2줄(시간순), 특강 줄 클릭 시 콘솔 stub 로그.
- 1회 등원(근접 특강) 학생: 1줄, 예정=이른 시간.
- 특강만/정규만/내신 학생: 기존과 동일 1줄.
- 수업종류 태그 사각형 구분 전 행 적용.

- [ ] **Step 4: 품질 게이트** — `/simplify` → `/code-review` 실행·반영 후 사용자에게 커밋 여부 확인 (자동 커밋 금지).
