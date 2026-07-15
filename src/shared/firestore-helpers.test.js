import { beforeEach, describe, expect, it, vi } from 'vitest';

const { where, getDocs } = vi.hoisted(() => ({
  where: vi.fn((field, op, value) => ({ field, op, value })),
  getDocs: vi.fn(async () => ({ size: 0, forEach() {} })),
}));

vi.mock('firebase/firestore', () => ({
  collection: vi.fn((db, name) => ({ db, name })),
  getDocs,
  getDocsFromCache: vi.fn(),
  query: vi.fn((...parts) => parts),
  where,
  orderBy: vi.fn(),
  Timestamp: {},
}));
vi.mock('../../firebase-config.js', () => ({ db: {} }));
vi.mock('../../student-core.js', () => ({
  enrollmentCode: vi.fn(),
  branchFromStudent: vi.fn(),
  allClassCodes: vi.fn(),
  normalizeDays: vi.fn(),
}));

import { fetchStudents } from './firestore-helpers.js';

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
