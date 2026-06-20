import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeDays,
    enrollmentCode,
    branchFromStudent,
    allClassCodes,
    makeDailyRecordId,
    buildNaesinCsKey,
    NAESIN_OVERRIDE_EXCLUDE,
    resolveNaesinCsKey,
    displayCodeFromCsKey,
    isWithdrawnAt,
    isOnLeaveAt,
} from './student-core.js';

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

// ─── makeDailyRecordId ────────────────────────────────────────────────────────

test('makeDailyRecordId: studentId_date 형식', () => {
    assert.equal(makeDailyRecordId('abc123', '2026-06-09'), 'abc123_2026-06-09');
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
