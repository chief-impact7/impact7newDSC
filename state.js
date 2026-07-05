// ─── State ──────────────────────────────────────────────────────────────────
// daily-ops.js에서 추출한 전역 상태 + 상수
// ES Module에서 let 변수의 외부 재할당이 불가하므로 state 객체로 감싸서 export

import { todayStr } from './src/shared/firestore-helpers.js';
export { LEVEL_SHORT } from '@impact7/shared/student-label';

// ─── 상수 (Constants) ───────────────────────────────────────────────────────
export const OX_CYCLE = ['O', '△', 'X', ''];
export const VISIT_STATUS_CYCLE = ['pending', '완료', '기타'];
export const DEFAULT_DOMAINS = ['Gr', 'A/G', 'R/C'];
// \uD14C\uC2A4\uD2B8 \uC139\uC158 \uAE30\uBCF8\uAC12 SSoT \u2014 data-layer.js\u00B7test-management.js\uC758 \uB85C\uCEEC \uC911\uBCF5 \uC815\uC758\uC640 \uB3D9\uC77C \uAC12(\uC815\uBCF8).
export const DEFAULT_TEST_SECTIONS = {
    '\uAE30\uBC18\uD559\uC2B5\uD14C\uC2A4\uD2B8': ['Vo', 'Id', 'ISC'],
    '\uB9AC\uBDF0\uD14C\uC2A4\uD2B8': []
};
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
export const DAY_ORDER = ['월', '화', '수', '목', '금', '토', '일'];
export const NEW_STUDENT_DAYS = 14;
export const TEMP_FIELD_LABELS = {
    name: '이름', branch: '소속', school: '학교', level: '학부', grade: '학년',
    student_phone: '학생연락처', parent_phone_1: '학부모연락처', memo: '메모',
    temp_date: '예정날짜', temp_time: '예정시간'
};
export const REGULAR_CLASS_TYPES = ['정규', '내신', '자유학기'];
// 출결 토글 첫 버튼의 CSS 톤 매핑. key는 표시 라벨(예: '자유'), class_type 데이터 값('자유학기')과는 의도적으로 다름.
export const DEFAULT_TONE = { '정규':'normal', '특강':'teukang', '내신':'naesin', '자유':'jayu', '비정규':'bijeong' };

// ─── 가변 상태 (Mutable State) ──────────────────────────────────────────────
export const state = {
    currentUser: null,
    allStudents: [],
    dailyRecords: {},
    dailyRecordsDate: '',
    retakeSchedules: [],
    hwFailTasks: [],
    testFailTasks: [],
    tempAttendances: [],
    absenceRecords: [],
    tempClassOverrides: [],
    leaveRequests: [],
    withdrawnStudents: [],
    // 퇴원생 전체 로드 완료 여부 — 부팅 시 미로드(1.5만+건), 퇴원 관련 화면이 lazy-load.
    // 검색(past-search)의 부분 push와 구분하는 기준.
    _withdrawnFullyLoaded: false,
    selectedDate: todayStr(),
    selectedStudentId: null,
    currentCategory: 'attendance',
    currentSubFilter: new Set(),
    l2Expanded: false,
    searchQuery: '',
    currentRole: null,
    canRunAiBatch: false,
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
    selectedNextHwClass: null,
    nextHwModalTarget: { classCode: null, domain: null },
    detailTab: 'daily',
    _editingTempDocId: null,
    _visitStatusPending: {},
    _scheduledVisitsCache: null,
    _classMgmtMode: null,
    _classDeleteMode: false,
    _classDeleteSelected: new Set(),
    saveIndicatorTimer: null,
    _classSettingsLoaded: false,
    _pendingClinicStudentId: null,
    _subFilterBase: null,
};

// 서브필터 캐시 무효화 ref. 여러 모듈(scheduled-visits, reschedule-modal 등)에 주입되어
// _subFilterBase 캐시를 일관되게 초기화한다. (클러스터 1·3 순환 해소를 위해 state로 승격)
export const _subFilterBaseRef = { clear() { state._subFilterBase = null; } };
