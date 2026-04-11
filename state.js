// ─── State ──────────────────────────────────────────────────────────────────
// daily-ops.js에서 추출한 전역 상태 + 상수
// ES Module에서 let 변수의 외부 재할당이 불가하므로 state 객체로 감싸서 export

import { todayStr } from './src/shared/firestore-helpers.js';

// ─── 상수 (Constants) ───────────────────────────────────────────────────────
export const OX_CYCLE = ['O', '△', 'X', ''];
export const VISIT_STATUS_CYCLE = ['pending', '완료', '기타'];
export const DEFAULT_DOMAINS = ['Gr', 'A/G', 'R/C'];
export const KOREAN_CHAR_RE = /^[\uAC00-\uD7AF]/;
export const SV_SOURCE_MAP = {
    sv_absence_makeup: ['absence_makeup'],
    sv_clinic: ['extra'],
    sv_diagnostic: ['temp'],
    sv_fail: ['hw_fail', 'test_fail']
};
export const SV_L3_KEYS = Object.keys(SV_SOURCE_MAP);
export const SOURCE_PRIORITY = { extra: 0, temp: 1, hw_fail: 2, test_fail: 3, absence_makeup: 4 };
export const SOURCE_SHORT = { extra: '클리닉', temp: '진단', hw_fail: '숙제', test_fail: '테스트', absence_makeup: '보충' };
export const LEAVE_STATUSES = ['가휴원', '실휴원'];
export const NEW_STUDENT_DAYS = 14;
export const TEMP_FIELD_LABELS = {
    name: '이름', branch: '소속', school: '학교', level: '학부', grade: '학년',
    student_phone: '학생연락처', parent_phone_1: '학부모연락처', memo: '메모',
    temp_date: '예정날짜', temp_time: '예정시간'
};
export const LEVEL_SHORT = { '초등': '초', '중등': '중', '고등': '고' };

// ─── 가변 상태 (Mutable State) ──────────────────────────────────────────────
export const state = {
    currentUser: null,
    allStudents: [],
    dailyRecords: {},
    retakeSchedules: [],
    hwFailTasks: [],
    testFailTasks: [],
    tempAttendances: [],
    absenceRecords: [],
    tempClassOverrides: [],
    leaveRequests: [],
    withdrawnStudents: [],
    selectedDate: todayStr(),
    selectedStudentId: null,
    currentCategory: 'attendance',
    currentSubFilter: new Set(),
    l2Expanded: false,
    saveTimers: {},
    searchQuery: '',
    currentRole: null,
    roleMemos: [],
    memoTab: 'inbox',
    classSettings: {},
    teachersList: [],
    selectedBranch: null,
    selectedBranchLevel: null,
    selectedClassCode: null,
    siblingMap: {},
    _contactSearchId: 0,
    bulkMode: false,
    selectedStudentIds: new Set(),
    groupViewMode: localStorage.getItem('dsc_groupViewMode') || 'none',
    savedSubFilters: {},
    savedL2Expanded: {},
    classNextHw: {},
    nextHwSaveTimers: {},
    selectedNextHwClass: null,
    nextHwModalTarget: { classCode: null, domain: null },
    detailTab: 'daily',
    _editingTempDocId: null,
    _visitStatusPending: {},
    _scheduledVisitsCache: null,
    _classMgmtMode: null,
    saveIndicatorTimer: null,
    _classSettingsLoaded: false,
};
