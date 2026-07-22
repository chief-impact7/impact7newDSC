import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDocs: vi.fn(),
  getDocsFromCache: vi.fn(),
  onSnapshot: vi.fn(),
  where: vi.fn((field, op, value) => ({ field, op, value })),
  state: {
    allStudents: [], selectedDate: '2026-07-23', hwFailTasks: [], testFailTasks: [],
  },
}));

vi.mock('firebase/firestore', () => ({
  collection: vi.fn((db, name) => ({ db, name })),
  getDocs: mocks.getDocs,
  getDocsFromCache: mocks.getDocsFromCache,
  getDoc: vi.fn(),
  doc: vi.fn(),
  query: vi.fn((...parts) => parts),
  where: mocks.where,
  orderBy: vi.fn(),
  limit: vi.fn(),
  startAfter: vi.fn(),
  documentId: vi.fn(),
  serverTimestamp: vi.fn(),
  writeBatch: vi.fn(() => ({ set: vi.fn(), update: vi.fn(), commit: vi.fn() })),
  Timestamp: { fromDate: vi.fn(date => date) },
  onSnapshot: mocks.onSnapshot,
  deleteField: vi.fn(),
}));
vi.mock('firebase/functions', () => ({ httpsCallable: vi.fn(() => vi.fn()) }));
vi.mock('../firebase-config.js', () => ({ db: {}, functions: {} }));
vi.mock('../audit.js', () => ({
  auditUpdate: vi.fn(), auditSet: vi.fn(), auditAdd: vi.fn(), auditDelete: vi.fn(),
  batchUpdate: vi.fn(), batchSet: vi.fn(), READ_ONLY: false,
}));
vi.mock('../state.js', () => ({
  state: mocks.state, DEFAULT_DOMAINS: [], LEAVE_STATUSES: [], DEFAULT_TEST_SECTIONS: {},
}));
vi.mock('../ui-utils.js', () => ({ showSaveIndicator: vi.fn(), showToast: vi.fn() }));
vi.mock('../date-picker.js', () => ({ openKoreanDatePicker: vi.fn() }));
vi.mock('../student-helpers.js', () => ({
  normalizeDays: vi.fn(days => days || []), enrollmentCode: vi.fn(() => ''),
  branchFromStudent: vi.fn(), makeDailyRecordId: vi.fn(), getActiveEnrollments: vi.fn(),
  deriveClassLabelAt: vi.fn(), getSeparateTeukangVisit: vi.fn(),
}));
vi.mock('../consultation-filter.js', () => ({ DEFAULT_HISTORY_LIMIT: 50 }));
vi.mock('../save-scheduler.js', () => ({ createDebouncedWriter: vi.fn(() => vi.fn()) }));
vi.mock('@impact7/shared/promote-enroll', () => ({ createPromoteEnrollPending: vi.fn(() => vi.fn()) }));
vi.mock('../src/messages/recipient-settings.js', () => ({ MESSAGE_RECIPIENT_SETTINGS_FIELD: 'x' }));
vi.mock('../student-core.js', () => ({ isScheduledWithdrawalDue: vi.fn() }));
vi.mock('../docu-records.js', () => ({ importantRecordsByStudent: vi.fn() }));

import viteConfig from '../vite.config.js';
import { loadAbsenceRecords, loadHwFailTasks, loadStudents, unsubscribeAll } from '../data-layer.js';

const snapshot = (rows, fromCache = false) => ({
  size: rows.length,
  metadata: { fromCache },
  docs: rows.map(({ id, ...data }) => ({ id, data: () => data })),
  forEach(callback) {
    rows.forEach(({ id, ...data }) => callback({ id, data: () => data }));
  },
});

describe('초기 데이터 로드', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.allStudents = [];
    mocks.state.hwFailTasks = [];
  });

  it('warm cache 학생을 서버 응답 전에 렌더 콜백에 전달하고 서버 결과로 갱신한다', async () => {
    mocks.getDocsFromCache
      .mockResolvedValueOnce(snapshot([{ id: 'cached', name: '캐시' }]))
      .mockResolvedValueOnce(snapshot([]));
    let resolveServer;
    mocks.getDocs.mockReturnValue(new Promise(resolve => { resolveServer = resolve; }));
    const onCache = vi.fn();

    const loading = loadStudents({ onCache });
    await vi.waitFor(() => expect(onCache).toHaveBeenCalledOnce());
    expect(mocks.state.allStudents[0].docId).toBe('cached');

    resolveServer(snapshot([{ id: 'server', name: '서버' }]));
    await expect(loading).resolves.toEqual({ source: 'server', stale: false, error: null });
    expect(mocks.state.allStudents[0].docId).toBe('server');
  });

  it('서버 실패 시 캐시 유무를 stale과 오류 상태로 구분한다', async () => {
    const error = new Error('offline');
    mocks.getDocsFromCache
      .mockResolvedValueOnce(snapshot([{ id: 'cached', name: '캐시' }]))
      .mockResolvedValueOnce(snapshot([]));
    mocks.getDocs.mockRejectedValue(error);
    await expect(loadStudents()).resolves.toEqual({ source: 'cache', stale: true, error });

    mocks.state.allStudents = [];
    mocks.getDocsFromCache.mockResolvedValue(snapshot([]));
    await expect(loadStudents()).resolves.toEqual({ source: 'none', stale: false, error });
  });

  it('getDocs의 오프라인 캐시 fallback을 server 성공으로 분류하지 않는다', async () => {
    mocks.getDocsFromCache.mockResolvedValue(snapshot([]));
    mocks.getDocs
      .mockResolvedValueOnce(snapshot([{ id: 'offline', name: '오프라인' }], true))
      .mockResolvedValueOnce(snapshot([], true));

    await expect(loadStudents()).resolves.toEqual({ source: 'cache', stale: true, error: null });
    expect(mocks.state.allStudents[0].docId).toBe('offline');
  });

  it('명시적 캐시가 비고 서버가 실패하면 기존 메모리 목록을 stale로 보존한다', async () => {
    const error = new Error('offline');
    mocks.state.allStudents = [{ docId: 'memory', name: '메모리' }];
    mocks.getDocsFromCache.mockResolvedValue(snapshot([]));
    mocks.getDocs.mockRejectedValue(error);

    await expect(loadStudents()).resolves.toEqual({ source: 'cache', stale: true, error });
    expect(mocks.state.allStudents).toEqual([{ docId: 'memory', name: '메모리' }]);
  });

  it('미통과 task는 pending·원본일·예정일을 구독하고 docId 중복을 합친다', async () => {
    const unsubs = [vi.fn(), vi.fn(), vi.fn()];
    mocks.onSnapshot.mockImplementation((request, next) => {
      const condition = request.find(part => part?.field);
      const rowsByField = {
        status: [{ id: 'pending', status: 'pending' }, { id: 'same', status: 'pending' }],
        source_date: [{ id: 'same', status: '완료' }, { id: 'source-closed', status: '취소' }],
        scheduled_date: [{ id: 'scheduled-closed', status: '완료', source_date: '2026-07-20' }],
      };
      next(snapshot(rowsByField[condition.field]));
      return unsubs[mocks.onSnapshot.mock.calls.length - 1];
    });

    await loadHwFailTasks('2026-07-23');

    expect(mocks.where).toHaveBeenCalledWith('status', '==', 'pending');
    expect(mocks.where).toHaveBeenCalledWith('source_date', '==', '2026-07-23');
    expect(mocks.where).toHaveBeenCalledWith('scheduled_date', '==', '2026-07-23');
    expect(mocks.state.hwFailTasks).toEqual([
      { docId: 'pending', status: 'pending' },
      { docId: 'same', status: '완료' },
      { docId: 'source-closed', status: '취소' },
      { docId: 'scheduled-closed', status: '완료', source_date: '2026-07-20' },
    ]);
    unsubscribeAll();
    unsubs.forEach(unsub => expect(unsub).toHaveBeenCalledOnce());
  });

  it('absence 초기 listener 오류는 성공 준비 상태로 처리하지 않는다', async () => {
    const error = new Error('permission-denied');
    mocks.onSnapshot.mockImplementation((request, next, onError) => {
      onError(error);
      return vi.fn();
    });

    await expect(loadAbsenceRecords()).rejects.toBe(error);
    unsubscribeAll();
  });
});

it('index용 named icon과 React/full icon map의 manual chunk 경계를 분리한다', () => {
  const chunk = viteConfig.build.rollupOptions.output.manualChunks;
  expect(chunk('/node_modules/@impact7/ui/dist/icons-named.js')).toBe('impact7-ui-icons-named');
  expect(chunk('/node_modules/@impact7/ui/dist/impact7-ui.js')).toBeUndefined();
  expect(chunk('/node_modules/@impact7/ui/dist/phosphor-icons-abc.js')).toBe('impact7-ui-icons-full');
});
