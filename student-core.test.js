import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeDays,
    enrollmentCode,
    branchFromStudent,
    allClassCodes,
    summarizeEnrollmentClasses,
    makeDailyRecordId,
    buildNaesinCsKey,
    NAESIN_OVERRIDE_EXCLUDE,
    resolveNaesinCsKey,
    displayCodeFromCsKey,
    isWithdrawnAt,
    isOnLeaveAt,
    createSiblingMap,
    studentMatchesSearchTerms,
    siblingStatusSuffix,
    isNewTenureStart,
    isCurrentNewTenure,
    isPotentialNewStudent,
    findSeparateTeukangVisit,
} from './student-core.js';
import { deriveTenure } from '@impact7/shared/history';

// ─── normalizeDays ────────────────────────────────────────────────────────────

test('normalizeDays: falsy → 빈 배열', () => {
    assert.deepEqual(normalizeDays(null), []);
    assert.deepEqual(normalizeDays(undefined), []);
    assert.deepEqual(normalizeDays(''), []);
});

test('normalizeDays: 배열 입력 — "요일" 접미사 제거', () => {
    assert.deepEqual(normalizeDays(['월요일', '수요일', '금요일']), ['월', '수', '금']);
    assert.deepEqual(normalizeDays(['월', '수']), ['월', '수']);
});

test('normalizeDays: 문자열 — 콤마·가운뎃점·공백 분리', () => {
    assert.deepEqual(normalizeDays('월,수,금'), ['월', '수', '금']);
    assert.deepEqual(normalizeDays('월·수·금'), ['월', '수', '금']);
    assert.deepEqual(normalizeDays('월 수 금'), ['월', '수', '금']);
    assert.deepEqual(normalizeDays('월요일,수요일'), ['월', '수']);
});

// ─── enrollmentCode ───────────────────────────────────────────────────────────

test('enrollmentCode: null/undefined → 빈 문자열', () => {
    assert.equal(enrollmentCode(null), '');
    assert.equal(enrollmentCode(undefined), '');
});

test('enrollmentCode: level_symbol + class_number 결합', () => {
    assert.equal(enrollmentCode({ level_symbol: 'A', class_number: '101' }), 'A101');
});

test('enrollmentCode: 누락 필드는 빈 문자열로 처리', () => {
    assert.equal(enrollmentCode({ level_symbol: 'A' }), 'A');
    assert.equal(enrollmentCode({ class_number: '101' }), '101');
    assert.equal(enrollmentCode({}), '');
});

// ─── branchFromStudent ────────────────────────────────────────────────────────

test('branchFromStudent: branch 필드 우선', () => {
    assert.equal(branchFromStudent({ branch: '2단지' }), '2단지');
    assert.equal(branchFromStudent({ branch: '10단지', enrollments: [{ class_number: '201' }] }), '10단지');
});

test('branchFromStudent: class_number 첫 자리 1 → 2단지', () => {
    assert.equal(branchFromStudent({ enrollments: [{ class_number: '101' }] }), '2단지');
});

test('branchFromStudent: class_number 첫 자리 2 → 10단지', () => {
    assert.equal(branchFromStudent({ enrollments: [{ class_number: '201' }] }), '10단지');
});

test('branchFromStudent: 판별 불가 → 빈 문자열', () => {
    assert.equal(branchFromStudent({}), '');
    assert.equal(branchFromStudent({ enrollments: [] }), '');
    assert.equal(branchFromStudent({ enrollments: [{ class_number: '301' }] }), '');
});

// 내신 csKey 접두('10단지…'/'2단지…')는 첫 글자 규칙보다 먼저 판정해야 한다.
// 로컬 재구현은 첫 글자만 봐서 '10단지…'를 '1'→2단지로 오분류했다(shared와 drift). F-03.
test('branchFromStudent: "10단지…" 접두 우선 (첫 글자 1 규칙보다 먼저)', () => {
    assert.equal(branchFromStudent({ enrollments: [{ class_number: '10단지목동중1A' }] }), '10단지');
});

test('branchFromStudent: "2단지…" 접두', () => {
    assert.equal(branchFromStudent({ enrollments: [{ class_number: '2단지양정중중2A' }] }), '2단지');
});

// ─── allClassCodes ────────────────────────────────────────────────────────────

test('allClassCodes: enrollments 없으면 빈 배열', () => {
    assert.deepEqual(allClassCodes({}), []);
    assert.deepEqual(allClassCodes({ enrollments: [] }), []);
});

test('allClassCodes: 코드 목록 반환, 빈 코드 제외', () => {
    const s = {
        enrollments: [
            { level_symbol: 'A', class_number: '101' },
            { level_symbol: 'B', class_number: '201' },
            { level_symbol: '', class_number: '' },
        ],
    };
    assert.deepEqual(allClassCodes(s), ['A101', 'B201']);
});

test('summarizeEnrollmentClasses: 정규와 기타 수강을 순서대로 묶고 중복을 제거', () => {
    assert.deepEqual(summarizeEnrollmentClasses([
        { class_type: '특강', level_symbol: '고급', class_number: 'A' },
        { class_type: '정규', level_symbol: 'A', class_number: '101' },
        { class_type: '자유학기', level_symbol: 'F', class_number: '201' },
        { class_type: '정규', level_symbol: 'A', class_number: '101' },
    ]), {
        regular: 'A101',
        other: '특강 고급A · 자유학기 F201',
    });
});

// ─── makeDailyRecordId ────────────────────────────────────────────────────────

test('makeDailyRecordId: studentId_date 형식', () => {
    assert.equal(makeDailyRecordId('abc123', '2026-06-09'), 'abc123_2026-06-09');
});

test('신규생: 반 이동일이 아닌 현재 연속 재원기간의 첫 등원일을 기준으로 한다', () => {
    const logs = [{ change_type: 'ENROLL', before: '—', after: '신규 등록: 학생 (HS201)', date: '2026-03-06' }];
    const { start } = deriveTenure(
        logs,
        log => new Date(`${log.date}T00:00:00+09:00`),
        [
            { date: '2026-03-13', status: '출석' },
            { date: '2026-07-10', status: '출석' },
        ],
        true
    );
    assert.equal(start.toISOString(), '2026-03-12T15:00:00.000Z');
    assert.equal(isNewTenureStart(start, new Date('2026-07-20T00:00:00+09:00'), 14), false);
});

test('신규생: 휴원은 이어가고 퇴원 후 재등원은 새 재원기간으로 계산한다', () => {
    const logs = [
        { change_type: 'ENROLL', before: '—', after: '신규 등록: 학생 (A101)', date: '2024-01-01' },
        { change_type: 'UPDATE', before: '상태:재원', after: '상태:실휴원', date: '2024-05-01' },
        { change_type: 'UPDATE', before: '상태:실휴원', after: '상태:재원', date: '2024-06-01' },
        { change_type: 'WITHDRAW', before: '{"status":"재원"}', after: '{"status":"퇴원"}', date: '2024-10-25' },
        { change_type: 'UPDATE', before: '상태:퇴원', after: '상태:재원', date: '2026-02-25' },
    ];
    const { start } = deriveTenure(
        logs,
        log => new Date(`${log.date}T00:00:00+09:00`),
        [
            { date: '2024-01-01', status: '출석' },
            { date: '2024-06-02', status: '출석' },
            { date: '2026-03-02', status: '출석' },
        ],
        true
    );
    assert.equal(start.toISOString(), '2026-03-01T15:00:00.000Z');
});

test('신규생: 현재 재원계열이며 종료되지 않은 재원기간만 N으로 판정한다', () => {
    const today = new Date('2026-07-20T00:00:00+09:00');
    const start = new Date('2026-07-13T00:00:00+09:00');
    assert.equal(isCurrentNewTenure({ start, end: null }, '재원', today, 14), true);
    assert.equal(isCurrentNewTenure({ start, end: new Date('2026-07-18T00:00:00+09:00') }, '퇴원', today, 14), false);
    assert.equal(isCurrentNewTenure({ start, end: null }, '상담', today, 14), false);
});

test('신규생 조회 후보: 과거 enrollment가 남아있어도 최근 enrollment가 있으면 조회한다', () => {
    assert.equal(isPotentialNewStudent([
        { level_symbol: 'A', class_number: '101', start_date: '2024-01-01' },
        { level_symbol: 'B', class_number: '202', start_date: '2026-07-18' },
    ], new Date('2026-07-20T00:00:00+09:00'), 14), true);
});

test('신규생 조회 후보: 등록일이 오래됐어도 최근 신규 기간 안에 출석했으면 조회한다', () => {
    assert.equal(isPotentialNewStudent([
        { level_symbol: 'A', class_number: '101', start_date: '2026-06-01' },
    ], new Date('2026-07-20T00:00:00+09:00'), 14, true), true);
});

test('createSiblingMap: 재원·퇴원 학생도 같은 학부모 전화면 서로 형제로 연결', () => {
    const map = createSiblingMap([
        { docId: 'active', name: '재원형제', status: '재원', parent_phone_1: '010-1234-5678' },
        { docId: 'past', name: '퇴원형제', status: '퇴원', parent_phone_2: '01012345678' },
        { docId: 'same-name', name: '재원형제', status: '퇴원', parent_phone_1: '010-1234-5678' },
    ]);
    assert.deepEqual([...map.active], ['past']);
    assert.deepEqual([...map.past], ['active', 'same-name']);
});

test('studentMatchesSearchTerms: 상태와 무관하게 한 글자·중간 이름·학부모 전화 검색', () => {
    for (const status of ['상담', '등원예정', '재원', '실휴원', '가휴원', '퇴원', '종강']) {
        const student = { name: '조아라', status, parent_phone_1: '010-1234-5678' };
        assert.equal(studentMatchesSearchTerms(student, '아'), true);
        assert.equal(studentMatchesSearchTerms(student, '아라'), true);
        assert.equal(studentMatchesSearchTerms(student, '0101234'), true);
        assert.equal(studentMatchesSearchTerms(student, '없는학생'), false);
    }
});

test('siblingStatusSuffix: 상담·퇴원·종강 형제만 상태를 구분', () => {
    assert.equal(siblingStatusSuffix('상담'), ' (상담)');
    assert.equal(siblingStatusSuffix('퇴원'), ' (퇴원)');
    assert.equal(siblingStatusSuffix('종강'), ' (종강)');
    assert.equal(siblingStatusSuffix('재원'), '');
});

// ─── buildNaesinCsKey ─────────────────────────────────────────────────────────

test('buildNaesinCsKey: 모든 필드 결합', () => {
    assert.equal(buildNaesinCsKey({ branch: '2단지', school: '양정중', level: '중', grade: '2', group: 'A' }), '2단지양정중중2A');
});

test('buildNaesinCsKey: 누락 필드는 빈 문자열', () => {
    assert.equal(buildNaesinCsKey({ school: '양정중', level: '중', grade: '2', group: 'A' }), '양정중중2A');
    assert.equal(buildNaesinCsKey({}), '');
});

// ─── resolveNaesinCsKey ───────────────────────────────────────────────────────

test('resolveNaesinCsKey: regularEnroll 없으면 null', () => {
    assert.equal(resolveNaesinCsKey({}, null), null);
    assert.equal(resolveNaesinCsKey({}, undefined), null);
});

test('resolveNaesinCsKey: override가 문자열이 아니면 null', () => {
    assert.equal(resolveNaesinCsKey({}, {}), null);
    assert.equal(resolveNaesinCsKey({}, { naesin_class_override: 123 }), null);
});

test('resolveNaesinCsKey: NAESIN_OVERRIDE_EXCLUDE("") → null (명시적 배제)', () => {
    assert.equal(resolveNaesinCsKey({}, { naesin_class_override: NAESIN_OVERRIDE_EXCLUDE }), null);
});

test('resolveNaesinCsKey: 비어있지 않은 override → csKey 반환', () => {
    assert.equal(resolveNaesinCsKey({}, { naesin_class_override: '2단지양정중중2A' }), '2단지양정중중2A');
});

// ─── displayCodeFromCsKey ─────────────────────────────────────────────────────

test('displayCodeFromCsKey: 빈 csKey → 빈 문자열', () => {
    assert.equal(displayCodeFromCsKey('', '2단지'), '');
    assert.equal(displayCodeFromCsKey(null, '2단지'), '');
});

test('displayCodeFromCsKey: branch가 접두사이면 제거', () => {
    assert.equal(displayCodeFromCsKey('2단지양정중중2A', '2단지'), '양정중중2A');
});

test('displayCodeFromCsKey: branch 없거나 불일치 → 원본 반환', () => {
    assert.equal(displayCodeFromCsKey('양정중중2A', ''), '양정중중2A');
    assert.equal(displayCodeFromCsKey('양정중중2A', '10단지'), '양정중중2A');
});

// ─── isWithdrawnAt ────────────────────────────────────────────────────────────

test('isWithdrawnAt: status=퇴원 → 항상 true', () => {
    assert.equal(isWithdrawnAt({ status: '퇴원' }, '2026-06-09'), true);
});

test('isWithdrawnAt: 명시적 활성 status → false', () => {
    for (const status of ['재원', '등원예정', '실휴원', '가휴원', '상담']) {
        assert.equal(isWithdrawnAt({ status, withdrawal_date: '2020-01-01' }, '2026-06-09'), false,
            `status=${status}이면 withdrawal_date 무시`);
    }
});

test('isWithdrawnAt: withdrawal_date 도래 → true', () => {
    assert.equal(isWithdrawnAt({ withdrawal_date: '2026-06-01' }, '2026-06-09'), true);
});

test('isWithdrawnAt: withdrawal_date 미래 → false', () => {
    assert.equal(isWithdrawnAt({ withdrawal_date: '2026-12-31' }, '2026-06-09'), false);
});

test('isWithdrawnAt: withdrawal_date 없고 status 없음 → false', () => {
    assert.equal(isWithdrawnAt({}, '2026-06-09'), false);
});

// ─── isOnLeaveAt ──────────────────────────────────────────────────────────────

test('isOnLeaveAt: 가휴원/실휴원이고 날짜 범위 내 → true', () => {
    const s = { status: '가휴원', pause_start_date: '2026-06-01', pause_end_date: '2026-06-30' };
    assert.equal(isOnLeaveAt(s, '2026-06-09'), true);
    assert.equal(isOnLeaveAt(s, '2026-06-01'), true);
    assert.equal(isOnLeaveAt(s, '2026-06-30'), true);
});

test('isOnLeaveAt: 가휴원이지만 날짜 범위 밖 → false', () => {
    const s = { status: '가휴원', pause_start_date: '2026-06-01', pause_end_date: '2026-06-30' };
    assert.equal(isOnLeaveAt(s, '2026-05-31'), false);
    assert.equal(isOnLeaveAt(s, '2026-07-01'), false);
});

test('isOnLeaveAt: 가휴원이고 날짜 없으면 → true (안전 fallback)', () => {
    assert.equal(isOnLeaveAt({ status: '실휴원' }, '2026-06-09'), true);
});

test('isOnLeaveAt: 재원/등원예정/상담 → false', () => {
    for (const status of ['재원', '등원예정', '상담']) {
        assert.equal(isOnLeaveAt({ status, scheduled_leave_status: '가휴원', pause_start_date: '2026-06-01', pause_end_date: '2026-06-30' }, '2026-06-09'), false,
            `NON_LEAVE_ACTIVE ${status}는 scheduled_leave_status 무시`);
    }
});

test('isOnLeaveAt: status 없고 scheduled_leave_status 범위 내 → true', () => {
    const s = { scheduled_leave_status: '가휴원', pause_start_date: '2026-06-01', pause_end_date: '2026-06-30' };
    assert.equal(isOnLeaveAt(s, '2026-06-09'), true);
});

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

test('findSeparateTeukangVisit: 주 수업 2개 중 가까운 것 기준 — 근접 정규 있으면 통합', () => {
    const reg2 = { class_type: '정규', level_symbol: 'HA', class_number: '201' };
    // 특강 16:00: 정규 14:00과 120분(근접) → 통합. 배열 첫 정규가 19:00이어도 통합이어야 함.
    const getTime = (e) => {
        if (e.class_type === '특강') return '16:00';
        return e.class_number === '201' ? '14:00' : '19:00';
    };
    assert.equal(findSeparateTeukangVisit([_reg, reg2, _tk()], getTime), null);
});
