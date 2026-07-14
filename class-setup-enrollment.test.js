import test from 'node:test';
import assert from 'node:assert/strict';
import {
    hasActiveRegularClass,
    scheduleFieldsForClassType,
    uniquePlanningEnrollments,
} from './class-setup-enrollment.js';

test('정규반 분석은 같은 학생의 동일 반코드를 한 번만 반환한다', () => {
    const enrollments = [
        { class_type: '정규', level_symbol: 'I', class_number: '201', start_date: '2026-06-01' },
        { class_type: '정규', level_symbol: 'I', class_number: '201', start_date: '2026-06-06' },
        { class_type: '자유학기', level_symbol: 'FA', class_number: '201', start_date: '2026-06-09' },
    ];

    const result = uniquePlanningEnrollments(enrollments, '2026-06-06');

    assert.deepEqual(
        result.map(enrollment => `${enrollment.level_symbol}${enrollment.class_number}`),
        ['I201', 'FA201'],
    );
});

test('같은 활성 정규반은 중복 등록으로 판정한다', () => {
    const enrollments = [
        { class_type: '정규', level_symbol: 'I', class_number: '201', start_date: '2026-06-01' },
    ];

    assert.equal(hasActiveRegularClass(enrollments, 'I201', '2026-06-06'), true);
    assert.equal(hasActiveRegularClass(enrollments, 'I202', '2026-06-06'), false);
});

test('이미 종료된 동일 정규반은 신규 등록을 막지 않는다', () => {
    const enrollments = [
        {
            class_type: '정규',
            level_symbol: 'I',
            class_number: '201',
            start_date: '2025-06-01',
            end_date: '2025-12-31',
        },
    ];

    assert.equal(hasActiveRegularClass(enrollments, 'I201', '2026-06-06'), false);
});

test('반 유형별 schedule 필드는 정규를 제외하고 분리 저장한다', () => {
    const schedule = { 월: '16:00' };
    assert.deepEqual(scheduleFieldsForClassType('정규', schedule), {});
    assert.deepEqual(scheduleFieldsForClassType('내신', schedule), { schedule });
    assert.deepEqual(scheduleFieldsForClassType('자유학기', schedule), { free_schedule: schedule });
    assert.deepEqual(scheduleFieldsForClassType('특강', schedule), { schedule });
});
