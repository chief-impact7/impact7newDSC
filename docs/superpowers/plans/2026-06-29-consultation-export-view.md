# 상담 내역 일자별·학생별 조회 + CSV 내보내기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 대시보드(`dashboard.html`)에 기간별 전체 상담을 일자별/학생별로 모아 보고 CSV로 내보내는 뷰를 추가한다.

**Architecture:** 대시보드 App.jsx에 이미 있는 기간·소속/학년/반 필터를 재사용하고, 본문에 `view` 토글(로그북↔상담)을 둔다. 상담 조회 함수 1개 + 훅 1개 + 순수 뷰 로직 모듈 + 표시 컴포넌트를 추가한다. 로그북 로직은 건드리지 않는다.

**Tech Stack:** React(dashboard, Vite), Firebase Firestore(`consultations`), node:test(순수 함수), 기존 `xlsx`/CSV 유틸.

## Global Constraints

- 멀티페이지 앱: dashboard entry는 `src/dashboard/main.jsx`. 상담 화면 코드는 모두 `src/dashboard/` 하위(또는 공용 `src/shared/`)에 둔다.
- dashboard는 DSC/shared를 **읽기만** 한다. enrollment 분류·파생을 자체 재구현하지 않는다(drift 금지). 기존 헬퍼(`branchFromStudent`, `studentGradeKey`, `enrollmentCode`, `studentShortLabel`)를 import해 쓴다.
- 신규 컴포넌트는 React 함수 컴포넌트.
- CSV는 UTF-8 BOM(`﻿`) prefix + 수식 인젝션 방어(`safeCell`)를 반드시 적용한다.
- 순수 함수(firebase/DOM 의존 없음)는 `node --test`로 테스트하고, 새 `.test.js`는 `package.json`의 `test:node` 스크립트 파일 목록에 추가한다.
- Firestore 권한 확인됨: `consultations` `allow read: if isAuthorized()`. 학생 필터 없이 기간 조회 가능.
- 커밋 메시지: 한국어 conventional (예: `feat(consult): ...`). 각 task 끝 commit step은 표준 절차이며, **push는 사용자 요청 시에만**. 소스 커밋 전 프로젝트 규칙(`/simplify` → `/code-review`)은 전체 task 완료 후 일괄 적용한다.

---

### Task 1: CSV 공용 유틸 추출 (`src/shared/csv.js`)

`class-setup-planner.js`의 비공개 `csvCell`/`safeCell`을 공용 모듈로 빼서 상담 뷰와 공유한다(중복 구현 금지).

**Files:**
- Create: `src/shared/csv.js`
- Create: `csv.test.js` (루트)
- Modify: `class-setup-planner.js` (csvCell/safeCell 정의 삭제 → import)
- Modify: `package.json` (`test:node`에 `csv.test.js` 추가)

**Interfaces:**
- Produces:
  - `safeCell(value: any) -> string`
  - `csvCell(value: any) -> string`
  - `serializeCsv(headers: string[], rows: (string|number)[][]) -> string` (BOM 포함)
  - `downloadCsv(filename: string, headers: string[], rows: (string|number)[][]) -> void` (DOM)

- [ ] **Step 1: 실패하는 테스트 작성** — `csv.test.js`

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeCell, csvCell, serializeCsv } from './src/shared/csv.js';

test('safeCell: 수식 트리거 문자는 작은따옴표로 텍스트화', () => {
  assert.equal(safeCell('=1+1'), "'=1+1");
  assert.equal(safeCell('+82'), "'+82");
  assert.equal(safeCell('-3'), "'-3");
  assert.equal(safeCell('@user'), "'@user");
  assert.equal(safeCell('정상'), '정상');
  assert.equal(safeCell(null), '');
});

test('csvCell: 따옴표는 두 개로 이스케이프하고 전체를 따옴표로 감쌈', () => {
  assert.equal(csvCell('a"b'), '"a""b"');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('a\nb'), '"a\nb"');
});

test('serializeCsv: BOM prefix + 헤더/행 직렬화', () => {
  const out = serializeCsv(['날짜', '메모'], [['2026-06-29', 'a,b']]);
  assert.ok(out.startsWith('﻿'), 'BOM으로 시작');
  assert.equal(out, '﻿"날짜","메모"\n"2026-06-29","a,b"');
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `node --test csv.test.js`
Expected: FAIL (`Cannot find module './src/shared/csv.js'`)

- [ ] **Step 3: `src/shared/csv.js` 구현**

```javascript
// CSV 직렬화 공용 유틸. 순수 함수(safeCell/csvCell/serializeCsv)는 node:test 가능,
// downloadCsv만 DOM 의존. class-setup-planner.js와 상담 조회 뷰가 공유한다.

// 셀이 = + - @ 탭 CR로 시작하면 Excel/Sheets가 수식으로 평가하므로 작은따옴표 prefix로 텍스트 강제.
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

export function safeCell(value) {
  const s = String(value ?? '');
  return FORMULA_TRIGGER.test(s) ? "'" + s : s;
}

export function csvCell(value) {
  return `"${safeCell(value).replace(/"/g, '""')}"`;
}

// headers + rows → CSV 문자열. UTF-8 BOM prefix로 엑셀에서 한글이 깨지지 않게 한다.
export function serializeCsv(headers, rows) {
  const lines = [headers, ...rows].map(row => row.map(csvCell).join(','));
  return '﻿' + lines.join('\n');
}

// 브라우저에서 CSV 파일로 저장.
export function downloadCsv(filename, headers, rows) {
  const blob = new Blob([serializeCsv(headers, rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `node --test csv.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: `class-setup-planner.js`를 import로 교체**

16번째 줄 근처 import 블록에 추가:
```javascript
import { csvCell, safeCell } from './src/shared/csv.js';
```
그리고 파일 하단의 비공개 정의(아래 3개)를 **삭제**한다:
```javascript
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;
function safeCell(value) { ... }
function csvCell(value) { ... }
```
(311번째 줄의 `'﻿' + ...` CSV 생성과 332번째 줄의 `safeCell` 호출은 그대로 둔다 — import된 동일 함수가 쓰인다.)

- [ ] **Step 6: `package.json`의 `test:node`에 `csv.test.js` 추가**

```json
"test:node": "node --test consultation-filter.test.js consultation-payload.test.js class-setup-enrollment.test.js student-core.test.js docu-records.test.js save-scheduler.test.js csv.test.js",
```

- [ ] **Step 7: 빌드·테스트로 회귀 확인**

Run: `npm run test:node && npm run build`
Expected: 모든 node 테스트 PASS, 빌드 성공 (class-setup CSV 동작 불변)

- [ ] **Step 8: Commit**

```bash
git add src/shared/csv.js csv.test.js class-setup-planner.js package.json
git commit -m "refactor(csv): csvCell/safeCell을 src/shared/csv.js로 공용화"
```

---

### Task 2: 상담 뷰 순수 로직 (`src/dashboard/lib/consultation-view.js`)

상담 배열을 필터·그룹·CSV행으로 변환하는 순수 함수. firebase/DOM 의존 없음 → node:test.

**Files:**
- Create: `src/dashboard/lib/consultation-view.js`
- Create: `consultation-view.test.js` (루트)
- Modify: `package.json` (`test:node`에 `consultation-view.test.js` 추가)

**Interfaces:**
- Consumes: 상담 객체 `{ id, student_id, student_name, date, teacher_name, target, method, consultation_type, title, text }`
- Produces:
  - `filterByStudentIds(list, allowedIds: Set|null) -> list` (allowedIds=null이면 전체)
  - `groupByDate(list) -> { key: string, items: [] }[]` (날짜 desc)
  - `groupByStudent(list) -> { key: string, studentId: string, items: [] }[]` (학생명 ko 오름차순, 묶음 내 date desc)
  - `CONSULTATION_COLUMNS: string[]`
  - `toRow(c, studentInfoById) -> string[]`
  - `toCsvRows(list, studentInfoById) -> string[][]`
  - `studentInfoById` 형태: `{ [studentId]: { gradeLabel: string, classLabel: string } }`

- [ ] **Step 1: 실패하는 테스트 작성** — `consultation-view.test.js`

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  filterByStudentIds, groupByDate, groupByStudent, toRow, toCsvRows, CONSULTATION_COLUMNS,
} from './src/dashboard/lib/consultation-view.js';

const sample = [
  { id: '1', student_id: 's1', student_name: '김가', date: '2026-06-28', teacher_name: '강사A', target: '학생', method: '대면', consultation_type: '정기', title: '제목1', text: '메모1' },
  { id: '2', student_id: 's2', student_name: '이나', date: '2026-06-29', teacher_name: '강사B', target: '학부모', method: '문자', consultation_type: '수시', title: '', text: '메모2' },
  { id: '3', student_id: 's1', student_name: '김가', date: '2026-06-29', teacher_name: '강사A', target: '학생', method: '전화', consultation_type: '정기', title: '제목3', text: '메모3' },
];

test('filterByStudentIds: null이면 전체, Set이면 교집합', () => {
  assert.equal(filterByStudentIds(sample, null).length, 3);
  assert.deepEqual(filterByStudentIds(sample, new Set(['s2'])).map(c => c.id), ['2']);
});

test('groupByDate: 날짜 내림차순 묶음', () => {
  const g = groupByDate(sample);
  assert.deepEqual(g.map(x => x.key), ['2026-06-29', '2026-06-28']);
  assert.equal(g[0].items.length, 2);
});

test('groupByStudent: 학생명 오름차순, 묶음 내 date desc', () => {
  const g = groupByStudent(sample);
  assert.deepEqual(g.map(x => x.key), ['김가', '이나']);
  assert.deepEqual(g[0].items.map(c => c.date), ['2026-06-29', '2026-06-28']);
});

test('toRow: 컬럼 순서대로, 학년/반은 studentInfo에서 조인', () => {
  const info = { s1: { gradeLabel: '중2', classLabel: 'A101' } };
  assert.deepEqual(
    toRow(sample[0], info),
    ['2026-06-28', '김가', '중2 · A101', '강사A', '학생', '대면', '정기', '제목1', '메모1'],
  );
  // 정보 없는 학생은 학년/반 빈칸
  assert.equal(toRow(sample[1], info)[2], '');
});

test('toCsvRows: 컬럼 수가 헤더와 일치', () => {
  const rows = toCsvRows(sample, {});
  assert.equal(rows.length, 3);
  rows.forEach(r => assert.equal(r.length, CONSULTATION_COLUMNS.length));
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `node --test consultation-view.test.js`
Expected: FAIL (`Cannot find module`)

- [ ] **Step 3: `src/dashboard/lib/consultation-view.js` 구현**

```javascript
// [상담 조회] 순수 뷰 로직 — firebase/DOM 의존 없음 → node:test 가능.
// 상담 원본 배열을 필터·그룹·표/CSV 행으로 변환한다. 학년/반은 호출측이 students에서
// 미리 추출한 studentInfoById로 주입(여기서 firebase 헬퍼를 직접 import하지 않음).

export const CONSULTATION_COLUMNS = ['날짜', '학생', '학년/반', '강사', '대상', '형태', '유형', '제목', '메모'];

// allowedIds가 null이면 전체 통과(필터 미적용). Set이면 student_id 교집합.
export function filterByStudentIds(list, allowedIds) {
  if (!allowedIds) return list;
  return list.filter(c => allowedIds.has(c.student_id));
}

// 날짜(desc) 묶음. 입력이 date desc로 조회되므로 묶음 내 순서는 보존.
export function groupByDate(list) {
  const map = new Map();
  for (const c of list) {
    const k = c.date || '';
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(c);
  }
  return [...map.keys()]
    .sort((a, b) => String(b).localeCompare(String(a)))
    .map(key => ({ key, items: map.get(key) }));
}

// 학생명(ko 오름차순) 묶음, 묶음 내 date desc.
export function groupByStudent(list) {
  const map = new Map();
  for (const c of list) {
    const k = c.student_id || '';
    if (!map.has(k)) map.set(k, { key: c.student_name || '', studentId: k, items: [] });
    map.get(k).items.push(c);
  }
  for (const g of map.values()) {
    g.items.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  }
  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key, 'ko'));
}

// studentInfoById: { [studentId]: { gradeLabel, classLabel } }
export function toRow(c, studentInfoById = {}) {
  const info = studentInfoById[c.student_id] || {};
  const gradeClass = [info.gradeLabel, info.classLabel].filter(Boolean).join(' · ');
  return [
    c.date || '',
    c.student_name || '',
    gradeClass,
    c.teacher_name || '',
    c.target || '',
    c.method || '',
    c.consultation_type || '',
    c.title || '',
    c.text || '',
  ];
}

export function toCsvRows(list, studentInfoById = {}) {
  return list.map(c => toRow(c, studentInfoById));
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `node --test consultation-view.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: `package.json`의 `test:node`에 추가**

```json
"test:node": "node --test consultation-filter.test.js consultation-payload.test.js class-setup-enrollment.test.js student-core.test.js docu-records.test.js save-scheduler.test.js csv.test.js consultation-view.test.js",
```

- [ ] **Step 6: 테스트 재확인**

Run: `npm run test:node`
Expected: 전체 PASS

- [ ] **Step 7: Commit**

```bash
git add src/dashboard/lib/consultation-view.js consultation-view.test.js package.json
git commit -m "feat(consult): 상담 조회 순수 뷰 로직(필터·그룹·CSV행) 추가"
```

---

### Task 3: 상담 기간 조회 함수 (`fetchConsultationsForRange`)

**Files:**
- Modify: `src/shared/firestore-helpers.js` (import에 `orderBy` 추가 + 함수 추가)

**Interfaces:**
- Produces: `fetchConsultationsForRange(startDate: string, endDate: string) -> Promise<object[]>`

- [ ] **Step 1: import에 `orderBy` 추가**

`src/shared/firestore-helpers.js` 1번째 줄 import를 다음으로 교체:
```javascript
import {
    collection, getDocs, query, where, orderBy, Timestamp
} from 'firebase/firestore';
```

- [ ] **Step 2: 조회 함수 추가** (파일 끝 적절한 위치, 다른 fetch 함수 근처)

```javascript
// 기간 내 모든 상담 조회(학생 무관). date는 'YYYY-MM-DD' 문자열 단일 필드 범위 +
// 동일 필드 orderBy → 복합 인덱스 불필요. 권한: consultations read = isAuthorized.
export async function fetchConsultationsForRange(startDate, endDate) {
    if (!startDate || !endDate) return [];
    const q = query(
        collection(db, 'consultations'),
        where('date', '>=', startDate),
        where('date', '<=', endDate),
        orderBy('date', 'desc'),
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
```

- [ ] **Step 3: 빌드 확인**

Run: `npm run build`
Expected: 성공

- [ ] **Step 4: Commit**

```bash
git add src/shared/firestore-helpers.js
git commit -m "feat(consult): fetchConsultationsForRange 기간 상담 조회 추가"
```

---

### Task 4: useConsultations 훅 (`src/dashboard/hooks/useFirestore.js`)

**Files:**
- Modify: `src/dashboard/hooks/useFirestore.js` (import + 훅 추가)

**Interfaces:**
- Consumes: `fetchConsultationsForRange` (Task 3)
- Produces: `useConsultations(user, startDate, endDate, enabled) -> { consultations, loading, error }`

- [ ] **Step 1: import에 `fetchConsultationsForRange` 추가**

`useFirestore.js` 상단에서 `../../src/shared/firestore-helpers.js`(또는 기존 동일 경로)로부터 fetch 함수들을 가져오는 import 구문에 `fetchConsultationsForRange`를 추가한다. (기존 `fetchDailyRecordsRange` 등이 import되는 같은 구문에 합친다.)

- [ ] **Step 2: 훅 추가** (`useDashboardData` 정의 아래)

```javascript
// 기간 상담 조회 훅. enabled=false(상담 뷰 비활성)면 fetch하지 않는다(불필요 읽기 방지).
export function useConsultations(user, startDate, endDate, enabled) {
    const [consultations, setConsultations] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const reqIdRef = useRef(0);

    const reload = useCallback(() => {
        if (!enabled || !user || !startDate || !endDate) { setConsultations([]); return; }
        const reqId = ++reqIdRef.current; // 빠른 기간 변경 시 stale 응답이 최신을 덮지 않도록
        setLoading(true);
        setError(null);
        fetchConsultationsForRange(startDate, endDate)
            .then(list => { if (reqId === reqIdRef.current) setConsultations(list); })
            .catch(err => {
                if (reqId !== reqIdRef.current) return;
                console.error('[useConsultations]', err);
                setError(err);
            })
            .finally(() => { if (reqId === reqIdRef.current) setLoading(false); });
    }, [enabled, user, startDate, endDate]);

    useEffect(() => { reload(); }, [reload]);
    return { consultations, loading, error };
}
```

(`useState`, `useEffect`, `useCallback`, `useRef`는 이미 useFirestore.js가 import하고 있다 — `useDashboardData`가 사용 중. 누락 시 react import에 추가.)

- [ ] **Step 3: 빌드 확인**

Run: `npm run build`
Expected: 성공

- [ ] **Step 4: Commit**

```bash
git add src/dashboard/hooks/useFirestore.js
git commit -m "feat(consult): useConsultations 훅 추가"
```

---

### Task 5: ConsultationBoard 컴포넌트 (`src/dashboard/components/ConsultationBoard.jsx`)

**Files:**
- Create: `src/dashboard/components/ConsultationBoard.jsx`
- (참고) CSS는 기존 `dashboard.css` 클래스를 재사용하고, 부족분은 인라인 style로 처리.

**Interfaces:**
- Consumes: `consultation-view.js`(Task 2), `csv.js`(Task 1), 헬퍼 `branchFromStudent`/`enrollmentCode`(`student-core.js`), `studentGradeKey`/`studentShortLabel`(`src/shared/firestore-helpers.js`)
- Props: `{ consultations, students, branchFilter, classFilter, gradeFilter, startDate, endDate }`

- [ ] **Step 1: 컴포넌트 구현**

```jsx
import { useMemo, useState } from 'react';
import { branchFromStudent, enrollmentCode } from '../../../student-core.js';
import { studentGradeKey, studentShortLabel } from '../../shared/firestore-helpers.js';
import { downloadCsv } from '../../shared/csv.js';
import {
    filterByStudentIds, groupByDate, groupByStudent, toRow, toCsvRows, CONSULTATION_COLUMNS,
} from '../lib/consultation-view.js';

// 학생 마스터에서 학년/대표반 라벨 추출(읽기 전용; 파생 재구현 아님).
function buildStudentInfo(students) {
    const info = {};
    for (const s of students) {
        const codes = (s.enrollments || []).map(enrollmentCode).filter(Boolean);
        info[s.id] = {
            gradeLabel: studentShortLabel(s) || '',
            classLabel: [...new Set(codes)].join(', '),
        };
    }
    return info;
}

export default function ConsultationBoard({
    consultations, students, branchFilter, classFilter, gradeFilter, startDate, endDate,
}) {
    const [groupMode, setGroupMode] = useState('date'); // 'date' | 'student'

    const studentInfo = useMemo(() => buildStudentInfo(students), [students]);

    // 소속/학년/반 필터 → 허용 student id. 필터가 하나도 없으면 전체(null).
    const hasFilter = Boolean(branchFilter || classFilter || gradeFilter?.size);
    const allowedIds = useMemo(() => {
        if (!hasFilter) return null;
        const ids = new Set();
        for (const s of students) {
            if (branchFilter && branchFromStudent(s) !== branchFilter) continue;
            if (gradeFilter?.size && !gradeFilter.has(studentGradeKey(s))) continue;
            if (classFilter && !(s.enrollments || []).some(e => enrollmentCode(e) === classFilter)) continue;
            ids.add(s.id);
        }
        return ids;
    }, [students, branchFilter, classFilter, gradeFilter, hasFilter]);

    const visible = useMemo(
        () => filterByStudentIds(consultations, allowedIds),
        [consultations, allowedIds],
    );

    const groups = useMemo(
        () => (groupMode === 'date' ? groupByDate(visible) : groupByStudent(visible)),
        [groupMode, visible],
    );

    const handleExport = () => {
        downloadCsv(`상담내역_${startDate}_${endDate}.csv`, CONSULTATION_COLUMNS, toCsvRows(visible, studentInfo));
    };

    return (
        <div className="consult-board">
            <div className="consult-board-bar" style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '12px 0' }}>
                <div className="consult-group-toggle" role="group" aria-label="묶음 기준">
                    <button type="button" aria-pressed={groupMode === 'date'} onClick={() => setGroupMode('date')}>일자별</button>
                    <button type="button" aria-pressed={groupMode === 'student'} onClick={() => setGroupMode('student')}>학생별</button>
                </div>
                <span style={{ color: 'var(--text-sec)' }}>총 {visible.length}건</span>
                <button type="button" className="dash-text-btn" style={{ marginLeft: 'auto' }}
                    onClick={handleExport} disabled={!visible.length} aria-label="CSV 다운로드">
                    CSV 다운로드
                </button>
            </div>

            {!visible.length ? (
                <div className="consult-empty" style={{ padding: 20, color: 'var(--text-sec)' }}>기간 내 상담 없음</div>
            ) : (
                groups.map(group => (
                    <section key={group.studentId || group.key} className="consult-group" style={{ marginBottom: 18 }}>
                        <h4 style={{ margin: '8px 0' }}>{group.key || '(미상)'} <small>({group.items.length}건)</small></h4>
                        <table className="consult-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                            <thead>
                                <tr>
                                    {CONSULTATION_COLUMNS.map(col => (
                                        <th key={col} scope="col" style={{ textAlign: 'left', borderBottom: '1px solid var(--border)', padding: '4px 6px', whiteSpace: 'nowrap' }}>{col}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {group.items.map(c => {
                                    const cells = toRow(c, studentInfo);
                                    return (
                                        <tr key={c.id}>
                                            {cells.map((cell, i) => (
                                                <td key={i} style={{
                                                    borderBottom: '1px solid var(--border)', padding: '4px 6px',
                                                    whiteSpace: i === cells.length - 1 ? 'pre-wrap' : 'nowrap',
                                                    verticalAlign: 'top',
                                                }}>{cell}</td>
                                            ))}
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </section>
                ))
            )}
        </div>
    );
}
```

- [ ] **Step 2: 빌드 확인**

Run: `npm run build`
Expected: 성공 (import 경로·심볼 해결)

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/components/ConsultationBoard.jsx
git commit -m "feat(consult): ConsultationBoard(일자별/학생별 표 + CSV) 컴포넌트 추가"
```

---

### Task 6: App.jsx 통합 (뷰 토글 + 본문 분기)

**Files:**
- Modify: `src/dashboard/App.jsx`

**Interfaces:**
- Consumes: `useConsultations`(Task 4), `ConsultationBoard`(Task 5)

- [ ] **Step 1: import 추가** (App.jsx 상단 import 구역)

```jsx
import ConsultationBoard from './components/ConsultationBoard.jsx';
```
그리고 `useFirestore.js`에서 훅을 가져오는 기존 import 구문에 `useConsultations`를 추가한다.

- [ ] **Step 2: view 상태 추가** (다른 useState들 옆, 예: `loginError` 선언 근처)

```jsx
const [view, setView] = useState('logbook'); // 'logbook' | 'consult'
```

- [ ] **Step 3: 훅 호출 추가** (`useDashboardData` 호출 아래)

```jsx
const { consultations, loading: consultLoading } = useConsultations(user, startDate, endDate, view === 'consult');
```

- [ ] **Step 4: 뷰 토글 UI 추가** — 헤더 `dash-header-left`의 링크들 뒤(`messages.html` 링크 다음)에 세그먼트 토글 삽입

```jsx
<span className="dash-view-toggle" role="group" aria-label="화면 전환" style={{ marginLeft: 8 }}>
    <button type="button" aria-pressed={view === 'logbook'} onClick={() => setView('logbook')}>로그북</button>
    <button type="button" aria-pressed={view === 'consult'} onClick={() => setView('consult')}>상담</button>
</span>
```
(주의: 헤더에 이미 `<span className="dash-link active">로그북</span>` 텍스트가 있다. 이는 "현재 페이지=로그북" 표시였으므로, 토글 도입 후 혼동을 막기 위해 그 `active` span을 제거하고 위 토글로 대체한다.)

- [ ] **Step 5: 본문 분기** — 기존 `{rangeType === 'day' ? (...) : (...)}` 블록 전체를 `view`로 한 겹 감싼다

```jsx
{view === 'consult' ? (
    consultLoading ? (
        <div className="dash-grid"><SkeletonCard /><SkeletonCard /><SkeletonCard /></div>
    ) : (
        <ErrorBoundary>
            <ConsultationBoard
                consultations={consultations}
                students={students}
                branchFilter={branchFilter}
                classFilter={classFilter}
                gradeFilter={gradeFilter}
                startDate={startDate}
                endDate={endDate}
            />
        </ErrorBoundary>
    )
) : rangeType === 'day' ? (
    /* ...기존 일별 분기 그대로... */
) : (
    /* ...기존 기간 분기 그대로... */
)}
```

- [ ] **Step 6: 빌드 확인**

Run: `npm run build`
Expected: 성공

- [ ] **Step 7: 수동 검증** (READ-ONLY dev 권장: `.env.development.local`에 `VITE_READ_ONLY=true`)

Run: `npm run dev` → `http://localhost:5174/dashboard.html`
확인 항목:
1. 헤더 '상담' 토글 클릭 → 상담 뷰로 전환, 기간/소속/학년/반 필터 그대로 노출.
2. 기간(일별/주별/직접선택) 변경 → 해당 기간 상담만 조회.
3. 일자별/학생별 토글 → 묶음 방식 전환.
4. 소속/학년/반 필터 → 해당 학생 상담만.
5. CSV 다운로드 → 엑셀에서 한글·줄바꿈·콤마 정상, 컬럼 9개.
6. '로그북' 토글 → 기존 로그북 정상(회귀 없음).

- [ ] **Step 8: Commit**

```bash
git add src/dashboard/App.jsx
git commit -m "feat(consult): 대시보드 로그북↔상담 뷰 토글 통합"
```

---

## 마무리 (전체 task 완료 후)

- [ ] 프로젝트 규칙: 소스 변경 커밋이므로 `/simplify` → `/code-review` 순차 실행 후 반영.
- [ ] `npm run test && npm run build` 최종 통과 확인.
- [ ] push는 사용자 요청 시에만 (push = 자동 배포).

## Self-Review 결과

- **Spec 커버리지:** R1(Task 3 조회)·R2(Task 2 group + Task 5 토글)·R3(Task 5 필터)·R4(Task 1 CSV + Task 5 버튼)·R5(로그북 미변경, Task 6은 감싸기만) 모두 task 존재.
- **Placeholder:** 없음(모든 코드 실제 구현 포함). Task 6의 `/* 기존 분기 그대로 */`는 기존 코드를 옮기는 지시로, 신규 코드가 아니라 의도된 보존.
- **타입 일관성:** `fetchConsultationsForRange`(Task 3)→`useConsultations`(Task 4)→`consultations` prop(Task 5/6) 일치. `CONSULTATION_COLUMNS`/`toRow`/`toCsvRows`/`groupByDate`/`groupByStudent`/`filterByStudentIds` 시그니처가 Task 2 정의와 Task 5 사용에서 동일. `downloadCsv(filename, headers, rows)` 시그니처 Task 1↔5 일치.
