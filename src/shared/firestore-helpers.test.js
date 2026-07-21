import { beforeEach, describe, expect, it, vi } from 'vitest';

const { where, getDocs, getDocsFromCache } = vi.hoisted(() => ({
  where: vi.fn((field, op, value) => ({ field, op, value })),
  getDocs: vi.fn(async () => ({ size: 0, forEach() {} })),
  getDocsFromCache: vi.fn(),
}));

vi.mock('firebase/firestore', () => ({
  collection: vi.fn((db, name) => ({ db, name })),
  getDocs,
  getDocsFromCache,
  query: vi.fn((...parts) => parts),
  where,
  orderBy: vi.fn(),
  Timestamp: { fromDate: vi.fn(date => date) },
}));
vi.mock('../../firebase-config.js', () => ({ db: {} }));
vi.mock('../../student-core.js', () => ({
  enrollmentCode: vi.fn(),
  branchFromStudent: vi.fn(),
  allClassCodes: vi.fn(),
  normalizeDays: vi.fn(),
}));

import { fetchAiStatusDataFromCache, fetchDashboardDailyLogDataFromCache, fetchStudents } from './firestore-helpers.js';

const snapshot = (docs) => ({
  forEach(callback) {
    Object.entries(docs).forEach(([id, data]) => callback({ id, data: () => data }));
  },
});

describe('fetchStudents', () => {
  beforeEach(() => vi.clearAllMocks());

  it('기본 조회는 퇴원·종강을 제외한다', async () => {
    await fetchStudents();

    const statusWhere = where.mock.calls.find(([field]) => field === 'status');
    expect(statusWhere?.[2]).toEqual(['재원', '등원예정', '실휴원', '가휴원', '상담']);
  });

  it('종료 학생 포함 요청은 퇴원·종강까지 조회한다', async () => {
    await fetchStudents(true);

    const statusWhere = where.mock.calls.find(([field]) => field === 'status');
    expect(statusWhere?.[2]).toEqual([
      '재원', '등원예정', '실휴원', '가휴원', '상담', '퇴원', '종강',
    ]);
    expect(getDocs).toHaveBeenCalledTimes(2);
  });
});

describe('fetchAiStatusDataFromCache', () => {
  beforeEach(() => vi.clearAllMocks());

  it('AI 뷰의 세 컬렉션을 디스크 캐시에서 병렬 선조회한다', async () => {
    const rows = {
      student_status_summaries: { status: 'good' },
      class_settings: { teacher: 'aaron@impact7.kr' },
      staff_directory: { english_name: 'Aaron' },
    };
    getDocsFromCache.mockImplementation(async ({ name }) => snapshot(rows[name] ? { row: rows[name] } : {}));

    const result = await fetchAiStatusDataFromCache();

    expect(getDocsFromCache).toHaveBeenCalledTimes(3);
    expect(result.summaries.row.status).toBe('good');
    expect(result.classSettings.row.teacher).toBe('aaron@impact7.kr');
    expect(result.staffByLocal.get('aaron')).toBe('Aaron');
  });
});

describe('fetchDashboardDailyLogDataFromCache', () => {
  beforeEach(() => vi.clearAllMocks());

  it('로그북 쿼리를 캐시에서 읽어 서버 응답과 같은 형태로 반환한다', async () => {
    getDocsFromCache.mockImplementation(async request => {
      const collectionName = Array.isArray(request) ? request[0].name : request.name;
      if (collectionName === 'class_settings') {
        return { size: 1, docs: [], ...snapshot({ A101: { teacher: 'aaron@impact7.kr' } }) };
      }
      if (collectionName === 'daily_records') {
        return { size: 1, docs: [{ id: 'r1', data: () => ({ student_id: 's1', date: '2026-07-21' }) }], forEach() {} };
      }
      if (collectionName === 'student_records') {
        return { size: 1, docs: [{ id: 'm1', data: () => ({ student_id: 's1', important: true, content: '확인 필요' }) }], forEach() {} };
      }
      return { size: 0, docs: [], forEach() {} };
    });

    const result = await fetchDashboardDailyLogDataFromCache('2026-07-21');

    expect(getDocsFromCache).toHaveBeenCalledTimes(14);
    expect(result).toEqual({
      dailyRecords: [{ id: 'r1', student_id: 's1', date: '2026-07-21' }],
      tempAttendances: [], hwFailTasks: [], testFailTasks: [],
      absenceRecords: [], leaveRequests: [], classSettings: { A101: { teacher: 'aaron@impact7.kr' } }, attendanceEvents: [],
      absenceNoticeStatus: {},
      importantRecords: [{ id: 'm1', student_id: 's1', important: true, content: '확인 필요' }],
    });
  });

  it('오늘 daily_records가 캐시에 없으면(콜드 캐시) null — 결석 0 오탐 선표시 방지', async () => {
    getDocsFromCache.mockImplementation(async request => {
      const collectionName = Array.isArray(request) ? request[0].name : request.name;
      if (collectionName === 'class_settings') {
        return { size: 1, docs: [], ...snapshot({ A101: { teacher: 'aaron@impact7.kr' } }) };
      }
      return { size: 0, docs: [], forEach() {} };
    });

    await expect(fetchDashboardDailyLogDataFromCache('2026-07-21')).resolves.toBeNull();
  });

  it('캐시 미스나 오류는 null로 폴백한다', async () => {
    getDocsFromCache.mockRejectedValue(new Error('cache miss'));

    await expect(fetchDashboardDailyLogDataFromCache('2026-07-21')).resolves.toBeNull();
  });
});
