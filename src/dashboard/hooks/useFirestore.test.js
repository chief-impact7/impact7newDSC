import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    stateSetters: [],
    fetchStudents: vi.fn(),
    fetchStudentsFromCache: vi.fn(),
    fetchDashboardDailyLogData: vi.fn(),
    fetchDashboardDailyLogDataFromCache: vi.fn(),
    fetchConsultationsForRange: vi.fn(),
}));

vi.mock('react', () => ({
    useState: vi.fn(initial => {
        const setter = vi.fn();
        mocks.stateSetters.push(setter);
        return [typeof initial === 'function' ? initial() : initial, setter];
    }),
    useEffect: vi.fn(effect => effect()),
    useCallback: vi.fn(callback => callback),
    useRef: vi.fn(initial => ({ current: initial })),
}));
vi.mock('firebase/functions', () => ({ httpsCallable: vi.fn(() => vi.fn()) }));
vi.mock('../../../firebase-config.js', () => ({ functions: {} }));
vi.mock('../../shared/firestore-helpers.js', () => ({
    fetchStudents: mocks.fetchStudents,
    fetchStudentsFromCache: mocks.fetchStudentsFromCache,
    fetchDashboardDailyLogData: mocks.fetchDashboardDailyLogData,
    fetchDashboardDailyLogDataFromCache: mocks.fetchDashboardDailyLogDataFromCache,
    fetchDailyChecksRange: vi.fn(),
    fetchDailyRecordsRange: vi.fn(),
    fetchPostponedTasksRange: vi.fn(),
    fetchConsultationsForRange: mocks.fetchConsultationsForRange,
    fetchStudentStatusSummaries: vi.fn(),
    fetchClassSettingsMap: vi.fn(),
    fetchStaffNameMap: vi.fn(),
    fetchAiStatusDataFromCache: vi.fn(),
}));
vi.mock('../message-period.js', () => ({ kstDayRangeParams: vi.fn() }));

import { useConsultations, useDashboardData, useStudents } from './useFirestore.js';

const flushPromises = () => new Promise(resolve => setImmediate(resolve));

describe('cache-first 서버 오류 처리', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.stateSetters.length = 0;
    });

    it('학생 캐시가 있으면 서버 갱신 실패를 전체 오류로 바꾸지 않는다', async () => {
        const cached = [{ id: 'student-1' }];
        const serverError = new Error('server unavailable');
        mocks.fetchStudentsFromCache.mockResolvedValue(cached);
        mocks.fetchStudents.mockRejectedValue(serverError);

        useStudents({ uid: 'user-1' });
        await flushPromises();

        expect(mocks.stateSetters[0]).toHaveBeenCalledWith(cached);
        expect(mocks.stateSetters[2]).not.toHaveBeenCalledWith(serverError);
    });

    it('학생 캐시도 없으면 서버 실패를 오류로 표시한다', async () => {
        const serverError = new Error('server unavailable');
        mocks.fetchStudentsFromCache.mockResolvedValue(null);
        mocks.fetchStudents.mockRejectedValue(serverError);

        useStudents({ uid: 'user-1' });
        await flushPromises();

        expect(mocks.stateSetters[2]).toHaveBeenCalledWith(serverError);
    });

    it('로그북 캐시가 있으면 서버 갱신 실패를 전체 오류로 바꾸지 않는다', async () => {
        const cached = { dailyRecords: [{ id: 'record-1' }] };
        const serverError = new Error('server unavailable');
        mocks.fetchDashboardDailyLogDataFromCache.mockResolvedValue(cached);
        mocks.fetchDashboardDailyLogData.mockRejectedValue(serverError);

        useDashboardData({ uid: 'user-1' }, '2026-07-22', '2026-07-22', true, true);
        await flushPromises();

        expect(mocks.stateSetters[3]).toHaveBeenCalledWith(cached);
        expect(mocks.stateSetters[5]).not.toHaveBeenCalledWith(serverError);
    });

    it('로그북 캐시도 없으면 서버 실패를 오류로 표시한다', async () => {
        const serverError = new Error('server unavailable');
        mocks.fetchDashboardDailyLogDataFromCache.mockResolvedValue(null);
        mocks.fetchDashboardDailyLogData.mockRejectedValue(serverError);

        useDashboardData({ uid: 'user-1' }, '2026-07-22', '2026-07-22', true, true);
        await flushPromises();

        expect(mocks.stateSetters[5]).toHaveBeenCalledWith(serverError);
    });
});

describe('상담현황 로딩 상태', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.stateSetters.length = 0;
    });

    it('비활성화하면 진행 중 로딩과 오류를 함께 초기화한다', () => {
        const result = useConsultations({ uid: 'user-1' }, '2026-07-22', '2026-07-22', false);

        expect(mocks.stateSetters[0]).toHaveBeenCalledWith([]);
        expect(mocks.stateSetters[1]).toHaveBeenCalledWith(false);
        expect(mocks.stateSetters[2]).toHaveBeenCalledWith(null);
        expect(mocks.fetchConsultationsForRange).not.toHaveBeenCalled();
        expect(result.reload).toEqual(expect.any(Function));
    });

    it('조회 실패 후 로딩을 종료하고 오류를 노출한다', async () => {
        const error = new Error('consultation unavailable');
        mocks.fetchConsultationsForRange.mockRejectedValue(error);

        useConsultations({ uid: 'user-1' }, '2026-07-22', '2026-07-22', true);
        await flushPromises();

        expect(mocks.stateSetters[1]).toHaveBeenCalledWith(true);
        expect(mocks.stateSetters[1]).toHaveBeenLastCalledWith(false);
        expect(mocks.stateSetters[2]).toHaveBeenCalledWith(error);
    });
});
