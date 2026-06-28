// enrollment/내신/자유학기/휴원 활성 판정 회귀 테스트 (vitest)
//
// 과거 실제 사고(이예원 유령 2026-05-31, 류하율 A101 2026-06-15, 263건 2026-05)를 낸
// "활성 enrollment·대표 정렬·내신/자유 파생·휴원 만료" 순수 로직을 현재 동작 그대로 잠근다.
// Step 3b(enrollment 전파·fail-action 통합)의 안전망.
//
// 루트 student-helpers.js가 state.js → firestore-helpers.js → firebase-config.js를 import하므로
// import.meta.env가 필요해 node:test가 아닌 vitest로 돌린다(src/test-setup.js가 localStorage 스텁).
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { state } from '../../state.js';
import { enrollmentCode } from '../../student-core.js';
import {
    getActiveEnrollments,
    isActiveNaesinBase,
    isNaesinActiveToday,
    isFreeSemesterActiveToday,
    isPauseExpired,
    pauseExpiredDays,
    activeClassCodes,
} from '../../student-helpers.js';

// 프로덕션 enrollmentCode를 그대로 사용 — 코드 포맷이 바뀌면 테스트도 함께 따라가
// 파생/대표정렬 검증이 옛 포맷에 갇히지 않도록 한다.
const codes = (enrollments) => enrollments.map(e => enrollmentCode(e));
const TODAY = '2026-06-28';

beforeEach(() => {
    state.classSettings = {};
});

// ─── getActiveEnrollments: 날짜 필터 ────────────────────────────────────────
describe('getActiveEnrollments — 날짜 필터', () => {
    test('미래 start_date 제외, 과거 end_date 제외, 경계일(==today) 포함', () => {
        const s = { enrollments: [
            { class_type: '정규', level_symbol: 'A', class_number: '101', day: ['월'] },          // 날짜 없음 → 유지
            { class_type: '특강', level_symbol: 'T', class_number: '1', start_date: '2026-07-01' }, // 미래 시작 → 제외
            { class_type: '특강', level_symbol: 'T', class_number: '2', end_date: '2026-06-01' },   // 과거 종료 → 제외
            { class_type: '특강', level_symbol: 'T', class_number: '3', end_date: '2026-06-28' },   // 종료==오늘 → 유지
            { class_type: '특강', level_symbol: 'T', class_number: '4', start_date: '2026-06-28' }, // 시작==오늘 → 유지
        ]};
        expect(codes(getActiveEnrollments(s, TODAY))).toEqual(['A101', 'T3', 'T4']);
    });

    test('end_date 없는 정규는 유지, start_date 없는 옛 데이터도 유지', () => {
        const s = { enrollments: [
            { class_type: '정규', level_symbol: 'A', class_number: '101', day: ['월'] },
        ]};
        expect(codes(getActiveEnrollments(s, TODAY))).toEqual(['A101']);
    });

    test('enrollments 없음 → 빈 배열', () => {
        expect(getActiveEnrollments({ enrollments: [] }, TODAY)).toEqual([]);
        expect(getActiveEnrollments({}, TODAY)).toEqual([]);
    });
});

// ─── getActiveEnrollments: 내신/자유 파생 (사고 클래스) ──────────────────────
describe('getActiveEnrollments — 내신/자유 파생', () => {
    test('명시적 내신(활성)이 정규를 숨기고 대표(맨 앞)로 정렬 — 류하율 A101 사고', () => {
        const s = { enrollments: [
            { class_type: '정규', level_symbol: 'A', class_number: '101', day: ['월'] },
            { class_type: '내신', level_symbol: '', class_number: '중2A', start_date: '2026-06-01', end_date: '2026-12-31', day: ['화'] },
            { class_type: '특강', level_symbol: 'T', class_number: '9' },
        ]};
        const out = getActiveEnrollments(s, TODAY);
        expect(out[0].class_type).toBe('내신');           // 내신이 대표(맨 앞)
        expect(codes(out)).toEqual(['중2A', 'T9']);        // 정규 A101 숨김, 특강 유지
    });

    test('override→classSettings 내신기간 파생(정규+naesin_class_override) — 이예원/마법사 경로', () => {
        state.classSettings = { '중2A': { naesin_start: '2026-06-01', naesin_end: '2026-12-31', schedule: { '화': '18:00' } } };
        const s = { enrollments: [
            { class_type: '정규', level_symbol: 'A', class_number: '101', day: ['월'], naesin_class_override: '중2A' },
        ]};
        const out = getActiveEnrollments(s, TODAY);
        expect(out).toHaveLength(1);
        expect(out[0].class_type).toBe('내신');
        expect(out[0].class_number).toBe('중2A');
        expect(out[0].day).toEqual(['화']);                // schedule 키에서 등원요일 파생
    });

    test('내신기간이 지나면 정규로 복귀(파생 안 함)', () => {
        state.classSettings = { '중2A': { naesin_start: '2025-01-01', naesin_end: '2025-12-31', schedule: { '화': '18:00' } } };
        const s = { enrollments: [
            { class_type: '정규', level_symbol: 'A', class_number: '101', day: ['월'], naesin_class_override: '중2A' },
        ]};
        const out = getActiveEnrollments(s, TODAY);
        expect(codes(out)).toEqual(['A101']);
        expect(out[0].class_type).toBe('정규');
    });

    test('명시적 자유학기(활성)가 동일코드 정규를 숨기고 대표로 정렬', () => {
        const s = { enrollments: [
            { class_type: '정규', level_symbol: 'FA', class_number: '201', day: ['월'] },
            { class_type: '자유학기', level_symbol: 'FA', class_number: '201', start_date: '2026-06-01', day: ['수'] },
        ]};
        const out = getActiveEnrollments(s, TODAY);
        expect(out).toHaveLength(1);
        expect(out[0].class_type).toBe('자유학기');
        expect(codes(out)).toEqual(['FA201']);
    });

    test('classSettings free 기간 파생: 정규 반코드의 free 윈도우가 정규를 자유학기로 치환', () => {
        state.classSettings = { 'A101': { free_start: '2026-06-01', free_end: '2026-12-31', free_schedule: { '수': '15:00' } } };
        const s = { enrollments: [
            { class_type: '정규', level_symbol: 'A', class_number: '101', day: ['월'] },
        ]};
        const out = getActiveEnrollments(s, TODAY);
        expect(out).toHaveLength(1);
        expect(out[0].class_type).toBe('자유학기');
        expect(codes(out)).toEqual(['A101']);
        expect(out[0].day).toEqual(['수']);            // free_schedule 키에서 등원요일 파생
    });

    test('개별 naesin_days override가 반 기본 schedule 요일을 덮는다 (5d46201 델타 기능)', () => {
        state.classSettings = { '중2A': { naesin_start: '2026-06-01', naesin_end: '2026-12-31', schedule: { '화': '18:00' } } };
        const s = { enrollments: [
            { class_type: '정규', level_symbol: 'A', class_number: '101', day: ['월'], naesin_class_override: '중2A', naesin_days: ['목', '금'] },
        ]};
        const out = getActiveEnrollments(s, TODAY);
        expect(out[0].class_type).toBe('내신');
        expect(out[0].day).toEqual(['목', '금']);       // 반 schedule('화')가 아니라 개별 naesin_days
    });

    test('내신·자유 동시 활성 시 내신이 우선 (내신 > 자유 > 정규)', () => {
        const s = { enrollments: [
            { class_type: '정규', level_symbol: 'A', class_number: '101', day: ['월'] },
            { class_type: '자유학기', level_symbol: 'A', class_number: '101', start_date: '2026-06-01', day: ['수'] },
            { class_type: '내신', class_number: '중2A', start_date: '2026-06-01', end_date: '2026-12-31', day: ['화'] },
        ]};
        const out = getActiveEnrollments(s, TODAY);
        expect(out.map(e => e.class_type)).toEqual(['내신']);  // 자유·정규 모두 숨김
        expect(codes(out)).toEqual(['중2A']);
    });
});

// ─── isActiveNaesinBase: 이예원 유령 가드 ───────────────────────────────────
describe('isActiveNaesinBase — 내신 base 적격 정규/자유', () => {
    test('정규(요일 있음, 종료 없음) → true', () => {
        expect(isActiveNaesinBase({ class_type: '정규', day: ['월'] }, TODAY)).toBe(true);
    });
    test('정규(요일 있음, 종료 미래) → true', () => {
        expect(isActiveNaesinBase({ class_type: '정규', day: ['월'], end_date: '2026-12-31' }, TODAY)).toBe(true);
    });
    test('정규(종료 과거) → false (죽은 정규)', () => {
        expect(isActiveNaesinBase({ class_type: '정규', day: ['월'], end_date: '2026-01-01' }, TODAY)).toBe(false);
    });
    test('정규(요일 없음) → false', () => {
        expect(isActiveNaesinBase({ class_type: '정규' }, TODAY)).toBe(false);
        expect(isActiveNaesinBase({ class_type: '정규', day: [] }, TODAY)).toBe(false);
    });
    test('자유학기(요일 없어도) → true, 종료 과거면 false', () => {
        expect(isActiveNaesinBase({ class_type: '자유학기' }, TODAY)).toBe(true);
        expect(isActiveNaesinBase({ class_type: '자유학기', end_date: '2026-01-01' }, TODAY)).toBe(false);
    });
    test('내신·특강은 base 아님 → false', () => {
        expect(isActiveNaesinBase({ class_type: '내신', day: ['월'] }, TODAY)).toBe(false);
        expect(isActiveNaesinBase({ class_type: '특강', day: ['월'] }, TODAY)).toBe(false);
    });
});

// ─── isNaesinActiveToday ────────────────────────────────────────────────────
describe('isNaesinActiveToday', () => {
    test('명시적 내신(활성) → true', () => {
        const s = { enrollments: [
            { class_type: '내신', class_number: '중2A', start_date: '2026-06-01', end_date: '2026-12-31' },
        ]};
        expect(isNaesinActiveToday(s, TODAY)).toBe(true);
    });
    test('내신 종료 후 → false', () => {
        const s = { enrollments: [
            { class_type: '내신', class_number: '중2A', start_date: '2025-06-01', end_date: '2025-12-31' },
        ]};
        expect(isNaesinActiveToday(s, TODAY)).toBe(false);
    });
    test('내신 없음 → false', () => {
        const s = { enrollments: [{ class_type: '정규', level_symbol: 'A', class_number: '101', day: ['월'] }] };
        expect(isNaesinActiveToday(s, TODAY)).toBe(false);
    });
});

// ─── isFreeSemesterActiveToday ──────────────────────────────────────────────
describe('isFreeSemesterActiveToday', () => {
    test('자유학기 enrollment(시작 과거, 종료 없음) → true', () => {
        const s = { enrollments: [{ class_type: '자유학기', level_symbol: 'FA', class_number: '201', start_date: '2026-06-01' }] };
        expect(isFreeSemesterActiveToday(s, TODAY)).toBe(true);
    });
    test('classSettings free 기간이 오늘을 덮으면 → true', () => {
        state.classSettings = { 'A101': { free_start: '2026-06-01', free_end: '2026-12-31' } };
        const s = { enrollments: [{ class_type: '정규', level_symbol: 'A', class_number: '101', day: ['월'] }] };
        expect(isFreeSemesterActiveToday(s, TODAY)).toBe(true);
    });
    test('자유학기 종료 후 → false', () => {
        const s = { enrollments: [{ class_type: '자유학기', level_symbol: 'FA', class_number: '201', start_date: '2025-01-01', end_date: '2025-12-31' }] };
        expect(isFreeSemesterActiveToday(s, TODAY)).toBe(false);
    });
});

// ─── 휴원 만료 (isPauseExpired / pauseExpiredDays) ──────────────────────────
describe('휴원 만료 판정', () => {
    test('휴원 상태 아니면 → false / 0', () => {
        expect(isPauseExpired({ status: '재원', pause_end_date: '2020-01-01' })).toBe(false);
        expect(pauseExpiredDays({ status: '재원', pause_end_date: '2020-01-01' })).toBe(0);
    });
    test('휴원이지만 pause_end_date 없으면 → false / 0', () => {
        expect(isPauseExpired({ status: '가휴원' })).toBe(false);
        expect(pauseExpiredDays({ status: '실휴원' })).toBe(0);
    });
    test('휴원 + 만료일 과거 → true, 경과일 ≥ 1', () => {
        const s = { status: '실휴원', pause_end_date: '2020-01-01' };
        expect(isPauseExpired(s)).toBe(true);
        expect(pauseExpiredDays(s)).toBeGreaterThanOrEqual(1);
    });
    test('휴원 + 만료일 미래 → false / 0', () => {
        const s = { status: '가휴원', pause_end_date: '2099-01-01' };
        expect(isPauseExpired(s)).toBe(false);
        expect(pauseExpiredDays(s)).toBe(0);
    });
    test('pauseExpiredDays: 경과일 정확 계산 (오늘 고정)', () => {
        // 2026-06-28T05:00Z = KST 14:00 2026-06-28 → todayStr '2026-06-28'
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-06-28T05:00:00Z'));
        expect(pauseExpiredDays({ status: '실휴원', pause_end_date: '2026-06-20' })).toBe(8);
        vi.useRealTimers();
    });
});

// ─── activeClassCodes: 중복 제거 ────────────────────────────────────────────
describe('activeClassCodes', () => {
    test('활성 enrollment의 반코드를 중복 없이 반환', () => {
        const s = { enrollments: [
            { class_type: '정규', level_symbol: 'A', class_number: '101', day: ['월'] },
            { class_type: '특강', level_symbol: 'A', class_number: '101' }, // 동일 코드 중복
            { class_type: '특강', level_symbol: 'T', class_number: '9' },
        ]};
        expect(activeClassCodes(s, TODAY)).toEqual(['A101', 'T9']);
    });
});
