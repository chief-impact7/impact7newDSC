# 내신 반 관리 시스템 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** DSC에 내신(학교+학년 기반) 반 관리 시스템을 추가하여 L2 필터, 학생 리스트, 전용 상세패널을 제공한다.

**Architecture:** `naesin.js` 신규 모듈을 생성하고, `daily-ops.js`에는 L2 필터 분기와 getStudentStartTime() 수정만 추가한다. 공통 함수는 `window.*`로 접근한다.

**Tech Stack:** Vanilla JS (ES Modules), Vite, Firebase Firestore

**Spec:** `docs/superpowers/specs/2026-04-02-naesin-management-design.md`

---

## 파일 구조

| 파일 | 역할 | 변경 |
|------|------|------|
| `naesin.js` | 내신 리스트, 상세패널, 메모, 반 설정 | 🆕 신규 |
| `daily-ops.js` | L2 필터에 내신 추가, renderListPanel/renderStudentDetail 분기, getStudentStartTime 수정 | ✏️ 수정 |
| `firestore.rules` | class_settings allowed fields에 naesin_start/naesin_end/schedule 추가 | ✏️ 수정 |

---

### Task 1: Firestore Rules 업데이트

**Files:**
- Modify: `firestore.rules:327-331`

- [ ] **Step 1: class_settings 허용 필드에 내신 필드 추가**

`firestore.rules`의 `hasOnlyAllowedClassSettingsFields()`를 수정:

```js
function hasOnlyAllowedClassSettingsFields() {
    return request.resource.data.keys().hasOnly([
        'domains', 'test_sections', 'teacher', 'sub_teacher',
        'default_time', 'default_time_updated_by', 'default_time_updated_at',
        'naesin_start', 'naesin_end', 'schedule'
    ]);
}
```

- [ ] **Step 2: rules 파일 3개 프로젝트에 동기화**

```bash
cp firestore.rules ~/projects/impact7DB/firestore.rules
cp firestore.rules ~/projects/impact7HR/firestore.rules
cp firestore.rules ~/projects/impact7exam/firestore.rules
```

- [ ] **Step 3: rules 배포 (impact7DB에서)**

```bash
cd ~/projects/impact7DB && firebase deploy --only firestore:rules --project impact7db
```

- [ ] **Step 4: 커밋**

```bash
git add firestore.rules
git commit -m "feat: class_settings에 내신 필드(naesin_start, naesin_end, schedule) 허용"
```

---

### Task 2: getStudentStartTime() 요일별 시간 지원

**Files:**
- Modify: `daily-ops.js:245-249`

- [ ] **Step 1: getStudentStartTime에 dayName 파라미터 추가**

`daily-ops.js`의 `getStudentStartTime()` 수정:

```js
// 학생 등원시간: 개별 시간 → 반 기본 시간 fallback
function getStudentStartTime(enrollment, dayName) {
    if (!enrollment) return '';
    // 내신: 요일별 schedule 조회
    if (dayName && enrollment.schedule) {
        const studentTime = enrollment.schedule[dayName];
        if (studentTime) return studentTime;
    }
    if (dayName) {
        const classSchedule = classSettings[enrollmentCode(enrollment)]?.schedule;
        if (classSchedule && classSchedule[dayName]) return classSchedule[dayName];
    }
    // 정규: 기존 fallback
    return enrollment.start_time || enrollment.time || classSettings[enrollmentCode(enrollment)]?.default_time || '';
}
```

- [ ] **Step 2: 검증 — 기존 정규 호출에 영향 없는지 확인**

dayName 없이 호출하는 기존 코드 검색:
```bash
grep -n "getStudentStartTime" daily-ops.js
```
기존 호출은 `getStudentStartTime(enrollment)` 형태이므로 dayName이 undefined → 기존 fallback 동작 유지.

- [ ] **Step 3: 커밋**

```bash
git add daily-ops.js
git commit -m "feat: getStudentStartTime에 요일별 schedule 조회 지원"
```

---

### Task 3: naesin.js 기본 구조 + 내신 학생 필터링

**Files:**
- Create: `naesin.js`

- [ ] **Step 1: naesin.js 파일 생성 — 기본 import + 내신 학생 추출 함수**

```js
// naesin.js — 내신 반 관리 모듈
import { db } from './firebase-config.js';
import { enrollmentCode, getActiveEnrollments, branchFromStudent, getDayName } from './app.js';

// daily-ops.js에서 window로 노출된 공통 변수/함수 접근
const _get = (name) => window[name];

// 내신 활성 학생 추출 (선택 날짜 기준)
function getNaesinStudents() {
    const allStudents = _get('allStudents') || [];
    const selectedDate = _get('selectedDate') || '';
    const dayName = getDayName(selectedDate);
    const selectedBranch = _get('selectedBranch');

    const results = [];
    allStudents.forEach(s => {
        if (s.status === '퇴원') return;
        if (selectedBranch && branchFromStudent(s) !== selectedBranch) return;

        const activeEnrolls = getActiveEnrollments(s, selectedDate);
        activeEnrolls.forEach((e, idx) => {
            if (e.class_type !== '내신') return;
            if (!e.day || !e.day.includes(dayName)) return;
            results.push({ student: s, enrollment: e, enrollIdx: idx });
        });
    });
    return results;
}

// 내신 반 목록 추출 (학교+학년별 그룹)
function getNaesinClasses() {
    const students = getNaesinStudents();
    const classMap = new Map();
    students.forEach(({ student, enrollment }) => {
        const code = enrollmentCode(enrollment);
        if (!classMap.has(code)) classMap.set(code, { code, count: 0 });
        classMap.get(code).count++;
    });
    return [...classMap.values()].sort((a, b) => b.count - a.count);
}

export { getNaesinStudents, getNaesinClasses };
```

- [ ] **Step 2: app.js에서 getDayName이 export되는지 확인, 안 되면 추가**

```bash
grep -n "export.*getDayName\|function getDayName" app.js
```

getDayName이 app.js에 있고 export 안 되어 있으면 export 추가. daily-ops.js에 있으면 window 접근으로 대체.

- [ ] **Step 3: 커밋**

```bash
git add naesin.js app.js
git commit -m "feat: naesin.js 기본 구조 — 내신 학생/반 필터링 함수"
```

---

### Task 4: L2 필터에 "내신" 추가 + renderListPanel 분기

**Files:**
- Modify: `daily-ops.js:1089-1127` (renderSubFilters의 filters 객체)
- Modify: `daily-ops.js:2921-2960` (renderListPanel 함수)
- Modify: `naesin.js`

- [ ] **Step 1: daily-ops.js의 filters 객체에 내신 추가**

`daily-ops.js:1092`의 attendance 배열에 추가:

```js
attendance: [
    { key: 'scheduled_visit', label: '비정규', children: [
        { key: 'sv_absence_makeup', label: '결석보충' },
        { key: 'sv_clinic', label: '클리닉' },
        { key: 'sv_diagnostic', label: '진단평가' },
        { key: 'sv_fail', label: '미통과' }
    ]},
    { key: 'pre_arrival', label: '정규', children: [
        { key: 'enroll_pending', label: '등원예정' },
        { key: 'present', label: '출석' },
        { key: 'late', label: '지각' },
        { key: 'absent', label: '결석' },
        { key: 'other', label: '기타' },
        { key: 'departure_check', label: '귀가점검' }
    ]},
    { key: 'naesin', label: '내신' }
],
```

- [ ] **Step 2: getClassMgmtCount()에 naesin 카운트 추가**

`getClassMgmtCount` 함수에서 `filterKey === 'naesin'` 분기 추가:

```js
case 'naesin': {
    const naesinStudents = window._getNaesinStudents ? window._getNaesinStudents() : [];
    return { count: naesinStudents.length, total: naesinStudents.length };
}
```

- [ ] **Step 3: renderListPanel()에 내신 분기 추가**

`daily-ops.js`의 `renderListPanel()` 상단에 추가 (비정규 분기 아래):

```js
// 내신 서브필터 활성 시 내신 리스트로 전환
if (currentCategory === 'attendance' && currentSubFilter.has('naesin')) {
    if (window.renderNaesinList) window.renderNaesinList();
    return;
}
```

- [ ] **Step 4: naesin.js에 renderNaesinList() 구현**

내신 학생 리스트를 렌더링하는 함수. L3 반 칩 + 학생 카드 목록:

```js
function renderNaesinList() {
    const container = document.getElementById('list-panel');
    const classes = getNaesinClasses();
    const selectedNaesinClass = window._selectedNaesinClass || null;
    const dayName = getDayName(window.selectedDate || '');
    const classSettingsMap = window.classSettings || {};

    let students = getNaesinStudents();
    if (selectedNaesinClass) {
        students = students.filter(({ enrollment }) =>
            enrollmentCode(enrollment) === selectedNaesinClass
        );
    }

    // L3 반 칩
    const chipsHtml = classes.map(c => {
        const active = selectedNaesinClass === c.code ? 'active' : '';
        return `<div class="nav-l2 ${active}" onclick="window.setNaesinClass('${c.code}')">${c.code}<span class="nav-l2-count">${c.count}</span></div>`;
    }).join('');

    // 반 담당 정보
    const classInfo = selectedNaesinClass ? classSettingsMap[selectedNaesinClass] : null;
    const teacherDisplay = classInfo?.teacher ? classInfo.teacher.split('@')[0] : '';

    // 학생 리스트
    const listHtml = students.map(({ student, enrollment }) => {
        const time = window.getStudentStartTime(enrollment, dayName);
        const rec = (window.dailyRecords || {})[student.docId] || {};
        const attStatus = rec?.attendance?.status || '미확인';
        const { display, cls } = window._attToggleClass ? window._attToggleClass(attStatus) : { display: attStatus, cls: '' };

        return `<div class="list-item" onclick="window.renderStudentDetail('${student.docId}')">
            <span class="student-name">${student.name}</span>
            ${time ? `<span class="item-time">${time}</span>` : ''}
            <button class="toggle-btn ${cls}" style="min-width:48px;"
                onclick="event.stopPropagation(); window.toggleAttendance('${student.docId}', '${display}')">${display}</button>
        </div>`;
    }).join('');

    container.innerHTML = `
        <div class="nav-l3-row" style="padding:8px 12px;display:flex;gap:4px;flex-wrap:wrap;">${chipsHtml}</div>
        ${selectedNaesinClass && teacherDisplay ? `<div style="padding:4px 16px;font-size:11px;color:var(--text-sec);">담당: ${teacherDisplay}</div>` : ''}
        <div class="list-content">${listHtml || '<div style="padding:24px;text-align:center;color:var(--text-sec);font-size:13px;">내신 학생이 없습니다</div>'}</div>
    `;
}

window.renderNaesinList = renderNaesinList;
window._getNaesinStudents = getNaesinStudents;

window.setNaesinClass = function(code) {
    window._selectedNaesinClass = window._selectedNaesinClass === code ? null : code;
    renderNaesinList();
};
```

- [ ] **Step 5: daily-ops.js에서 naesin.js import**

`daily-ops.js` 상단 import 블록에 추가:

```js
import './naesin.js';
```

- [ ] **Step 6: 검증 — dev 서버에서 L2 "내신" 클릭 시 반 칩 + 학생 목록 표시 확인**

```bash
npm run dev
```
브라우저에서 출결 > 내신 클릭 → L3에 학교+학년 반 칩 표시, 학생 목록 표시 확인.

- [ ] **Step 7: 커밋**

```bash
git add daily-ops.js naesin.js
git commit -m "feat: L2 내신 필터 + 내신 학생 리스트 렌더링"
```

---

### Task 5: 내신 학생 상세패널 — 출결 + 등원요일/시간

**Files:**
- Modify: `naesin.js`
- Modify: `daily-ops.js:6490-6510` (renderStudentDetail 분기)

- [ ] **Step 1: daily-ops.js renderStudentDetail()에 내신 분기 추가**

`daily-ops.js:6509` 뒤 (student 조회 후)에 추가:

```js
// 내신 모드: naesin.js로 위임
if (currentCategory === 'attendance' && currentSubFilter.has('naesin')) {
    if (window.renderNaesinDetail) {
        window.renderNaesinDetail(studentId);
        return;
    }
}
```

- [ ] **Step 2: naesin.js에 renderNaesinDetail() 구현 — 출결 카드**

```js
function renderNaesinDetail(studentId) {
    const student = (window.allStudents || []).find(s => s.docId === studentId);
    if (!student) return;

    document.getElementById('detail-empty').style.display = 'none';
    document.getElementById('detail-content').style.display = '';
    window.selectedStudentId = studentId;

    const selectedDate = window.selectedDate || '';
    const dayName = getDayName(selectedDate);
    const activeEnrolls = getActiveEnrollments(student, selectedDate);
    const naesinEnroll = activeEnrolls.find(e => e.class_type === '내신');
    if (!naesinEnroll) return;

    const code = enrollmentCode(naesinEnroll);
    const classSettingsMap = window.classSettings || {};
    const cs = classSettingsMap[code] || {};
    const teacherDisplay = cs.teacher ? cs.teacher.split('@')[0] : '';
    const rec = (window.dailyRecords || {})[studentId] || {};
    const attStatus = rec?.attendance?.status || '미확인';

    // 출결 버튼
    const attOptions = ['등원전', '출석', '지각', '결석'];
    const attMap = { '등원전': '', '출석': 'att-present', '지각': 'att-late', '결석': 'att-absent' };
    const currentAtt = attStatus === '미확인' ? '등원전' : attStatus;
    const attHtml = attOptions.map(opt => {
        const active = opt === currentAtt ? attMap[opt] || '' : '';
        return `<button class="naesin-att-btn ${active}" onclick="window.toggleAttendance('${studentId}', '${opt === '등원전' ? '정규' : opt}')">${opt}</button>`;
    }).join('');

    // 등원요일/시간
    const classDays = cs.schedule ? Object.keys(cs.schedule) : [];
    const studentDays = naesinEnroll.day || [];
    const allDays = [...new Set([...classDays, ...studentDays])];
    const dayOrder = ['월', '화', '수', '목', '금', '토', '일'];
    allDays.sort((a, b) => dayOrder.indexOf(a) - dayOrder.indexOf(b));

    const scheduleHtml = studentDays.map(day => {
        const studentTime = naesinEnroll.schedule?.[day];
        const classTime = cs.schedule?.[day] || '';
        const displayTime = studentTime || classTime || '—';
        const isOverride = !!studentTime;
        const isToday = day === dayName;
        const badgeClass = isToday ? 'naesin-day-today' : 'naesin-day-active';

        return `<div class="naesin-schedule-row">
            <span class="naesin-day-badge ${badgeClass}">${day}</span>
            <span class="naesin-time ${isOverride ? 'naesin-time-override' : ''}">${displayTime}</span>
            <span class="naesin-time-label">${isOverride ? '(개별)' : '(반 기본)'}</span>
            <span class="naesin-edit-btn" onclick="window.editNaesinTime('${studentId}', '${day}')">수정</span>
        </div>`;
    }).join('');

    const classScheduleStr = classDays.map(d => `${d} ${cs.schedule[d]}`).join(' / ');

    const html = `
        <div class="detail-header">
            <div class="detail-name-row">
                <span class="detail-name">${student.name}</span>
                <span class="tag-badge tag-naesin">내신</span>
                <span class="tag-badge tag-class">${code}</span>
            </div>
            <div class="detail-meta">${student.school || ''} ${student.grade || ''}학년 · ${branchFromStudent(student)}${teacherDisplay ? ' · 담당: ' + teacherDisplay : ''}</div>
        </div>

        <div class="detail-card">
            <div class="detail-card-title">출결</div>
            <div class="naesin-att-row">${attHtml}</div>
        </div>

        <div class="detail-card">
            <div class="detail-card-title">등원요일 · 시간</div>
            <div class="naesin-schedule">${scheduleHtml}</div>
            ${classScheduleStr ? `<div class="naesin-schedule-footer">반 기본: ${classScheduleStr}</div>` : ''}
        </div>
    `;

    document.getElementById('detail-cards').innerHTML = html;
    document.getElementById('detail-panel').classList.add('mobile-visible');
}

window.renderNaesinDetail = renderNaesinDetail;
```

- [ ] **Step 3: style.css에 내신 전용 스타일 추가**

```css
/* 내신 상세패널 */
.naesin-att-row { display: flex; gap: 6px; padding: 8px 0; }
.naesin-att-btn { flex: 1; padding: 8px 0; border-radius: 8px; text-align: center; font-size: 13px; font-weight: 600; border: 1.5px solid var(--border); color: var(--text-sec); cursor: pointer; background: var(--surface); }
.naesin-att-btn.att-present { background: #dcfce7; color: #166534; border-color: #86efac; }
.naesin-att-btn.att-late { background: #fef9c3; color: #854d0e; border-color: #fde047; }
.naesin-att-btn.att-absent { background: #fee2e2; color: #991b1b; border-color: #fca5a5; }

.naesin-schedule-row { display: flex; align-items: center; gap: 8px; padding: 5px 0; font-size: 13px; }
.naesin-day-badge { width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600; }
.naesin-day-active { background: var(--primary); color: #fff; }
.naesin-day-today { background: #f59e0b; color: #fff; }
.naesin-time { font-size: 13px; font-weight: 600; color: var(--text); }
.naesin-time-override { color: #dc2626; }
.naesin-time-label { font-size: 11px; color: var(--text-sec); }
.naesin-edit-btn { font-size: 11px; color: var(--primary); cursor: pointer; text-decoration: underline; margin-left: auto; }
.naesin-schedule-footer { font-size: 11px; color: var(--text-sec); padding-top: 6px; }

.tag-naesin { background: #fef3c7; color: #92400e; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
.tag-class { background: #e0f2fe; color: #0369a1; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
```

- [ ] **Step 4: 검증 — 내신 학생 클릭 시 상세패널에 출결 + 등원요일/시간 표시**

- [ ] **Step 5: 커밋**

```bash
git add naesin.js daily-ops.js style.css
git commit -m "feat: 내신 학생 상세패널 — 출결 + 등원요일/시간"
```

---

### Task 6: 내신 상세패널 — 메모 카드

**Files:**
- Modify: `naesin.js`

- [ ] **Step 1: renderNaesinDetail()에 메모 카드 HTML 추가**

출결/등원요일 카드 뒤에 메모 카드 추가:

```js
// 메모 카드
const memo = rec.naesin_memo || '';
const memoBy = rec.naesin_memo_by || '';
const memoAt = rec.naesin_memo_at || '';

const memoHtml = `
    <div class="detail-card">
        <div class="detail-card-title-row">
            <span class="detail-card-title">메모</span>
            <button class="card-add-btn" onclick="window.toggleNaesinMemoInput('${studentId}')">+</button>
        </div>
        <div id="naesin-memo-display-${studentId}">
            ${memo ? `<div class="naesin-memo-item">${_esc(memo)}<div class="naesin-memo-meta">${memoBy}${memoAt ? ' · ' + memoAt.slice(5, 16).replace('T', ' ') : ''}</div></div>` : '<div class="naesin-memo-empty">메모 없음</div>'}
        </div>
        <div id="naesin-memo-input-${studentId}" style="display:none;padding:8px 0;">
            <textarea id="naesin-memo-textarea-${studentId}" class="naesin-memo-input" placeholder="메모 입력...">${_esc(memo)}</textarea>
            <button class="naesin-memo-submit" onclick="window.saveNaesinMemo('${studentId}')">저장</button>
        </div>
    </div>
`;
```

- [ ] **Step 2: 메모 토글/저장 함수 구현**

```js
window.toggleNaesinMemoInput = function(studentId) {
    const el = document.getElementById(`naesin-memo-input-${studentId}`);
    el.style.display = el.style.display === 'none' ? '' : 'none';
    if (el.style.display !== 'none') {
        document.getElementById(`naesin-memo-textarea-${studentId}`).focus();
    }
};

window.saveNaesinMemo = async function(studentId) {
    const textarea = document.getElementById(`naesin-memo-textarea-${studentId}`);
    const memo = textarea.value.trim();
    const currentUser = window.currentUser;
    const memoBy = (currentUser?.email || '').split('@')[0];
    const memoAt = new Date().toISOString();

    window.saveDailyRecord(studentId, {
        naesin_memo: memo,
        naesin_memo_by: memoBy,
        naesin_memo_at: memoAt
    });

    // 로컬 캐시 업데이트
    const dailyRecords = window.dailyRecords || {};
    if (!dailyRecords[studentId]) dailyRecords[studentId] = {};
    dailyRecords[studentId].naesin_memo = memo;
    dailyRecords[studentId].naesin_memo_by = memoBy;
    dailyRecords[studentId].naesin_memo_at = memoAt;

    renderNaesinDetail(studentId);
};

function _esc(s) { return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
```

- [ ] **Step 3: 메모 CSS 추가**

```css
.detail-card-title-row { display: flex; align-items: center; justify-content: space-between; padding: 12px 0 6px; }
.card-add-btn { width: 24px; height: 24px; border-radius: 6px; border: 1.5px solid var(--border); background: var(--surface); display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: 16px; color: var(--text-sec); }
.card-add-btn:hover { border-color: var(--primary); color: var(--primary); }
.naesin-memo-item { background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 10px 12px; font-size: 13px; line-height: 1.5; white-space: pre-wrap; }
.naesin-memo-meta { font-size: 11px; color: var(--text-sec); margin-top: 4px; }
.naesin-memo-empty { font-size: 13px; color: var(--text-sec); padding: 8px 0; }
.naesin-memo-input { width: 100%; border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; font-size: 13px; resize: vertical; min-height: 60px; font-family: inherit; }
.naesin-memo-submit { margin-top: 6px; padding: 6px 14px; background: var(--primary); color: #fff; border: none; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer; }
```

- [ ] **Step 4: 검증 — 메모 입력/저장/표시 확인**

- [ ] **Step 5: 커밋**

```bash
git add naesin.js style.css
git commit -m "feat: 내신 상세패널 — 메모 카드 (입력/저장/표시)"
```

---

### Task 7: 내신 상세패널 — 클리닉 카드

**Files:**
- Modify: `naesin.js`

- [ ] **Step 1: renderNaesinDetail()에 클리닉 카드 추가**

메모 카드 뒤에 클리닉 카드 추가. 기존 `extra_visit` 데이터 구조를 재사용:

```js
// 클리닉 카드
const ev = rec.extra_visit || {};
const evDate = ev.date || '';
const evTime = ev.time || '';
const evReason = ev.reason || '';
const evStatus = ev.visit_status || '';

const clinicHtml = `
    <div class="detail-card">
        <div class="detail-card-title-row">
            <span class="detail-card-title">클리닉</span>
            <button class="card-add-btn" onclick="window.openNaesinClinic('${studentId}')">+</button>
        </div>
        <div class="naesin-clinic-list">
            ${evDate ? `<div class="naesin-clinic-item">
                <span style="flex:1;">${evReason || '클리닉'} (${evDate} ${evTime})</span>
                <span class="naesin-clinic-status ${evStatus === '완료' ? 'clinic-done' : 'clinic-pending'}">${evStatus || '예정'}</span>
            </div>` : '<div class="naesin-memo-empty">클리닉 없음</div>'}
        </div>
    </div>
`;
```

- [ ] **Step 2: 클리닉 추가 함수 — 기존 saveExtraVisit 연동**

```js
window.openNaesinClinic = function(studentId) {
    // 기존 클리닉 모달이 있으면 재사용, 없으면 간단한 prompt
    const date = prompt('클리닉 날짜 (YYYY-MM-DD):');
    if (!date) return;
    const time = prompt('시간 (HH:MM):', '17:00');
    if (time === null) return;
    const reason = prompt('사유:', '');
    if (reason === null) return;

    window.saveExtraVisit(studentId, 'date', date);
    window.saveExtraVisit(studentId, 'time', time);
    window.saveExtraVisit(studentId, 'reason', reason);

    setTimeout(() => renderNaesinDetail(studentId), 500);
};
```

- [ ] **Step 3: 클리닉 CSS 추가**

```css
.naesin-clinic-item { display: flex; align-items: center; gap: 8px; padding: 6px 0; font-size: 13px; }
.naesin-clinic-status { padding: 3px 8px; border-radius: 6px; font-size: 11px; font-weight: 600; }
.clinic-pending { background: #fef3c7; color: #92400e; }
.clinic-done { background: #dcfce7; color: #166534; }
```

- [ ] **Step 4: 검증 — 클리닉 추가/표시 확인**

- [ ] **Step 5: 커밋**

```bash
git add naesin.js style.css
git commit -m "feat: 내신 상세패널 — 클리닉 카드"
```

---

### Task 8: 개별 등원시간 수정 기능

**Files:**
- Modify: `naesin.js`

- [ ] **Step 1: editNaesinTime() 구현**

```js
window.editNaesinTime = async function(studentId, day) {
    const student = (window.allStudents || []).find(s => s.docId === studentId);
    if (!student) return;

    const selectedDate = window.selectedDate || '';
    const activeEnrolls = getActiveEnrollments(student, selectedDate);
    const naesinEnroll = activeEnrolls.find(e => e.class_type === '내신');
    if (!naesinEnroll) return;

    const code = enrollmentCode(naesinEnroll);
    const cs = (window.classSettings || {})[code] || {};
    const classTime = cs.schedule?.[day] || '';
    const currentTime = naesinEnroll.schedule?.[day] || '';

    const newTime = prompt(`${day}요일 등원시간 (반 기본: ${classTime || '없음'})`, currentTime || classTime);
    if (newTime === null) return;

    // enrollment 업데이트
    const enrollments = [...student.enrollments];
    const idx = enrollments.findIndex(e => e.class_type === '내신' && enrollmentCode(e) === code);
    if (idx === -1) return;

    const schedule = { ...(enrollments[idx].schedule || {}) };
    if (!newTime || newTime === classTime) {
        delete schedule[day]; // 반 기본과 같으면 제거
    } else {
        schedule[day] = newTime;
    }
    enrollments[idx] = { ...enrollments[idx], schedule: Object.keys(schedule).length > 0 ? schedule : undefined };

    // Firestore 저장
    const { doc, updateDoc } = await import('firebase/firestore');
    try {
        window.showSaveIndicator('saving');
        await updateDoc(doc(db, 'students', studentId), { enrollments });
        student.enrollments = enrollments;
        window.showSaveIndicator('saved');
        renderNaesinDetail(studentId);
    } catch (err) {
        console.error('등원시간 저장 실패:', err);
        window.showSaveIndicator('error');
    }
};
```

- [ ] **Step 2: 검증 — 개별 시간 수정 → 빨간색 "(개별)" 표시 → 반 기본 시간과 같게 입력 시 제거 확인**

- [ ] **Step 3: 커밋**

```bash
git add naesin.js
git commit -m "feat: 내신 개별 등원시간 수정 기능"
```

---

### Task 9: 빌드 검증 + 최종 정리

**Files:**
- 전체

- [ ] **Step 1: 빌드 확인**

```bash
npm run build
```

빌드 에러 없는지 확인.

- [ ] **Step 2: 기능 통합 테스트**

1. 출결 > 내신 클릭 → 반 칩 + 학생 목록 표시
2. L3 반 칩 클릭 → 해당 반 학생만 필터
3. 학생 클릭 → 내신 상세패널 (출결 + 등원요일/시간 + 메모 + 클리닉)
4. 출결 토글 → 저장 완료
5. 메모 + 버튼 → 입력/저장/표시
6. 클리닉 + 버튼 → 입력/표시
7. 등원시간 수정 → 개별/반 기본 전환
8. 정규로 돌아갔을 때 기존 기능 정상 동작

- [ ] **Step 3: .superpowers를 .gitignore에 추가 (없으면)**

```bash
echo ".superpowers/" >> .gitignore
```

- [ ] **Step 4: 커밋**

```bash
git add -A
git commit -m "feat: 내신 반 관리 시스템 완성 (L2 필터 + 상세패널 + 메모 + 클리닉)"
```
