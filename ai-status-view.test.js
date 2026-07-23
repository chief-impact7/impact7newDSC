import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    STATUS_GROUPS, summaryStatusKey, generatedAtMs, isStale,
    teacherOptions, buildGroups, countParts, gapLabel,
} from './src/dashboard/lib/ai-status-view.js';

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-07-21T12:00:00+09:00').getTime();

const students = [
    { id: 's1', name: '김가', status: '재원', enrollments: [{ level_symbol: 'A', class_number: '101' }] },
    { id: 's2', name: '이나', status: '재원', enrollments: [{ level_symbol: 'B', class_number: '203' }] },
    { id: 's3', name: '박다', status: '재원', enrollments: [{ level_symbol: 'A', class_number: '101' }] },
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

test('buildGroups: summary가 없으면 생성 대상 상태만 미생성 그룹에 포함', () => {
    const statusStudents = [
        { id: 'active', name: '재원 학생', status: '재원' },
        { id: 'scheduled', name: '예정 학생', status: '등원예정' },
        { id: 'leave', name: '휴원 학생', status: '실휴원' },
        { id: 'temporary-leave', name: '가휴원 학생', status: '가휴원' },
        { id: 'consult', name: '상담 학생', status: '상담' },
        { id: 'special', name: '특강 학생', status: '특강' },
        { id: 'consult-summary', name: '분석된 상담 학생', status: '상담' },
    ];
    const statusSummaries = { 'consult-summary': { status: 'good' } };

    const groups = Object.fromEntries(buildGroups(statusStudents, statusSummaries).map(group => [group.key, group.items]));
    const allItems = Object.values(groups).flat();

    assert.deepEqual(groups.none.map(item => item.student.id).sort(), ['active', 'leave', 'scheduled', 'temporary-leave']);
    assert.deepEqual(groups.good.map(item => item.student.id), ['consult-summary']);
    assert.equal(allItems.some(item => item.student.id === 'consult'), false);
    assert.equal(allItems.some(item => item.student.id === 'special'), false);
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

test('학생 ID를 인라인 JavaScript에 삽입하지 않는다', () => {
    const source = readFileSync(new URL('./student-status-card.js', import.meta.url), 'utf8');

    assert.doesNotMatch(source, /onclick="onGenerateStudentStatusAi/);
    assert.match(source, /\.status-ai-btn'\)\?\.addEventListener\('click'/);
});
