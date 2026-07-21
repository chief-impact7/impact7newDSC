# 로그북 AI 종합상태 뷰 (AiStatusBoard) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **이 플랜의 워커는 codex:codex-rescue 서브에이전트.** 각 태스크 프롬프트에 스펙 경로
> `docs/superpowers/specs/2026-07-21-ai-status-board-design.md`와 이 플랜의 해당 태스크 전문을 전달한다.
> 리뷰 게이트는 Claude `/simplify` → `/code-review` (Task 5, 메인 스레드).

**Goal:** dashboard.html(로그북)에 세 번째 뷰 `AI`를 추가해 전 재원생의 AI 종합상태(`student_status_summaries`)를 상태별 그룹으로 한눈에 조망한다.

**Architecture:** ConsultationBoard와 동일 문법 — App.jsx 뷰 토글 + lazy 컴포넌트 + `<details>` 그룹. 데이터는 뷰 최초 진입 시 summaries·class_settings·staff_directory 3개 컬렉션 1회 getDocs 후 모듈 캐시(onSnapshot 없음). 순수 로직은 `src/dashboard/lib/ai-status-view.js`로 분리해 node --test로 검증.

**Tech Stack:** React(dashboard entry), Firebase Firestore(read-only), @impact7/shared(staff-label·teacher-label·datetime), @impact7/ui(Icon/IconButton), node:test.

## Global Constraints

- 읽기 전용 뷰 — 생성/갱신/쓰기 액션 일절 없음. rules 변경 없음.
- 이모지·유니코드 그림문자 금지. 아이콘은 `@impact7/ui` `Icon`/`IconButton`만.
- 학생 표기는 `studentShortLabel`(축약형), enrollment 파생 자체 재구현 금지(shared/DSC 함수만).
- 담당 = `class_settings.teacher`(주담당)만. 부담당(sub_teacher) 미포함.
- 표시이름 정본은 HR `staff_directory.english_name` — 이메일 파생은 폴백만(bd56042 규칙).
- 상태 라벨·폴백은 student-status-card.js `STATUS_TONE`과 일치: good=양호, caution=주의(및 unknown 폴백), risk=위험.
- **태스크별 커밋 금지** — 전체 완료 후 Task 5에서 `/simplify` → `/code-review` 통과, quality-guard `--mark` 후 사용자 승인 시 1커밋 (프로젝트 규칙).
- 검색은 활성 필터 범위 내 이름 검색(전역 검색 아님).

---

### Task 1: 순수 로직 모듈 + 테스트 (`ai-status-view.js`)

**Files:**
- Create: `src/dashboard/lib/ai-status-view.js`
- Create: `ai-status-view.test.js` (repo 루트 — 기존 consultation-view.test.js와 동일 위치·러너)
- Modify: `package.json` (`test:node` 목록에 `ai-status-view.test.js` 추가)

**Interfaces:**
- Consumes: `enrollmentCode` (`student-core.js` — @impact7/shared만 의존, node 안전), `staffLabel` (`@impact7/shared/staff-label`), `teacherDisplayName` (`@impact7/shared/teacher-label`)
- **주의:** 이 파일은 `firestore-helpers.js`를 import하면 안 된다 — 그 파일은 `firebase-config.js`(Firebase 초기화)를 당겨 node --test가 깨진다. `studentGradeKey`가 필요한 `allowedStudentIds`는 그래서 Task 2에서 firestore-helpers에 둔다.
- Produces (Task 3이 사용):
  - `STATUS_GROUPS: [{key:'risk'|'caution'|'good'|'none', label:string}]` (순서 고정)
  - `summaryStatusKey(summary) => 'risk'|'caution'|'good'`
  - `generatedAtMs(value) => number|null`
  - `isStale(value, nowMs, days=30) => boolean`
  - `teacherOptions(classSettingsMap, staffByLocal) => [{key, name, classCodes:Set}]`
  - `buildGroups(students, summariesById, {allowedIds, teacherClassCodes, search}) => [{key, label, items:[{student, summary}]}]`
  - `countParts(summary) => string[]`, `gapLabel(summary) => string`

- [ ] **Step 1: 실패하는 테스트 작성** — `ai-status-view.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    STATUS_GROUPS, summaryStatusKey, generatedAtMs, isStale,
    teacherOptions, buildGroups, countParts, gapLabel,
} from './src/dashboard/lib/ai-status-view.js';

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-07-21T12:00:00+09:00').getTime();

const students = [
    { id: 's1', name: '김가', enrollments: [{ class_code: 'A101' }] },
    { id: 's2', name: '이나', enrollments: [{ class_code: 'B203' }] },
    { id: 's3', name: '박다', enrollments: [{ class_code: 'A101' }] },
];
const summaries = {
    s1: { status: 'risk', absence_count: 4, hw_fail_count: 3, test_fail_count: 0 },
    s2: { status: 'good', absence_count: 0, hw_fail_count: 0, test_fail_count: 0 },
    // s3: 미생성
};

test('summaryStatusKey: 알 수 없는 값은 caution 폴백', () => {
    assert.equal(summaryStatusKey({ status: 'risk' }), 'risk');
    assert.equal(summaryStatusKey({ status: 'good' }), 'good');
    assert.equal(summaryStatusKey({ status: 'weird' }), 'caution');
    assert.equal(summaryStatusKey({}), 'caution');
});

test('generatedAtMs: Timestamp·ISO·Date·불량값', () => {
    assert.equal(generatedAtMs({ toMillis: () => 123 }), 123);
    assert.equal(generatedAtMs(new Date(456)), 456);
    assert.equal(generatedAtMs('2026-07-01T00:00:00Z'), Date.parse('2026-07-01T00:00:00Z'));
    assert.equal(generatedAtMs('not-a-date'), null);
    assert.equal(generatedAtMs(null), null);
});

test('isStale: 30일 초과만 true, 해석 불가는 false', () => {
    assert.equal(isStale(new Date(now - 31 * DAY), now), true);
    assert.equal(isStale(new Date(now - 29 * DAY), now), false);
    assert.equal(isStale(null, now), false);
});

test('teacherOptions: 주담당 수집·로컬파트 dedup·HR 이름·반코드 누적', () => {
    const cs = {
        A101: { teacher: 'aaron@impact7.kr' },
        A102: { teacher: 'Aaron@gw.impact7.kr' },   // 같은 로컬파트 — 통합
        B203: { teacher: 'ben@impact7.kr', sub_teacher: 'cara@impact7.kr' }, // 부담당 무시
        C301: {},                                    // 담당 없음 — 제외
    };
    const opts = teacherOptions(cs, new Map([['aaron', 'Aaron'], ['ben', 'Ben']]));
    assert.equal(opts.length, 2);
    const aaron = opts.find(o => o.key === 'aaron');
    assert.equal(aaron.name, 'Aaron');
    assert.deepEqual([...aaron.classCodes].sort(), ['A101', 'A102']);
    assert.equal(opts.some(o => o.key === 'cara'), false);
});

test('buildGroups: 상태 버킷·미생성·이름순·그룹 순서', () => {
    const groups = buildGroups(students, summaries, {});
    assert.deepEqual(groups.map(g => g.key), STATUS_GROUPS.map(g => g.key));
    assert.deepEqual(groups.find(g => g.key === 'risk').items.map(i => i.student.id), ['s1']);
    assert.deepEqual(groups.find(g => g.key === 'good').items.map(i => i.student.id), ['s2']);
    assert.deepEqual(groups.find(g => g.key === 'none').items.map(i => i.student.id), ['s3']);
});

test('buildGroups: allowedIds·담당 반코드·검색 필터', () => {
    const only = new Set(['s1', 's3']);
    let groups = buildGroups(students, summaries, { allowedIds: only });
    assert.equal(groups.find(g => g.key === 'good').items.length, 0);

    groups = buildGroups(students, summaries, { teacherClassCodes: new Set(['B203']) });
    assert.deepEqual(groups.flatMap(g => g.items).map(i => i.student.id), ['s2']);

    groups = buildGroups(students, summaries, { search: '김' });
    assert.deepEqual(groups.flatMap(g => g.items).map(i => i.student.id), ['s1']);
});

test('countParts: 0 카운트 제외', () => {
    assert.deepEqual(countParts(summaries.s1), ['결석 4', '숙제미제출 3']);
    assert.deepEqual(countParts(summaries.s2), []);
});

test('gapLabel: 경고 없으면 빈 문자열, days null이면 기록 없음', () => {
    assert.equal(gapLabel({}), '');
    assert.equal(gapLabel({ consultation_gap_warning: true, consultation_gap_days: 42 }), '상담공백 42일');
    assert.equal(gapLabel({ consultation_gap_warning: true, consultation_gap_days: null }), '상담기록 없음');
});

```

- [ ] **Step 2: 실패 확인**

Run: `node --test ai-status-view.test.js`
Expected: FAIL — `Cannot find module ... ai-status-view.js`

- [ ] **Step 3: 구현** — `src/dashboard/lib/ai-status-view.js`

```js
// AI 종합상태 뷰의 순수 로직 — 컴포넌트·Firestore 비의존 (node --test 대상).
// firestore-helpers.js는 firebase-config를 당기므로 여기서 import 금지.
import { enrollmentCode } from '../../../student-core.js';
import { staffLabel } from '@impact7/shared/staff-label';
import { teacherDisplayName } from '@impact7/shared/teacher-label';

export const STATUS_GROUPS = [
    { key: 'risk', label: '위험' },
    { key: 'caution', label: '주의' },
    { key: 'good', label: '양호' },
    { key: 'none', label: '미생성' },
];

export const STALE_DAYS = 30;

// good/risk 외 값은 caution — student-status-card STATUS_TONE 폴백과 동일.
export function summaryStatusKey(summary) {
    const s = summary?.status;
    return (s === 'good' || s === 'risk') ? s : 'caution';
}

// Firestore Timestamp | ISO string | Date → epoch ms (해석 불가 시 null)
export function generatedAtMs(value) {
    if (!value) return null;
    if (typeof value.toMillis === 'function') return value.toMillis();
    const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isNaN(ms) ? null : ms;
}

export function isStale(value, nowMs, days = STALE_DAYS) {
    const ms = generatedAtMs(value);
    return ms != null && nowMs - ms > days * 24 * 60 * 60 * 1000;
}

// class_settings 주담당(teacher)만 → 드롭다운 옵션.
// key = 이메일 로컬파트 소문자(@gw/@impact7 혼재 통합), name = HR english_name 우선(bd56042).
export function teacherOptions(classSettingsMap, staffByLocal) {
    const byKey = new Map();
    for (const [classCode, cs] of Object.entries(classSettingsMap || {})) {
        const email = cs?.teacher;
        if (!email) continue;
        const key = staffLabel(email).toLowerCase();
        if (!key) continue;
        if (!byKey.has(key)) {
            const name = staffByLocal?.get(key) || teacherDisplayName(staffLabel(email)) || staffLabel(email);
            byKey.set(key, { key, name, classCodes: new Set() });
        }
        byKey.get(key).classCodes.add(classCode);
    }
    return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
}

// 필터·검색 적용 후 상태별 그룹 생성. 그룹 내 이름 가나다순, 그룹 순서는 STATUS_GROUPS 고정.
export function buildGroups(students, summariesById, { allowedIds = null, teacherClassCodes = null, search = '' } = {}) {
    const kw = search.trim();
    const byStatus = { risk: [], caution: [], good: [], none: [] };
    for (const s of students) {
        if (allowedIds && !allowedIds.has(s.id)) continue;
        if (teacherClassCodes && !(s.enrollments || []).some(e => teacherClassCodes.has(enrollmentCode(e)))) continue;
        if (kw && !String(s.name || '').includes(kw)) continue;
        const summary = summariesById?.[s.id] || null;
        byStatus[summary ? summaryStatusKey(summary) : 'none'].push({ student: s, summary });
    }
    for (const list of Object.values(byStatus)) {
        list.sort((a, b) => String(a.student.name || '').localeCompare(String(b.student.name || ''), 'ko'));
    }
    return STATUS_GROUPS.map(g => ({ ...g, items: byStatus[g.key] }));
}

// 0이 아닌 카운트만 "라벨 N" 목록으로.
export function countParts(summary) {
    return [['결석', 'absence_count'], ['숙제미제출', 'hw_fail_count'], ['테스트미달', 'test_fail_count']]
        .filter(([, k]) => Number(summary?.[k]) > 0)
        .map(([label, k]) => `${label} ${Number(summary[k])}`);
}

export function gapLabel(summary) {
    if (!summary?.consultation_gap_warning) return '';
    const days = summary.consultation_gap_days;
    return days == null ? '상담기록 없음' : `상담공백 ${days}일`;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `node --test ai-status-view.test.js`
Expected: 전건 PASS

- [ ] **Step 5: package.json 등록**

`test:node` 스크립트 목록 끝에 `ai-status-view.test.js` 추가:

```json
"test:node": "node --test consultation-filter.test.js consultation-payload.test.js class-setup-enrollment.test.js student-core.test.js docu-records.test.js save-scheduler.test.js csv.test.js consultation-view.test.js ai-status-view.test.js",
```

Run: `npm run test:node`
Expected: 기존 + 신규 전건 PASS

---

### Task 2: Firestore fetch 함수 + 데이터 훅

**Files:**
- Modify: `src/shared/firestore-helpers.js` (119행 `fetchClassSettingsMap` export 전환 + 함수 2개 추가)
- Modify: `src/dashboard/hooks/useFirestore.js` (훅 1개 추가)

**Interfaces:**
- Consumes: 기존 `db`, `getDocs`, `collection` (firestore-helpers 내 기존 import 그대로)
- Produces (Task 4가 사용):
  - `fetchStudentStatusSummaries() => Promise<{[studentId]: summaryData}>`
  - `fetchStaffNameMap() => Promise<Map<localLower, englishName>>`
  - `fetchClassSettingsMap() => Promise<{[classCode]: data}>` (기존 private → export)
  - `allowedStudentIds(students, {branchFilter, classFilter, gradeFilter}) => Set|null` (firestore-helpers에 추가 — `studentGradeKey`가 이 파일 소속이라 여기 둔다)
  - `useAiStatusData(user, enabled) => { data: {summaries, classSettings, staffByLocal}|null, loading, error, reload }`

- [ ] **Step 1: firestore-helpers.js 수정**

`async function fetchClassSettingsMap()` → `export async function fetchClassSettingsMap()`.

파일 하단(다른 fetch 함수들 근처)에 추가:

```js
// AI 종합상태 요약 전체 — 월 단위 갱신 데이터라 1회 read (서버 전용 쓰기 컬렉션).
export async function fetchStudentStatusSummaries() {
    const snap = await getDocs(collection(db, 'student_status_summaries'));
    const map = {};
    snap.forEach(d => { map[d.id] = d.data(); });
    return map;
}

// HR 인사 명부 — 로컬파트 소문자 → english_name (표시이름 정본, bd56042).
export async function fetchStaffNameMap() {
    const snap = await getDocs(collection(db, 'staff_directory'));
    const byLocal = new Map();
    snap.forEach(d => {
        const en = typeof d.data().english_name === 'string' ? d.data().english_name.trim() : '';
        if (en) byLocal.set(en.toLowerCase(), en);
    });
    return byLocal;
}
```

`studentGradeKey` 정의 아래에 추가 (ConsultationBoard의 allowedIds 계산과 동일 의미 — 이 함수가 정본):

```js
// 소속/학년/반 필터 → 허용 student id 집합. 필터 없으면 null(전체).
export function allowedStudentIds(students, { branchFilter, classFilter, gradeFilter } = {}) {
    if (!branchFilter && !classFilter && !gradeFilter?.size) return null;
    const ids = new Set();
    for (const s of students) {
        if (branchFilter && branchFromStudent(s) !== branchFilter) continue;
        if (gradeFilter?.size && !gradeFilter.has(studentGradeKey(s))) continue;
        if (classFilter && !(s.enrollments || []).some(e => enrollmentCode(e) === classFilter)) continue;
        ids.add(s.id);
    }
    return ids;
}
```

(`branchFromStudent`·`enrollmentCode`는 firestore-helpers 상단에서 이미 import돼 있다.)

- [ ] **Step 2: useFirestore.js에 훅 추가**

import 목록에 `fetchStudentStatusSummaries, fetchClassSettingsMap, fetchStaffNameMap` 추가 후 파일 끝에:

```js
// AI 종합상태 뷰 데이터. 월 단위 갱신이라 세션당 1회만 fetch — 모듈 캐시로 뷰 재진입 시 재사용.
let _aiStatusCache = null;

export function useAiStatusData(user, enabled) {
    const [data, setData] = useState(_aiStatusCache);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const reqIdRef = useRef(0);

    const load = useCallback((force) => {
        if (!user || (!force && (_aiStatusCache || !enabled))) return;
        const reqId = ++reqIdRef.current;
        setLoading(true);
        setError(null);
        Promise.all([fetchStudentStatusSummaries(), fetchClassSettingsMap(), fetchStaffNameMap()])
            .then(([summaries, classSettings, staffByLocal]) => {
                if (reqId !== reqIdRef.current) return;
                _aiStatusCache = { summaries, classSettings, staffByLocal };
                setData(_aiStatusCache);
            })
            .catch(err => {
                if (reqId !== reqIdRef.current) return;
                console.error('[useAiStatusData]', err);
                setError(err);
            })
            .finally(() => { if (reqId === reqIdRef.current) setLoading(false); });
    }, [user, enabled]);

    useEffect(() => { load(false); }, [load]);

    const reload = useCallback(() => { _aiStatusCache = null; load(true); }, [load]);
    return { data, loading, error, reload };
}
```

- [ ] **Step 3: 빌드 검증**

Run: `npm run build`
Expected: 성공 (신규 코드는 아직 미사용 — tree-shake 경고 무해)

---

### Task 3: AiStatusBoard 컴포넌트 + CSS

**Files:**
- Create: `src/dashboard/components/AiStatusBoard.jsx`
- Modify: `src/dashboard/dashboard.css` (파일 끝에 ai-* 블록 추가)

**Interfaces:**
- Consumes: Task 1의 `buildGroups, teacherOptions, generatedAtMs, isStale, countParts, gapLabel`; Task 2의 훅 산출 `data={summaries, classSettings, staffByLocal}`와 `allowedStudentIds`·`studentShortLabel`·`toDateStrKST`(firestore-helpers); `renderMarkdown`(`ui-utils.js` — 내부에서 esc 처리라 XSS 안전); `allClassCodes`(student-core); `formatDateTimeKST`(`@impact7/shared/datetime`)
- Produces: `export default AiStatusBoard({ students, data, loading, error, reload, branchFilter, classFilter, gradeFilter })`

- [ ] **Step 1: 컴포넌트 작성**

```jsx
import { useMemo, useState } from 'react';
import { Icon, IconButton } from '@impact7/ui';
import { ICON_NAME } from '../icon-map.js';
import { allClassCodes } from '../../../student-core.js';
import { studentShortLabel, toDateStrKST, allowedStudentIds } from '../../shared/firestore-helpers.js';
import { renderMarkdown } from '../../../ui-utils.js';
import { formatDateTimeKST } from '@impact7/shared/datetime';
import {
    buildGroups, teacherOptions, generatedAtMs, isStale,
    countParts, gapLabel,
} from '../lib/ai-status-view.js';

function FlagList({ title, items }) {
    if (!Array.isArray(items) || !items.length) return null;
    return (
        <div className="ai-list">
            <strong>{title}</strong>
            <ul>{items.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </div>
    );
}

function AiRow({ student, summary, nowMs }) {
    const parts = countParts(summary);
    const gap = gapLabel(summary);
    const ms = generatedAtMs(summary.generated_at);
    return (
        <details className="ai-row">
            <summary className="ai-row-line">
                <strong>{student.name}</strong>
                <span className="ai-sec">{studentShortLabel(student)}</span>
                <span className="ai-sec">{[...new Set(allClassCodes(student))].join(', ')}</span>
                {parts.length > 0 && <span className="ai-counts">{parts.join(' · ')}</span>}
                {gap && <span className="ai-gap">{gap}</span>}
                <span className="ai-date">
                    {ms != null ? toDateStrKST(new Date(ms)) : ''}
                    {isStale(summary.generated_at, nowMs) && <span className="ai-stale-badge">오래됨</span>}
                </span>
            </summary>
            <div className="ai-row-body">
                <div className="markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(summary.summary_markdown) }} />
                <FlagList title="위험 신호" items={summary.risk_flags} />
                <FlagList title="권장 조치" items={summary.action_items} />
                {summary.attendance_comment && <p className="ai-comment"><strong>출결</strong> {summary.attendance_comment}</p>}
                {summary.hw_comment && <p className="ai-comment"><strong>숙제</strong> {summary.hw_comment}</p>}
                {summary.test_comment && <p className="ai-comment"><strong>테스트</strong> {summary.test_comment}</p>}
                <p className="ai-meta">마지막 생성 {formatDateTimeKST(summary.generated_at)}</p>
            </div>
        </details>
    );
}

export default function AiStatusBoard({
    students, data, loading, error, reload, branchFilter, classFilter, gradeFilter,
}) {
    const [teacherKey, setTeacherKey] = useState('');
    const [search, setSearch] = useState('');
    const nowMs = Date.now();

    const teachers = useMemo(
        () => teacherOptions(data?.classSettings, data?.staffByLocal),
        [data],
    );
    const teacherClassCodes = useMemo(() => {
        if (!teacherKey) return null;
        return teachers.find(t => t.key === teacherKey)?.classCodes || new Set();
    }, [teachers, teacherKey]);

    const allowedIds = useMemo(
        () => allowedStudentIds(students, { branchFilter, classFilter, gradeFilter }),
        [students, branchFilter, classFilter, gradeFilter],
    );

    const groups = useMemo(
        () => buildGroups(students, data?.summaries, { allowedIds, teacherClassCodes, search }),
        [students, data, allowedIds, teacherClassCodes, search],
    );

    if (error) {
        return (
            <div className="ai-error" role="alert">
                <p>AI 종합상태를 불러오지 못했습니다.</p>
                <IconButton icon={ICON_NAME.refresh} label="다시 시도" onClick={reload} />
            </div>
        );
    }
    if (loading && !data) return <div className="dash-loading">로딩 중...</div>;

    const total = groups.reduce((n, g) => n + g.items.length, 0);

    return (
        <div className="ai-board">
            <div className="consult-board-bar">
                <label className="ai-teacher-label" htmlFor="ai-teacher-select">담당</label>
                <select id="ai-teacher-select" aria-label="담당" value={teacherKey}
                    onChange={e => setTeacherKey(e.target.value)}>
                    <option value="">전체</option>
                    {teachers.map(t => <option key={t.key} value={t.key}>{t.name}</option>)}
                </select>
                <input type="text" className="consult-search" value={search}
                    placeholder="학생 이름 검색" aria-label="학생 이름 검색"
                    onChange={e => setSearch(e.target.value)} />
                <span className="consult-count">
                    {groups.map(g => `${g.label} ${g.items.length}`).join(' · ')}
                </span>
            </div>

            {!total ? (
                <div className="consult-empty">
                    <Icon name={ICON_NAME.forum} size={40} style={{ opacity: 0.5 }} aria-hidden="true" />
                    <span>{search ? '검색 결과가 없습니다.' : '표시할 학생이 없습니다.'}</span>
                </div>
            ) : (
                groups.map(g => (
                    <details key={g.key} className="ai-group"
                        open={Boolean(search) || g.key === 'risk' || g.key === 'caution'}>
                        <summary className="consult-group-head">
                            <Icon name={ICON_NAME.chevron_right} size={20} className="consult-group-chevron" aria-hidden="true" />
                            <span className={`ai-tone-badge ai-tone-${g.key}`}>{g.label}</span>
                            <span className="consult-group-count">{g.items.length}명</span>
                        </summary>
                        {g.key === 'none' ? (
                            <div className="ai-none-list">
                                <p className="ai-none-hint">AI 분석 미생성 — 생성은 메인앱 학생 상세패널에서 가능합니다.</p>
                                {g.items.map(({ student }) => (
                                    <div key={student.id} className="ai-row-line ai-none-row">
                                        <strong>{student.name}</strong>
                                        <span className="ai-sec">{studentShortLabel(student)}</span>
                                        <span className="ai-sec">{[...new Set(allClassCodes(student))].join(', ')}</span>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            g.items.map(({ student, summary }) => (
                                <AiRow key={student.id} student={student} summary={summary} nowMs={nowMs} />
                            ))
                        )}
                    </details>
                ))
            )}
        </div>
    );
}
```

- [ ] **Step 2: dashboard.css 끝에 스타일 추가**

```css
/* ─── AI 종합상태 뷰 ─────────────────────────────────────────────── */
.ai-board { padding: 0 16px 24px; }
.ai-group { background: #fff; border: 1px solid #dadce0; border-radius: 8px; margin-bottom: 12px; }
.ai-tone-badge { padding: 2px 10px; border-radius: 999px; font-size: 13px; font-weight: 600; }
.ai-tone-risk    { background: #fce8e6; color: #c5221f; }
.ai-tone-caution { background: #fef7e0; color: #b06000; }
.ai-tone-good    { background: #d4e9e2; color: #006241; }
.ai-tone-none    { background: #f1f3f4; color: #5f6368; }
.ai-row { border-top: 1px solid #f1f3f4; }
.ai-row-line { display: flex; align-items: center; gap: 10px; padding: 8px 16px; cursor: pointer; flex-wrap: wrap; font-size: 14px; }
.ai-row-line::-webkit-details-marker { display: none; }
.ai-sec { color: #5f6368; font-size: 13px; }
.ai-counts { color: #c5221f; font-size: 13px; }
.ai-gap { color: #b06000; font-size: 13px; }
.ai-date { margin-left: auto; color: #5f6368; font-size: 12px; display: flex; align-items: center; gap: 6px; }
.ai-stale-badge { background: #f1f3f4; color: #5f6368; border-radius: 4px; padding: 1px 6px; font-size: 11px; }
.ai-row-body { padding: 4px 16px 14px 26px; font-size: 14px; }
.ai-row-body .markdown { margin-bottom: 8px; }
.ai-list ul { margin: 4px 0 8px; padding-left: 18px; }
.ai-comment { margin: 4px 0; color: #3c4043; }
.ai-meta { margin-top: 8px; color: #5f6368; font-size: 12px; }
.ai-none-list { padding: 4px 0 8px; }
.ai-none-hint { padding: 4px 16px; color: #5f6368; font-size: 13px; }
.ai-none-row { cursor: default; }
.ai-teacher-label { font-size: 13px; color: #5f6368; }
.ai-error { text-align: center; padding: 40px 16px; color: #c5221f; }
```

- [ ] **Step 3: 빌드 검증**

Run: `npm run build`
Expected: 성공 (컴포넌트 아직 미배선 — import 그래프 미포함이어도 무방)

---

### Task 4: App.jsx 배선

**Files:**
- Modify: `src/dashboard/App.jsx`

**Interfaces:**
- Consumes: Task 2 `useAiStatusData`, Task 3 `AiStatusBoard`(lazy)

- [ ] **Step 1: view state·lazy import·훅 배선**

```jsx
// 기존 lazy 선언부에 추가
const AiStatusBoard = lazy(() => import('./components/AiStatusBoard.jsx'));
```

`useFirestore.js` import에 `useAiStatusData` 추가.

`view` state 주석 갱신: `// 'logbook' | 'consult' | 'ai'`

데이터 로드부(useConsultations 아래):

```jsx
const aiStatus = useAiStatusData(user, view === 'ai');
```

- [ ] **Step 2: 뷰 토글 버튼 추가** (상담 버튼 다음)

```jsx
<button type="button" className={view === 'ai' ? 'active' : ''} aria-pressed={view === 'ai'} onClick={() => setView('ai')}>AI</button>
```

- [ ] **Step 3: AI 뷰에서 기간 필터 숨김**

필터바의 기간 관련 4개 블록(기간 select + `rangeType === 'day'` + `'week'` + `'custom'` 그룹)을
`{view !== 'ai' && (<> ... </>)}`로 감싼다. 소속·학년·반 그룹은 그대로 둔다.

- [ ] **Step 4: 렌더 분기 추가** — 기존 `view === 'consult' ? ...` 삼항 앞에 AI 분기:

```jsx
{view === 'ai' ? (
    <ErrorBoundary>
        <Suspense fallback={<div className="dash-grid"><SkeletonCard /><SkeletonCard /><SkeletonCard /></div>}>
            <AiStatusBoard
                students={students}
                data={aiStatus.data}
                loading={aiStatus.loading}
                error={aiStatus.error}
                reload={aiStatus.reload}
                branchFilter={branchFilter}
                classFilter={classFilter}
                gradeFilter={gradeFilter}
            />
        </Suspense>
    </ErrorBoundary>
) : view === 'consult' ? (
    ...기존 그대로...
```

- [ ] **Step 5: 전체 테스트 + 빌드**

Run: `npm test && npm run build`
Expected: 전건 PASS + 빌드 성공

---

### Task 5: 품질 게이트 + 검증 (메인 스레드 — codex 아님)

- [ ] **Step 1:** `/simplify` 실행, 결과 반영
- [ ] **Step 2:** `/code-review` 실행, Critical/Major 반영
- [ ] **Step 3:** 브라우저 검증 (READ-ONLY dev, `npm run dev` → http://localhost:5174/dashboard.html)
  - AI 토글 진입, 상태 그룹·총계 표시
  - 담당/소속/학년/반/검색 필터 조합
  - 행 확장(마크다운·위험신호·권장조치·코멘트), 오래됨 배지, 미생성 그룹
  - 로그북·상담 뷰 회귀 없음(기간 필터 다시 표시되는지)
- [ ] **Step 4:** staged 후 `node /Users/jongsooyi/projects/impact7DB/.agents/hooks/impact7-precommit-quality-guard.mjs --mark`
- [ ] **Step 5:** 사용자에게 결과 보고 — 커밋은 사용자 승인 후 1회
