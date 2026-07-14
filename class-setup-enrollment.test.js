import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildClassTimeFields,
    hasActiveRegularClass,
    resolveRegularDefaultTime,
    uniquePlanningEnrollments,
} from './class-setup-enrollment.js';
import { computeExpectedArrival, startTime } from '@impact7/shared/expected-arrival';

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

test('반 유형별 시간 필드를 분리 저장한다', () => {
    const schedule = { 월: '16:00' };
    assert.deepEqual(
        buildClassTimeFields('정규', ['화', '목'], {}, '19:10'),
        { default_days: ['화', '목'], default_time: '19:10' },
    );
    assert.deepEqual(buildClassTimeFields('내신', ['월'], schedule), { schedule });
    assert.deepEqual(buildClassTimeFields('자유학기', ['월'], schedule), { free_schedule: schedule });
    assert.deepEqual(buildClassTimeFields('특강', ['월'], schedule), { schedule });
});

test('기존 정규반 시간은 직접 수정하지 않으면 보존한다', () => {
    assert.equal(resolveRegularDefaultTime('16:00', false, '19:10'), '19:10');
    assert.equal(resolveRegularDefaultTime('16:00', true, '19:10'), '16:00');
    assert.equal(resolveRegularDefaultTime('16:00', false, ''), '16:00');
});

test('shared 시간 해석은 정규 기본시간과 기간 override를 구분한다', () => {
    const regular = { class_type: '정규', level_symbol: 'HA', class_number: '104' };
    const derivedFree = { ...regular, class_type: '자유학기', schedule: { 화: '18:00' } };
    const settings = {
        HA104: {
            default_time: '19:10',
            schedule: { 화: '17:10' },
            free_schedule: { 화: '18:00' },
        },
    };

    assert.equal(startTime(regular, '화', settings), '19:10');
    assert.equal(startTime(derivedFree, '화', settings), '18:00');
});

test('기간 override 종료 후 정규 기본시간으로 복귀한다', () => {
    const enrollments = [{
        class_type: '정규', level_symbol: 'HA', class_number: '104', day: ['화'],
        start_date: '2026-01-01', naesin_class_override: 'NAESIN1',
    }];
    const classSettings = {
        HA104: {
            default_time: '19:10', schedule: { 화: '17:10' },
            free_start: '2026-08-10', free_end: '2026-08-16', free_schedule: { 화: '18:00' },
        },
        NAESIN1: {
            naesin_start: '2026-07-14', naesin_end: '2026-07-20', schedule: { 화: '17:30' },
        },
    };
    const expectedAt = date => computeExpectedArrival({ enrollments, classSettings, date });

    assert.equal(expectedAt('2026-07-14'), '17:30');
    assert.equal(expectedAt('2026-07-21'), '19:10');
    assert.equal(expectedAt('2026-08-11'), '18:00');
    assert.equal(expectedAt('2026-08-18'), '19:10');
});
