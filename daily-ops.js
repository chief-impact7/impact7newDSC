import { onAuthStateChanged } from 'firebase/auth';
import {
    collection, getDocs, doc,
    query, where, arrayUnion, deleteField
} from 'firebase/firestore';
import { auth, db, geminiModel } from './firebase-config.js';
import { signInWithGoogle, logout, getGoogleAccessToken } from './auth.js';
import { initHelpGuide } from './help-guide.js';
import { toDateStrKST, parseDateKST, todayStr, getDayName, studentShortLabel, ACTIVE_STUDENT_STATUSES, PAST_STUDENT_STATUSES } from './src/shared/firestore-helpers.js';
import { auditUpdate, auditSet } from './audit.js';
import {
    state,
    OX_CYCLE, VISIT_STATUS_CYCLE, DEFAULT_DOMAINS, KOREAN_CHAR_RE,
    SV_SOURCE_MAP, SV_L3_KEYS, SOURCE_PRIORITY, SOURCE_SHORT,
    LEAVE_STATUSES, NEW_STUDENT_DAYS, TEMP_FIELD_LABELS, LEVEL_SHORT,
    DAY_ORDER
} from './state.js';
import {
    esc, escAttr, decodeHtmlEntities, formatTime12h, nowTimeStr,
    showSaveIndicator, showToast, nextOXValue, oxDisplayClass,
    _attToggleClass, _toVisitStatus, _visitBtnStyles, _visitLabel,
    _stripYear, _fmtTs, _isNoShow, _renderRescheduleHistory
} from './ui-utils.js';
import {
    normalizeDays, branchFromStudent, matchesBranchFilter,
    enrollmentCode, allClassCodes, activeClassCodes, _enrollCodeList,
    deriveNaesinCode, getActiveEnrollments, getStudentStartTime,
    isNaesinActiveToday, isFreeSemesterActiveToday,
    makeDailyRecordId, findStudent, buildSiblingMap
} from './student-helpers.js';
import {
    initParentMessageDeps,
    openParentMessageModal, regenerateParentMessage, copyParentMessage,
    switchParentMsgTab, togglePromptEditor, saveCustomPrompt, resetPromptToDefault
} from './parent-message.js';
import { initExportReportDeps, exportDailyReport } from './export-report.js';
import {
    initDiagnosticDeps, setupTempAutofillListeners,
    renderTempAttendanceDetail, deleteTempAttendance,
    openTempAttendanceModal, openTempAttendanceForEdit, saveTempAttendance,
    openContactAsTemp
} from './diagnostic.js';
import { _searchContactsDSC, _renderPastContacts } from './past-search.js';
import {
    initLeaveRequestDeps,
    renderLeaveRequestList, selectLeaveRequest,
    renderReturnUpcomingList, selectReturnUpcomingStudent, resetReturnUpcomingCache,
    _getReturnUpcomingStudents, _finalizeLeaveDSC,
    renderReturnConsultCard, renderLeaveRequestCard,
    toggleReturnConsult, updateReturnConsultNote,
    openLeaveRequestModal, onLeaveRequestTypeChange, searchLeaveRequestStudent, selectLeaveRequestStudentById,
    submitLeaveRequest, toggleCancelLeaveRequest, teacherApproveLeaveRequest,
    approveLeaveRequest, cancelLeaveRequest,
    openReEnrollModal, openReturnFromLeaveModal, submitReturnFromLeave
} from './leave-request.js';
import {
    initAbsenceRecordsDeps,
    renderAbsenceLedgerList, renderAbsenceRecordCard,
    _getExpandedAbsenceIndices, _restoreExpandedAbsenceIndices,
    updateAbsenceField, toggleConsultation, validateAndSetReasonValid,
    validateAndSetResolution, setAbsenceResolution,
    completeAbsenceMakeup, markAbsenceNoShow, switchToSettlement,
    closeAbsenceRecord, openAbsenceRescheduleModal, reopenAbsenceMakeup
} from './absence-records.js';
import {
    initClassDetailDeps,
    renderClassDetail, renderClassTempOverrideSection,
    openClassTempOverrideModal, filterClassOverrideStudents, selectClassOverrideStudent, submitClassTempOverrideFromModal,
    saveTeacherAssign, addClassDomain, removeClassDomain, resetClassDomains,
    addTestToSection, removeTestFromSection, addTestSection, removeTestSection, resetTestSections, resetTestSection,
    saveClassDefaultTime, toggleRegularClassDay, toggleClassDay, saveClassDayTime,
    saveTeukangPeriod, searchTeukangAddStudent, addStudentToTeukang
} from './class-detail.js';
import {
    initHwManagementDeps,
    renderHwFailActionCard, saveHwFailAction, selectHwFailType, clearHwFailType, saveHwFailFields,
    renderPendingTasksCard, completeHwFailTask, cancelHwFailTask,
    renderNextHwClassList, selectNextHwClass, openNextHwModal, saveNextHwFromModal, saveNextHwNone,
    openPersonalNextHwModal, savePersonalNextHwFromModal, savePersonalNextHwNone,
    restoreModalHandlers, refreshNextHwViews, renderNextHwClassDetail,
    toggleHomework, oxFieldLabel, toggleHwDomainOX, applyHwDomainOX, handleHomeworkStatusChange
} from './hw-management.js';
import {
    initTestManagementDeps,
    getClassTestSections, renderTestFailActionCard,
    selectTestFailType, clearTestFailType, saveTestFailFields,
    saveTestFailAction, completeTestFailTask, cancelTestFailTask
} from './test-management.js';
import {
    initAttendanceDeps,
    cycleTempArrival, cycleVisitAttendance, toggleAttendance,
    autoCreateAbsenceRecord, autoRemoveAbsenceRecord, syncAbsenceRecords,
    applyAttendance, doesStatusMatchFilter, isNewStudent, isAttendedStatus,
    checkCanEditGrading, _isVisitAttended, handleAttendanceChange,
    DEFAULT_ATTENDANCE_LABELS
} from './attendance.js';
import {
    initScheduledVisitsDeps,
    completeScheduledVisit, resetScheduledVisit, cycleVisitStatus, confirmVisitStatus,
    rescheduleVisit, _showDiagnosticActionModal,
    toggleDiagnosticReschedule, saveDiagnosticReschedule, confirmDiagnosticCancel
} from './scheduled-visits.js';
import {
    initBulkModeDeps,
    enterBulkMode, exitBulkMode, updateBulkBar, renderBulkSummary,
    openBulkAttendanceFromSummary, openBulkOXFromSummary,
    toggleSelectAll, toggleStudentCheckbox,
    openBulkModal, selectBulkValue, confirmBulkAction, resetBulkModal, cancelBulkAction,
    handleListItemClick, toggleGroupView, openBulkDomainPicker, pickBulkDomain,
    openBulkMemo, saveBulkMemo, openBulkNotify, saveBulkNotify
} from './bulk-mode.js';
import {
    initDataLayerDeps, initDataLayerDeps2,
    loadClassSettings, getClassDomains, loadTeachers, trackTeacherLogin, getTeacherName,
    loadClassNextHw, saveClassNextHw, getNextHwStatus, getStudentDomains, getStudentTestItems,
    saveClassSettings, loadStudents, promoteEnrollPending,
    loadDailyRecords, loadRetakeSchedules, loadHwFailTasks, loadTestFailTasks,
    loadTempAttendances, loadTempClassOverrides,
    getStudentOverrides, getOverrideStudentsForClass, getOverridingOutFromClass, addOverrideInStudents,
    createTempClassOverride, cancelTempClassOverride,
    loadAbsenceRecords, loadLeaveRequests,
    _toDate, _isOlderThan, syncTaskStudentNames, autoCloseOldRecords,
    loadWithdrawnStudents, saveDailyRecord, saveRetakeSchedule, saveImmediately,
    updateDateDisplay, reloadForDate, changeDate, openDatePicker, goToday
} from './data-layer.js';
import {
    initRoleMemoDeps,
    loadUserRole, selectRole, renderRoleSelector, loadRoleMemos,
    toggleMemoSection, toggleMemoPanel, setMemoTab, renderMemoPanel,
    expandMemo, toggleMemoPin, markMemoRead,
    openMemoModal, toggleMemoStudentField, searchMemoStudent, selectMemoStudent, sendMemo,
    renderStudentRoleMemoCard, renderUnifiedMemoCard, normalizeStudentMemos,
    addStudentMemo, deleteStudentMemo, toggleStudentMemoPin
} from './role-memo.js';
import {
    initRescheduleModalDeps,
    openRescheduleModal, saveReschedule
} from './reschedule-modal.js';
import {
    initVisitRenderDeps,
    getScheduledVisits, getEnrollPendingVisits,
    renderScheduledVisitList, renderEnrollPendingOnly, renderEnrollPendingSection,
    renderDepartureCheckList, clearVisitCache
} from './visit-list-render.js';
import {
    initStudentDetailDeps,
    renderStudentDetail, renderClinicInputs, switchDetailTab, loadReportCard,
    confirmDeparture, saveExtraVisit, addExtraVisit, clearExtraVisit,
    getStudentChecklistStatus
} from './student-detail.js';

// 디버그용 전역 노출 (DEV 환경에서만)
if (import.meta.env?.DEV) {
    window._debug = { get allStudents() { return state.allStudents; }, get dailyRecords() { return state.dailyRecords; }, get hwFailTasks() { return state.hwFailTasks; }, get testFailTasks() { return state.testFailTasks; } };
}

window.state = state;

// _attToggleClass, _toVisitStatus, _visitBtnStyles, _visitLabel,
// nextOXValue, oxDisplayClass → imported from ui-utils.js


// buildSiblingMap, normalizeDays, branchFromStudent, matchesBranchFilter,
// enrollmentCode, allClassCodes, activeClassCodes, _enrollCodeList,
// getActiveEnrollments, getStudentStartTime, makeDailyRecordId → imported from student-helpers.js

// openParentMessageModal, regenerateParentMessage, copyParentMessage,
// switchParentMsgTab, togglePromptEditor, saveCustomPrompt, resetPromptToDefault
// → imported from parent-message.js

window.openParentMessageModal = openParentMessageModal;
window.regenerateParentMessage = regenerateParentMessage;
window.copyParentMessage = copyParentMessage;
window.switchParentMsgTab = switchParentMsgTab;
window.togglePromptEditor = togglePromptEditor;
window.saveCustomPrompt = saveCustomPrompt;
window.resetPromptToDefault = resetPromptToDefault;

// parent-message.js 의존성 주입 (getStudentDomains 등은 daily-ops에 남아있으므로)
initParentMessageDeps({ getStudentDomains, getStudentTestItems, getStudentChecklistStatus });

// export-report.js 의존성 주입
initExportReportDeps({ getStudentDomains, getStudentTestItems, getTeacherName });
window.exportDailyReport = exportDailyReport;

// diagnostic.js 의존성 주입 + window 노출
initDiagnosticDeps({ renderSubFilters, renderListPanel, loadTempAttendances });
setupTempAutofillListeners();
window.renderTempAttendanceDetail = renderTempAttendanceDetail;
window.deleteTempAttendance = deleteTempAttendance;
window.openTempAttendanceModal = openTempAttendanceModal;
window.openTempAttendanceForEdit = openTempAttendanceForEdit;
window.saveTempAttendance = saveTempAttendance;
window.openContactAsTemp = openContactAsTemp;

// leave-request.js 의존성 주입 + window 노출
initLeaveRequestDeps({ renderSubFilters, renderListPanel, renderStudentDetail, getTeacherName, _isOlderThan, loadWithdrawnStudents, renderFilterChips });
window.renderLeaveRequestList = renderLeaveRequestList;
window.selectLeaveRequest = selectLeaveRequest;
window.renderReturnUpcomingList = renderReturnUpcomingList;
window.selectReturnUpcomingStudent = selectReturnUpcomingStudent;
window.renderReturnConsultCard = renderReturnConsultCard;
window.renderLeaveRequestCard = renderLeaveRequestCard;
window.toggleReturnConsult = toggleReturnConsult;
window.updateReturnConsultNote = updateReturnConsultNote;
window.openLeaveRequestModal = openLeaveRequestModal;
window.onLeaveRequestTypeChange = onLeaveRequestTypeChange;
window.searchLeaveRequestStudent = searchLeaveRequestStudent;
window.selectLeaveRequestStudentById = selectLeaveRequestStudentById;
window.submitLeaveRequest = submitLeaveRequest;
window.toggleCancelLeaveRequest = toggleCancelLeaveRequest;
window.teacherApproveLeaveRequest = teacherApproveLeaveRequest;
window.approveLeaveRequest = approveLeaveRequest;
window.cancelLeaveRequest = cancelLeaveRequest;
window.openReEnrollModal = openReEnrollModal;
window.openReturnFromLeaveModal = openReturnFromLeaveModal;
window.submitReturnFromLeave = submitReturnFromLeave;

// absence-records.js 의존성 주입 + window 노출
initAbsenceRecordsDeps({ renderSubFilters, renderListPanel, renderStudentDetail, getTeacherName, renderFilterChips });
window.renderAbsenceLedgerList = renderAbsenceLedgerList;
window.renderAbsenceRecordCard = renderAbsenceRecordCard;
window.updateAbsenceField = updateAbsenceField;
window.toggleConsultation = toggleConsultation;
window.validateAndSetReasonValid = validateAndSetReasonValid;
window.validateAndSetResolution = validateAndSetResolution;
window.setAbsenceResolution = setAbsenceResolution;
window.completeAbsenceMakeup = completeAbsenceMakeup;
window.markAbsenceNoShow = markAbsenceNoShow;
window.switchToSettlement = switchToSettlement;
window.closeAbsenceRecord = closeAbsenceRecord;
window.openAbsenceRescheduleModal = openAbsenceRescheduleModal;
window.reopenAbsenceMakeup = reopenAbsenceMakeup;

// class-detail.js 의존성 주입 + window 노출
initClassDetailDeps({ getOverrideStudentsForClass, getOverridingOutFromClass, getClassDomains, getClassTestSections, getTeacherName, saveClassSettings, isInTeukangClass, getTeukangClassStudents, renderStudentDetail, renderListPanel, _isNaesinClassCode });
window.renderClassDetail = renderClassDetail;
window.openClassTempOverrideModal = openClassTempOverrideModal;
window.filterClassOverrideStudents = filterClassOverrideStudents;
window.selectClassOverrideStudent = selectClassOverrideStudent;
window.submitClassTempOverrideFromModal = submitClassTempOverrideFromModal;
window.saveTeacherAssign = saveTeacherAssign;
window.addClassDomain = addClassDomain;
window.removeClassDomain = removeClassDomain;
window.resetClassDomains = resetClassDomains;
window.addTestToSection = addTestToSection;
window.removeTestFromSection = removeTestFromSection;
window.addTestSection = addTestSection;
window.removeTestSection = removeTestSection;
window.resetTestSections = resetTestSections;
window.resetTestSection = resetTestSection;
window.saveClassDefaultTime = saveClassDefaultTime;
window.toggleRegularClassDay = toggleRegularClassDay;
window.toggleClassDay = toggleClassDay;
window.saveClassDayTime = saveClassDayTime;
window.saveTeukangPeriod = saveTeukangPeriod;
window.searchTeukangAddStudent = searchTeukangAddStudent;
window.addStudentToTeukang = addStudentToTeukang;

// hw-management.js 의존성 주입 + window 노출
initHwManagementDeps({ renderStudentDetail, renderSubFilters, renderListPanel, saveDailyRecord, getClassDomains, getNextHwStatus, saveClassNextHw, checkCanEditGrading, saveImmediately, getUniqueClassCodes, renderFilterChips, openBulkModal });
window.renderHwFailActionCard = renderHwFailActionCard;
window.saveHwFailAction = saveHwFailAction;
window.selectHwFailType = selectHwFailType;
window.clearHwFailType = clearHwFailType;
window.saveHwFailFields = saveHwFailFields;
window.renderPendingTasksCard = renderPendingTasksCard;
window.completeHwFailTask = completeHwFailTask;
window.cancelHwFailTask = cancelHwFailTask;
window.renderNextHwClassList = renderNextHwClassList;
window.selectNextHwClass = selectNextHwClass;
window.openNextHwModal = openNextHwModal;
window.saveNextHwFromModal = saveNextHwFromModal;
window.saveNextHwNone = saveNextHwNone;
window.openPersonalNextHwModal = openPersonalNextHwModal;
window.savePersonalNextHwFromModal = savePersonalNextHwFromModal;
window.savePersonalNextHwNone = savePersonalNextHwNone;
window.restoreModalHandlers = restoreModalHandlers;
window.refreshNextHwViews = refreshNextHwViews;
window.renderNextHwClassDetail = renderNextHwClassDetail;
window.toggleHomework = toggleHomework;
window.oxFieldLabel = oxFieldLabel;
window.toggleHwDomainOX = toggleHwDomainOX;
window.applyHwDomainOX = applyHwDomainOX;
window.handleHomeworkStatusChange = handleHomeworkStatusChange;

// test-management.js 의존성 주입 + window 노출
initTestManagementDeps({ renderStudentDetail, renderListPanel, checkCanEditGrading, getClassDomains });
window.selectTestFailType = selectTestFailType;
window.clearTestFailType = clearTestFailType;
window.saveTestFailFields = saveTestFailFields;
window.completeTestFailTask = completeTestFailTask;
window.cancelTestFailTask = cancelTestFailTask;

// attendance.js 의존성 주입
initAttendanceDeps({ renderSubFilters, renderListPanel, renderStudentDetail, openBulkModal });

// data-layer.js 의존성 주입
initDataLayerDeps({ renderSubFilters, renderListPanel, renderStudentDetail, renderClassDetail, getClassTestSections, _finalizeLeaveDSC });
initDataLayerDeps2({ loadRoleMemos, syncAbsenceRecords });

// bulk-mode.js 의존성 주입
function selectStudent(id) {
    state.selectedStudentId = id;
    renderListPanel();
    renderStudentDetail(id);
}
initBulkModeDeps({ renderSubFilters, renderListPanel, renderStudentDetail, applyAttendance, applyHwDomainOX, isAttendedStatus, oxFieldLabel, selectStudent });

// scheduled-visits.js 의존성 주입
const _subFilterBaseRef = { clear() { _subFilterBase = null; } };
initScheduledVisitsDeps({ renderSubFilters, renderListPanel, renderStudentDetail, _isVisitAttended, getScheduledVisits, openRescheduleModal: (...args) => window.openRescheduleModal(...args), _subFilterBaseRef });

// reschedule-modal.js 의존성 주입 + window 노출
initRescheduleModalDeps({ renderSubFilters, renderListPanel, renderStudentDetail, _subFilterBaseRef });
window.openRescheduleModal = openRescheduleModal;
window.saveReschedule = saveReschedule;

// student-detail.js 의존성 주입
initStudentDetailDeps({ renderSubFilters, renderListPanel, _isNaesinClassCode });

// visit-list-render.js 의존성 주입
initVisitRenderDeps({ getStudentChecklistStatus, renderFilterChips });

// loadClassSettings, getClassDomains, loadTeachers, trackTeacherLogin, getTeacherName,
// loadClassNextHw, saveClassNextHw, getNextHwStatus, getStudentDomains, getStudentTestItems,
// saveClassSettings, loadStudents, promoteEnrollPending,
// loadDailyRecords, loadRetakeSchedules, loadHwFailTasks, loadTestFailTasks,
// loadTempAttendances, loadTempClassOverrides,
// getStudentOverrides, getOverrideStudentsForClass, getOverridingOutFromClass, addOverrideInStudents,
// createTempClassOverride, cancelTempClassOverride,
// loadAbsenceRecords, _listenCollection, _realtimeRefreshUI, _isDetailInputFocused,
// loadLeaveRequests, _toDate, _isOlderThan, syncTaskStudentNames, autoCloseOldRecords,
// loadWithdrawnStudents, saveDailyRecord, saveRetakeSchedule, saveImmediately
// → imported from data-layer.js

window.createTempClassOverride = createTempClassOverride;
window.cancelTempClassOverride = cancelTempClassOverride;

// ─── 반 관리 헬퍼 ────────────────────────────────────────────────────────────

function getUniqueClassCodes() {
    const dayName = getDayName(state.selectedDate);
    const regularCodes = new Set();
    const naesinCodes = new Set();
    state.allStudents.forEach(s => {
        if (s.status === '퇴원') return;
        if (!matchesBranchFilter(s)) return;
        getActiveEnrollments(s, state.selectedDate).forEach(e => {
            const days = normalizeDays(e.day);
            if (!days.includes(dayName)) return;
            if (e.class_type === '내신') {
                const code = enrollmentCode(e);
                if (code) naesinCodes.add(code);
            } else {
                const code = enrollmentCode(e);
                if (code) regularCodes.add(code);
            }
        });
    });
    // 타반수업 target_class_code도 포함
    state.tempClassOverrides.forEach(o => {
        if (o.target_class_code) regularCodes.add(o.target_class_code);
    });
    return { regular: [...regularCodes].sort(), naesin: [...naesinCodes].sort() };
}

function getClassMgmtCount(filterKey) {
    const dayName = getDayName(state.selectedDate);
    let students = state.allStudents.filter(s =>
        s.status !== '퇴원' && getActiveEnrollments(s, state.selectedDate).some(e =>
            e.day.includes(dayName)
        )
    );
    students = students.filter(s => matchesBranchFilter(s));
    if (filterKey === 'all') {
        // override-in 학생 중 정규 목록에 없는 학생만 추가
        const ids = new Set(students.map(s => s.docId));
        const extraCount = state.tempClassOverrides.filter(o => !ids.has(o.student_id)).length;
        return students.length + extraCount;
    }
    const regularIds = new Set();
    let count = students.filter(s => {
        const match = getActiveEnrollments(s, state.selectedDate).some(e =>
            e.day.includes(dayName) && enrollmentCode(e) === filterKey
        );
        if (match) regularIds.add(s.docId);
        return match;
    }).length;
    // override-in 학생 수 추가 (정규 학생과 중복 제외)
    count += state.tempClassOverrides.filter(o => o.target_class_code === filterKey && !regularIds.has(o.student_id)).length;
    return count;
}

// ─── Category & SubFilter ──────────────────────────────────────────────────

function setCategory(category) {
    // 소속은 글로벌 필터 — 카테고리를 바꾸지 않고 L2 토글만
    if (category === 'branch') {
        const branchL1 = document.querySelector('.nav-l1[data-category="branch"]');
        const isExpanded = branchL1?.classList.contains('expanded');
        branchL1?.classList.toggle('expanded', !isExpanded);
        renderBranchFilter();
        renderSubFilters();
        renderListPanel();
        return;
    }

    // 반 관리도 글로벌 필터 — 카테고리를 바꾸지 않고 반 코드 드롭다운만 토글
    if (category === 'class_mgmt') {
        const classL1 = document.querySelector('.nav-l1[data-category="class_mgmt"]');
        const isExpanded = classL1?.classList.contains('expanded');
        classL1?.classList.toggle('expanded', !isExpanded);
        renderClassCodeFilter();
        renderFilterChips();
        renderSubFilters();
        renderListPanel();
        return;
    }

    if (state.currentCategory === category) {
        // 같은 카테고리 클릭: L2 토글 (필터는 유지)
        state.l2Expanded = !state.l2Expanded;
        state.savedL2Expanded[category] = state.l2Expanded;
    } else {
        // 이전 카테고리 상태 저장 (필터 유지)
        state.savedSubFilters[state.currentCategory] = new Set(state.currentSubFilter);
        state.savedL2Expanded[state.currentCategory] = false; // L2는 접지만 필터는 유지

        // 내신/특강 반 설정 모드 리셋 (카테고리 전환 시 필터 누출 방지)
        if (state._classMgmtMode === 'naesin' || state._classMgmtMode === 'teukang') { state._classMgmtMode = null; state.selectedClassCode = null; }

        state.currentCategory = category;

        // 새 카테고리의 저장된 필터 복원
        state.currentSubFilter.clear();
        if (state.savedSubFilters[category]?.size > 0) {
            for (const f of state.savedSubFilters[category]) {
                state.currentSubFilter.add(f);
            }
        }
        state.l2Expanded = true;
        state.savedL2Expanded[category] = true;
    }


    // L1 active 토글 (branch, class_mgmt 제외 — 글로벌 필터)
    document.querySelectorAll('.nav-l1').forEach(el => {
        if (el.dataset.category === 'branch' || el.dataset.category === 'class_mgmt') return;
        el.classList.toggle('active', el.dataset.category === category);
    });

    // L2 서브필터 렌더링
    renderSubFilters();
    updateL1ExpandIcons();

    renderListPanel();
}

function updateL1ExpandIcons() {
    document.querySelectorAll('.nav-l1').forEach(el => {
        const icon = el.querySelector('.nav-l1-expand');
        if (!icon) return;
        // branch, class_mgmt는 별도 관리
        if (el.dataset.category === 'branch' || el.dataset.category === 'class_mgmt') return;
        const isActive = el.dataset.category === state.currentCategory;
        icon.textContent = (isActive && state.l2Expanded) ? 'expand_less' : 'expand_more';
    });
}

function renderSubFilters() {
    const container = document.getElementById('nav-l2-group');
    const filters = {
        attendance: [
            { key: 'scheduled_visit', label: '비정규', children: [
                { key: 'sv_absence_makeup', label: '결석보충' },
                { key: 'sv_clinic', label: '클리닉' },
                { key: 'sv_diagnostic', label: '진단평가' },
                { key: 'sv_fail', label: '미통과' }
            ]},
            { key: 'pre_arrival', label: '정규', children: [
                { key: 'enroll_pending', label: '등원예정' },
                { key: 'present', label: '출석' },
                { key: 'late', label: '지각' },
                { key: 'absent', label: '결석' },
                { key: 'other', label: '기타' },
                { key: 'departure_check', label: '귀가점검' }
            ]},
            { key: 'naesin', label: '내신' },
            { key: 'teukang', label: '특강' }
        ],
        homework: [
            { key: 'hw_1st', label: '1차' },
            { key: 'hw_2nd', label: '2차' },
            { key: 'hw_next', label: '다음숙제' }
        ],
        test: [
            { key: 'test_1st', label: '1차' },
            { key: 'test_2nd', label: '2차' }
        ],
        automation: [
            { key: 'auto_hw_missing', label: '미제출 숙제' },
            { key: 'auto_retake', label: '재시 필요' },
            { key: 'auto_unchecked', label: '미체크 출석' }
        ],
        admin: [
            { key: 'absence_ledger', label: '결석대장' },
            { key: 'leave_request', label: '휴퇴원요청' },
            { key: 'return_upcoming', label: '복귀예정' }
        ]
    };

    const items = filters[state.currentCategory] || [];

    if (items.length === 0) {
        container.innerHTML = '<div style="padding:16px;color:var(--text-sec);font-size:13px;">추후 확장 예정</div>';
    } else {
        _subFilterBase = null; // 캐시 초기화
        resetReturnUpcomingCache();
        clearVisitCache();
        let html = '';
        for (const f of items) {
            const childKeys = f.children ? f.children.map(c => c.key) : [];
            const parentOrChildActive = state.currentSubFilter.has(f.key) || childKeys.some(k => state.currentSubFilter.has(k));
            const isActive = state.currentSubFilter.has(f.key) ? 'active' : '';
            const isExpanded = parentOrChildActive ? 'l2-expanded' : '';
            const parentClass = f.children ? 'l2-parent' : '';
            const expandIcon = f.children
                ? `<span class="material-symbols-outlined l2-expand-icon">${parentOrChildActive ? 'expand_less' : 'expand_more'}</span>`
                : '';
            const { count, total } = getSubFilterCount(f.key);
            const badge = count > 0 || total > 0
                ? `<span class="nav-l2-count">${total > 0 ? `${count}/${total}` : count}</span>`
                : '';
            html += `<div class="nav-l2 ${parentClass} ${isExpanded} ${isActive}" data-filter="${f.key}" onclick="setSubFilter('${f.key}')">
                ${esc(f.label)}
                ${badge}
                ${expandIcon}
            </div>`;
            if (f.children && parentOrChildActive) {
                for (const child of f.children) {
                    const childActive = state.currentSubFilter.has(child.key) ? 'active' : '';
                    const { count: cc, total: ct } = getSubFilterCount(child.key);
                    const childBadge = cc > 0 || ct > 0
                        ? `<span class="nav-l2-count">${ct > 0 ? `${cc}/${ct}` : cc}</span>`
                        : '';
                    html += `<div class="nav-l2 nav-l3 ${childActive}" data-filter="${child.key}" onclick="setSubFilter('${child.key}')">
                        ${esc(child.label)}
                        ${childBadge}
                    </div>`;
                }
            }
        }
        container.innerHTML = html;
    }

    // L2 컨테이너를 활성 L1 바로 뒤에 배치
    const activeL1 = document.querySelector('.nav-l1.active');
    if (activeL1) {
        activeL1.after(container);
    }

    // 펼침/접힘 상태 반영
    container.style.display = state.l2Expanded ? '' : 'none';
}

function renderBranchFilter() {
    let container = document.getElementById('nav-branch-l2');
    const branchL1 = document.querySelector('.nav-l1[data-category="branch"]');
    if (!branchL1) return;

    if (!container) {
        container = document.createElement('div');
        container.id = 'nav-branch-l2';
        container.className = 'nav-l2-group';
        branchL1.after(container);
    }

    const branches = [
        { key: '2단지', label: '2단지', children: ['초등', '중등', '고등'] },
        { key: '10단지', label: '10단지', children: ['초등', '중등', '고등'] }
    ];
    const dayName = getDayName(state.selectedDate);
    const active = state.allStudents.filter(s =>
        s.status !== '퇴원' && getActiveEnrollments(s, state.selectedDate).some(e =>
            e.day.includes(dayName)
        )
    );

    let html = '';
    for (const b of branches) {
        const branchStudents = active.filter(s => branchFromStudent(s) === b.key);
        const count = branchStudents.length;
        const isBranchSelected = state.selectedBranch === b.key;
        const parentActive = isBranchSelected && !state.selectedBranchLevel ? 'active' : '';
        const expanded = isBranchSelected ? 'l2-expanded' : '';

        html += `<div class="nav-l2 l2-parent ${parentActive} ${expanded}" data-filter="${b.key}" onclick="setBranch('${b.key}')">
            ${esc(b.label)}
            ${count > 0 ? `<span class="nav-l2-count">${count}</span>` : ''}
            <span class="material-symbols-outlined l2-expand-icon">${isBranchSelected ? 'expand_less' : 'expand_more'}</span>
        </div>`;

        if (isBranchSelected) {
            for (const level of b.children) {
                const levelCount = branchStudents.filter(s => (s.level || '') === level).length;
                const levelActive = state.selectedBranchLevel === level ? 'active' : '';
                html += `<div class="nav-l2 nav-l3 ${levelActive}" data-filter="${b.key}_${level}" onclick="setBranchLevel('${level}')">
                    ${esc(level)}
                    ${levelCount > 0 ? `<span class="nav-l2-count">${levelCount}</span>` : ''}
                </div>`;
            }
        }
    }
    container.innerHTML = html;

    const isExpanded = branchL1.classList.contains('expanded');
    container.style.display = isExpanded ? '' : 'none';

    // 소속 L1 expand 아이콘 업데이트
    const icon = branchL1.querySelector('.nav-l1-expand');
    if (icon) icon.textContent = isExpanded ? 'expand_less' : 'expand_more';

    // 소속 선택 시 L1에 시각적 표시
    branchL1.classList.toggle('has-filter', !!state.selectedBranch);
}

// state._classMgmtMode → state._classMgmtMode
// LEVEL_SHORT → imported from state.js

// deriveNaesinCode → imported from student-helpers.js

// 특강 학생 조회: enrollmentCode 기반(신규) + schedule 기반(구형 데이터 호환)
function isInTeukangClass(s, classCode, _scheduleDays) {
    const scheduleDays = _scheduleDays ?? new Set(Object.keys(state.classSettings[classCode]?.schedule || {}));
    return (s.enrollments || []).some(e => {
        if (e.class_type !== '특강') return false;
        const ec = enrollmentCode(e);
        if (ec) return ec === classCode;
        return scheduleDays.size > 0 && e.day?.some(d => scheduleDays.has(d));
    });
}

function getTeukangClassStudents(classCode) {
    const scheduleDays = new Set(Object.keys(state.classSettings[classCode]?.schedule || {}));
    // 특강 enrollment 자체가 필터 역할. 퇴원 학생도 특강 수강 가능.
    return state.allStudents.filter(s =>
        matchesBranchFilter(s) && isInTeukangClass(s, classCode, scheduleDays)
    );
}

function _getAllClassCodes() {
    const regularCodes = new Set();
    const naesinCounts = new Map();
    state.allStudents.forEach(s => {
        if (s.status === '퇴원') return;
        if (!matchesBranchFilter(s)) return;
        const levelShort = LEVEL_SHORT[s.level] || '';

        let hasRegular = false;
        (s.enrollments || []).forEach(e => {
            const code = enrollmentCode(e);
            if (!code) return;
            if (e.class_type === '내신' || e.class_type === '특강') return;
            regularCodes.add(code);
            hasRegular = true;
        });

        // 내신 반코드 유도 (초등 제외, 정규 enrollment이 있는 학생만)
        // key = 소속+반코드 (Firestore 키), displayCode = 반코드만 (표시용)
        if (hasRegular && levelShort && levelShort !== '초') {
            const nCode = deriveNaesinCode(s, (s.enrollments || []).find(e => e.class_type !== '내신' && e.class_number) || {});
            if (nCode) {
                const key = branchFromStudent(s) + nCode;
                if (!naesinCounts.has(key)) naesinCounts.set(key, { displayCode: nCode, count: 0 });
                naesinCounts.get(key).count++;
            }
        }
    });
    const naesinWithCounts = [...naesinCounts.entries()]
        .map(([key, { displayCode, count }]) => ({ code: key, displayCode, count }))
        .sort((a, b) => a.displayCode.localeCompare(b.displayCode, 'ko'));
    const teukang = Object.entries(state.classSettings)
        .filter(([, cs]) => cs.class_type === '특강')
        .map(([code]) => code)
        .sort();
    return { regular: [...regularCodes].sort(), naesin: naesinWithCounts, teukang };
}

// 내신 반코드(Firestore 키)로 학생 목록 조회
// classKey = 소속+반코드 (예: "2단지신목중2A"), 빈 소속이면 "신목중2A"
function getNaesinStudentsByDerivedCode(classKey) {
    if (!classKey) return [];
    const result = [];
    const seen = new Set();
    state.allStudents.forEach(s => {
        if (s.status === '퇴원') return;
        if (!matchesBranchFilter(s)) return;
        const regularEnroll = (s.enrollments || []).find(e => e.class_type !== '내신' && e.class_number);
        if (!regularEnroll) return;
        const nCode = deriveNaesinCode(s, regularEnroll);
        if (!nCode) return;
        if (branchFromStudent(s) + nCode !== classKey) return;
        if (!seen.has(s.docId)) {
            seen.add(s.docId);
            result.push({ student: s });
        }
    });
    return result;
}
window.branchFromStudent = branchFromStudent;
window.deriveNaesinCode = deriveNaesinCode;
window.getNaesinStudentsByDerivedCode = getNaesinStudentsByDerivedCode;

function renderClassCodeFilter() {
    let container = document.getElementById('nav-class-l2');
    const classL1 = document.querySelector('.nav-l1[data-category="class_mgmt"]');
    if (!classL1) return;

    if (!container) {
        container = document.createElement('div');
        container.id = 'nav-class-l2';
        container.className = 'nav-l2-group';
        classL1.after(container);
    }

    const { regular, naesin, teukang } = _getAllClassCodes();

    const regExpanded = state._classMgmtMode === 'regular';
    const naeExpanded = state._classMgmtMode === 'naesin';
    const tekExpanded = state._classMgmtMode === 'teukang';

    let html = '';

    // 정규 L2
    html += `<div class="nav-l2 l2-parent ${regExpanded ? 'active l2-expanded' : ''}" onclick="window.setClassMgmtMode('regular')">
        정규<span class="nav-l2-count">${regular.length}</span>
        <span class="material-symbols-outlined l2-expand-icon">${regExpanded ? 'expand_less' : 'expand_more'}</span>
    </div>`;
    if (regExpanded) {
        html += regular.map(code => {
            const isActive = state.selectedClassCode === code ? 'active' : '';
            const count = getClassMgmtCount(code);
            return `<div class="nav-l2 nav-l3 ${isActive}" onclick="setClassCode('${escAttr(code)}')">
                ${esc(code)}${count > 0 ? `<span class="nav-l2-count">${count}</span>` : ''}
            </div>`;
        }).join('');
    }

    // 내신 L2
    // 선택 요일에 따라 A(홀수=월수금)/B(짝수=화목토) 필터
    const dayName = getDayName(state.selectedDate);
    const dayIdx = ['월','화','수','목','금','토','일'].indexOf(dayName);
    const todayGroup = (dayIdx >= 0) ? ((dayIdx % 2 === 0) ? 'A' : 'B') : null; // 월(0)수(2)금(4)=A, 화(1)목(3)토(5)=B
    const filteredNaesin = todayGroup ? naesin.filter(n => n.code.endsWith(todayGroup)) : naesin;

    html += `<div class="nav-l2 l2-parent ${naeExpanded ? 'active l2-expanded' : ''}" onclick="window.setClassMgmtMode('naesin')">
        내신<span class="nav-l2-count">${filteredNaesin.length}</span>
        <span class="material-symbols-outlined l2-expand-icon">${naeExpanded ? 'expand_less' : 'expand_more'}</span>
    </div>`;
    if (naeExpanded) {
        html += filteredNaesin.map(({ code, displayCode, count }) => {
            const isActive = state.selectedClassCode === code ? 'active' : '';
            return `<div class="nav-l2 nav-l3 ${isActive}" onclick="setClassCode('${escAttr(code)}')">
                ${esc(displayCode)}${count > 0 ? `<span class="nav-l2-count">${count}</span>` : ''}
            </div>`;
        }).join('');
    }

    // 특강 L2
    html += `<div class="nav-l2 l2-parent ${tekExpanded ? 'active l2-expanded' : ''}" onclick="window.setClassMgmtMode('teukang')">
        특강<span class="nav-l2-count">${teukang.length}</span>
        <span class="material-symbols-outlined l2-expand-icon">${tekExpanded ? 'expand_less' : 'expand_more'}</span>
    </div>`;
    if (tekExpanded) {
        html += teukang.map(code => {
            const isActive = state.selectedClassCode === code ? 'active' : '';
            const count = getTeukangClassStudents(code).length;
            return `<div class="nav-l2 nav-l3 ${isActive}" onclick="setClassCode('${escAttr(code)}')">
                ${esc(code)}${count > 0 ? `<span class="nav-l2-count">${count}</span>` : ''}
            </div>`;
        }).join('');
    }

    container.innerHTML = html;

    const isExpanded = classL1.classList.contains('expanded');
    container.style.display = isExpanded ? '' : 'none';

    const icon = classL1.querySelector('.nav-l1-expand');
    if (icon) icon.textContent = isExpanded ? 'expand_less' : 'expand_more';

    classL1.classList.toggle('has-filter', !!state.selectedClassCode);
}

window.setClassMgmtMode = function(mode) {
    state._classMgmtMode = (state._classMgmtMode === mode) ? null : mode; // 토글
    state.selectedClassCode = null;
    renderClassCodeFilter();
    renderStudentDetail(null);
    renderListPanel();
};

function setClassCode(code) {
    state.selectedClassCode = state.selectedClassCode === code ? null : code;
    state.selectedStudentId = null; // 반 변경 시 학생 선택 해제

    renderClassCodeFilter();
    renderFilterChips();
    renderSubFilters();

    renderListPanel();
    // 반 해제 시 디테일 초기화
    if (!state.selectedClassCode) {
        renderStudentDetail(null);
    }
}

function setBranch(branchKey) {
    if (state.selectedBranch === branchKey) {
        state.selectedBranch = null;
        state.selectedBranchLevel = null;
    } else {
        state.selectedBranch = branchKey;
        state.selectedBranchLevel = null;
    }

    renderBranchFilter();
    renderSubFilters();
    renderListPanel();
}

function setBranchLevel(level) {
    state.selectedBranchLevel = state.selectedBranchLevel === level ? null : level;

    renderBranchFilter();
    renderSubFilters();
    renderListPanel();
}


function renderFilterChips() {
    const container = document.getElementById('filter-chips');
    if (!container) return;

    const categoryLabels = { attendance: '출결', homework: '숙제', test: '테스트', automation: '자동화', admin: '행정' };
    const subFilterLabels = {
        scheduled_visit: '비정규', pre_arrival: '정규', present: '출석', late: '지각', absent: '결석', other: '기타',
        departure_check: '귀가점검', enroll_pending: '등원예정',
        absence_ledger: '결석대장', leave_request: '휴퇴원요청', return_upcoming: '복귀예정',
        sv_absence_makeup: '결석보충', sv_clinic: '클리닉', sv_diagnostic: '진단평가', sv_fail: '미통과',
        hw_1st: '1차', hw_2nd: '2차', hw_next: '다음숙제',
        test_1st: '1차', test_2nd: '2차',
        auto_hw_missing: '미제출 숙제', auto_retake: '재시 필요', auto_unchecked: '미체크 출석',
        naesin: '내신',
        teukang: '특강'
    };

    const chips = [];

    // 모든 콘텐츠 카테고리의 활성 필터를 칩으로 표시
    const allFilters = { ...state.savedSubFilters };
    allFilters[state.currentCategory] = new Set(state.currentSubFilter);

    for (const [cat, filters] of Object.entries(allFilters)) {
        if (!filters?.size || !categoryLabels[cat]) continue;
        const catLabel = categoryLabels[cat];
        const subLabel = [...filters].map(k => subFilterLabels[k] || k).join('·');
        chips.push({ label: `${catLabel}: ${subLabel}`, onRemove: `clearCat:${cat}` });
    }

    // 소속 칩
    if (state.selectedBranch) {
        const branchLabel = state.selectedBranchLevel ? `${state.selectedBranch} ${state.selectedBranchLevel}` : state.selectedBranch;
        chips.push({ label: `소속: ${branchLabel}`, onRemove: 'clearBranch' });
    }

    // 반 칩
    if (state.selectedClassCode) {
        chips.push({ label: `반: ${state.selectedClassCode}`, onRemove: 'clearClassCode' });
    }

    if (chips.length === 0) {
        container.innerHTML = '<span class="filter-chips-empty">전체</span>';
    } else {
        container.innerHTML = chips.map(c =>
            `<span class="filter-chip">${esc(c.label)}<button class="filter-chip-close" onclick="removeFilterChip('${escAttr(c.onRemove)}')">&times;</button></span>`
        ).join('') +
            `<button class="filter-chip-clear-all" onclick="clearAllFilters()" title="모든 필터 해제">&times;</button>`;
    }
}

function removeFilterChip(action) {
    if (action.startsWith('clearCat:')) {
        const cat = action.replace('clearCat:', '');
        if (cat === state.currentCategory) {
            state.currentSubFilter.clear();
            state.l2Expanded = false;
        }
        state.savedSubFilters[cat] = new Set();
        state.savedL2Expanded[cat] = false;
        // L2 UI 동기화
        renderSubFilters();
        updateL1ExpandIcons();
    } else if (action === 'clearBranch') {
        state.selectedBranch = null;
        state.selectedBranchLevel = null;
        const branchL1 = document.querySelector('.nav-l1[data-category="branch"]');
        branchL1?.classList.remove('expanded');
        renderBranchFilter();
    } else if (action === 'clearClassCode') {
        state.selectedClassCode = null;
        const classL1 = document.querySelector('.nav-l1[data-category="class_mgmt"]');
        classL1?.classList.remove('expanded');
        renderClassCodeFilter();
        // 디테일 패널 초기화
        state.selectedStudentId = null;
    }


    renderFilterChips();
    renderListPanel();
}

function clearAllFilters() {
    // 콘텐츠 필터 전부 해제
    state.currentSubFilter.clear();
    for (const cat of Object.keys(state.savedSubFilters)) {
        state.savedSubFilters[cat] = new Set();
        state.savedL2Expanded[cat] = false;
    }
    state.l2Expanded = false;
    state.selectedBranch = null;
    state.selectedBranchLevel = null;
    state.selectedClassCode = null;
    document.querySelector('.nav-l1[data-category="branch"]')?.classList.remove('expanded');
    document.querySelector('.nav-l1[data-category="class_mgmt"]')?.classList.remove('expanded');
    // UI 동기화
    state.selectedStudentId = null;
    renderStudentDetail(null);

    renderBranchFilter();
    renderClassCodeFilter();
    renderSubFilters();
    updateL1ExpandIcons();

    renderFilterChips();
    renderListPanel();
}

window.removeFilterChip = removeFilterChip;
window.clearAllFilters = clearAllFilters;

function setSubFilter(filterKey) {
    // 단일 선택: 같은 필터 클릭 시 해제, 다른 필터 클릭 시 교체
    if (state.currentSubFilter.has(filterKey)) {
        state.currentSubFilter.clear();
    } else {
        state.currentSubFilter.clear();
        state.currentSubFilter.add(filterKey);
    }

    // 현재 카테고리의 L2 상태 저장
    state.savedSubFilters[state.currentCategory] = new Set(state.currentSubFilter);

    // L3 확장/축소 반영을 위해 innerHTML 재구성
    renderSubFilters();
    renderListPanel();
}

const REGULAR_CLASS_TYPES = ['정규', '내신', '자유학기'];

// 출결 토글 첫 버튼의 CSS 톤 매핑. key는 표시 라벨(예: '자유'), class_type 데이터 값('자유학기')과는 의도적으로 다름.
const DEFAULT_TONE = { '정규':'normal', '특강':'teukang', '내신':'naesin', '자유':'jayu', '비정규':'bijeong' };

let _regularDayCache = { date: null, dayName: null };
function hasRegularEnrollmentToday(student) {
    if (_regularDayCache.date !== state.selectedDate) {
        _regularDayCache = { date: state.selectedDate, dayName: getDayName(state.selectedDate) };
    }
    const dayName = _regularDayCache.dayName;
    return getActiveEnrollments(student, state.selectedDate).some(e =>
        e.day.includes(dayName) &&
        REGULAR_CLASS_TYPES.includes(e.class_type || '정규')
    );
}

function hasTeukangEnrollmentToday(student) {
    if (_regularDayCache.date !== state.selectedDate) {
        _regularDayCache = { date: state.selectedDate, dayName: getDayName(state.selectedDate) };
    }
    return getActiveEnrollments(student, state.selectedDate).some(e => {
        if (e.class_type !== '특강' || !e.day.includes(_regularDayCache.dayName)) return false;
        const ec = enrollmentCode(e);
        // 삭제된 반의 orphaned enrollment 제외 (classSettings에 존재하는 특강만)
        return ec && state.classSettings[ec]?.class_type === '특강';
    });
}

// 비정규 등원 여부 판별 (hw_fail/test_fail/extra_visit)
// 출결 리스트 정렬용 — enrollment.start_time + 비정규 소스(hw_fail/test_fail/extra_visit)
// 중 가장 이른 시각. 없으면 '99:99' (맨 뒤로).
function getEffectiveAttendanceTime(s, date, dayName) {
    const times = [];
    const todayE = getActiveEnrollments(s, date).find(e => (e.day || []).includes(dayName));
    const enrollTime = getStudentStartTime(todayE, dayName);
    if (enrollTime) times.push(enrollTime);

    const docId = s.docId;
    for (const t of state.hwFailTasks) {
        if (t.student_id !== docId || t.type !== '등원' || t.status !== 'pending') continue;
        if (t.scheduled_date === date && t.scheduled_time) times.push(t.scheduled_time);
    }
    for (const t of state.testFailTasks) {
        if (t.student_id !== docId || t.type !== '등원' || t.status !== 'pending') continue;
        if (t.scheduled_date === date && t.scheduled_time) times.push(t.scheduled_time);
    }
    const ev = state.dailyRecords[docId]?.extra_visit;
    if (ev?.date === date && ev.time) times.push(ev.time);
    const hfa = state.dailyRecords[docId]?.hw_fail_action || {};
    for (const a of Object.values(hfa)) {
        if (a.type === '등원' && a.scheduled_date === date && a.scheduled_time) times.push(a.scheduled_time);
    }

    return times.length === 0 ? '99:99' : times.sort()[0];
}

function isVisitStudent(docId) {
    const hwFail = state.dailyRecords[docId]?.hw_fail_action || {};
    if (Object.values(hwFail).some(a => a.type === '등원' && a.scheduled_date === state.selectedDate)) return true;
    const today = todayStr();
    const isToday = state.selectedDate === today;
    // 오늘 예정이거나, 오늘 볼 때 지연된(overdue) pending task도 포함
    if (state.hwFailTasks.some(t => t.student_id === docId && t.type === '등원' && t.status === 'pending' &&
        (t.scheduled_date === state.selectedDate || (isToday && t.scheduled_date && t.scheduled_date < today)))) return true;
    if (state.testFailTasks.some(t => t.student_id === docId && t.type === '등원' && t.status === 'pending' &&
        (t.scheduled_date === state.selectedDate || (isToday && t.scheduled_date && t.scheduled_date < today)))) return true;
    if (state.dailyRecords[docId]?.extra_visit?.date === state.selectedDate) return true;
    return false;
}

// 캐시: renderSubFilters에서 탭당 반복 호출 시 base list 재계산 방지
let _subFilterBase = null;

function _getSubFilterBase() {
    if (_subFilterBase) return _subFilterBase;

    const dayName = getDayName(state.selectedDate);
    let todayStudents = state.allStudents.filter(s =>
        s.status !== '퇴원' && getActiveEnrollments(s, state.selectedDate).some(e =>
            e.day.includes(dayName)
        )
    );
    todayStudents = todayStudents.filter(s => matchesBranchFilter(s));
    if (state.selectedClassCode) todayStudents = todayStudents.filter(s => getActiveEnrollments(s, state.selectedDate).some(e =>
        e.day.includes(dayName) && enrollmentCode(e) === state.selectedClassCode
    ));

    const existingIds = new Set(todayStudents.map(s => s.docId));
    const visitStudentIds = new Set();
    state.allStudents.forEach(s => {
        if (existingIds.has(s.docId)) return;
        if (state.selectedClassCode && !s.enrollments.some(e => enrollmentCode(e) === state.selectedClassCode)) return;
        if (isVisitStudent(s.docId)) {
            todayStudents.push(s);
            existingIds.add(s.docId);
            visitStudentIds.add(s.docId);
        }
    });

    const regularOnly = todayStudents.filter(s => !visitStudentIds.has(s.docId));
    _subFilterBase = { todayStudents, visitStudentIds, regularOnly };
    return _subFilterBase;
}

function getSubFilterCount(filterKey) {
    const { todayStudents, regularOnly } = _getSubFilterBase();
    const total = todayStudents.length;
    const r = (count) => ({ count, total });

    if (state.currentCategory === 'attendance') {
        const realRegular = regularOnly.filter(s => hasRegularEnrollmentToday(s));
        const regularTotal = realRegular.length;
        const rr = (count) => ({ count, total: regularTotal });

        switch (filterKey) {
            case 'scheduled_visit': {
                const visits = getScheduledVisits();
                const pending = visits.filter(v => v.status === 'pending').length;
                return { count: pending, total: visits.length };
            }
            case 'all': return rr(regularTotal);
            case 'pre_arrival': {
                const preStudents = regularOnly.filter(s => hasRegularEnrollmentToday(s));
                const enrollPending = getEnrollPendingVisits();
                const pending = preStudents.filter(s => {
                    const rec = state.dailyRecords[s.docId];
                    return !rec?.attendance?.status || rec.attendance.status === '미확인';
                }).length + enrollPending.length;
                return { count: pending, total: preStudents.length + enrollPending.length };
            }
            case 'enroll_pending': {
                const visits = getEnrollPendingVisits();
                return { count: visits.length, total: visits.length };
            }
            case 'present': return rr(realRegular.filter(s => state.dailyRecords[s.docId]?.attendance?.status === '출석').length);
            case 'late': return rr(realRegular.filter(s => state.dailyRecords[s.docId]?.attendance?.status === '지각').length);
            case 'absent': return rr(realRegular.filter(s => state.dailyRecords[s.docId]?.attendance?.status === '결석').length);
            case 'other': return rr(realRegular.filter(s => {
                const st = state.dailyRecords[s.docId]?.attendance?.status;
                return st && !['미확인', '출석', '지각', '결석'].includes(st);
            }).length);
            case 'departure_check': {
                const departed = realRegular.filter(s => state.dailyRecords[s.docId]?.departure?.status === '귀가').length;
                return { count: departed, total: regularTotal };
            }
            case 'naesin': {
                const naesinStudents = window._getNaesinStudents ? window._getNaesinStudents() : [];
                return { count: naesinStudents.length, total: naesinStudents.length };
            }
            case 'teukang': {
                const cnt = regularOnly.filter(hasTeukangEnrollmentToday).length;
                return { count: cnt, total: cnt };
            }
            default: {
                const svSources = SV_SOURCE_MAP[filterKey];
                if (svSources) {
                    const visits = getScheduledVisits().filter(v => svSources.includes(v.source));
                    const pending = visits.filter(v => v.status === 'pending').length;
                    return { count: pending, total: visits.length };
                }
                return rr(0);
            }
        }
    }

    if (state.currentCategory === 'admin') {
        switch (filterKey) {
            case 'absence_ledger': {
                const _approvedLeaveIds = new Set(
                    state.leaveRequests.filter(lr => lr.status === 'approved' && (lr.request_type === '퇴원요청' || lr.request_type === '휴원→퇴원'))
                        .map(lr => lr.student_id)
                );
                let filtered = state.absenceRecords.filter(r => !_approvedLeaveIds.has(r.student_id));
                if (state.selectedBranch) filtered = filtered.filter(r => r.branch === state.selectedBranch);
                return { count: filtered.length, total: 0 };
            }
            case 'leave_request': {
                let filtered = [...state.leaveRequests];
                if (state.selectedBranch) filtered = filtered.filter(r => r.branch === state.selectedBranch);
                const pending = filtered.filter(r => r.status === 'requested').length;
                const recentApproved = filtered.filter(r => r.status === 'approved' && !_isOlderThan(r.approved_at, { days: 7 })).length;
                return { count: pending, total: pending + recentApproved };
            }
            case 'return_upcoming': {
                const items = _getReturnUpcomingStudents();
                const urgent = items.filter(x => x.daysLeft <= 7).length;
                return { count: urgent, total: items.length };
            }
            default: return { count: 0, total: 0 };
        }
    }

    if (state.currentCategory === 'homework') {
        switch (filterKey) {
            case 'all': return r(total);
            case 'hw_1st': return r(todayStudents.filter(s => {
                const domains = state.dailyRecords[s.docId]?.hw_domains_1st;
                return domains && Object.values(domains).some(v => v);
            }).length);
            case 'hw_2nd': return r(todayStudents.filter(s => {
                const domains = getStudentDomains(s.docId);
                const d1st = state.dailyRecords[s.docId]?.hw_domains_1st || {};
                return domains.some(d => d1st[d] !== 'O');
            }).length);
            case 'hw_next': {
                const classCodes = getUniqueClassCodes().regular;
                const filledCount = classCodes.filter(cc => {
                    const { filled, total } = getNextHwStatus(cc);
                    return filled > 0;
                }).length;
                return { count: filledCount, total: classCodes.length };
            }
            case 'not_submitted': return r(todayStudents.filter(s => {
                const rec = state.dailyRecords[s.docId];
                return rec?.homework?.some(h => h.status === '미제출') || !rec?.homework?.length;
            }).length);
            case 'submitted': return r(todayStudents.filter(s => state.dailyRecords[s.docId]?.homework?.some(h => h.status === '제출')).length);
            case 'confirmed': return r(todayStudents.filter(s => state.dailyRecords[s.docId]?.homework?.some(h => h.status === '확인완료')).length);
            default: return r(0);
        }
    }

    if (state.currentCategory === 'test') {
        switch (filterKey) {
            case 'all': return r(total);
            case 'test_1st': return r(todayStudents.filter(s => {
                const d = state.dailyRecords[s.docId]?.test_domains_1st;
                return d && Object.values(d).some(v => v);
            }).length);
            case 'test_2nd': return r(todayStudents.filter(s => {
                const { flat } = getStudentTestItems(s.docId);
                const d1st = state.dailyRecords[s.docId]?.test_domains_1st || {};
                return flat.some(t => d1st[t] !== 'O');
            }).length);
            default: return r(0);
        }
    }

    if (state.currentCategory === 'automation') {
        switch (filterKey) {
            case 'auto_hw_missing': return r(todayStudents.filter(s => {
                const rec = state.dailyRecords[s.docId];
                return !rec?.homework?.length || rec.homework.some(h => h.status === '미제출');
            }).length);
            case 'auto_retake': return r(todayStudents.filter(s => {
                const rec = state.dailyRecords[s.docId];
                return rec?.tests?.some(t => t.result === '재시필요');
            }).length);
            case 'auto_unchecked': return r(todayStudents.filter(s => {
                const rec = state.dailyRecords[s.docId];
                return !rec?.attendance?.status || rec.attendance.status === '미확인';
            }).length);
            default: return r(0);
        }
    }

    return { count: 0, total: 0 };
}

// getScheduledVisits, getEnrollPendingVisits → imported from visit-list-render.js

// ─── Filtering ──────────────────────────────────────────────────────────────

function getFilteredStudents() {
    // 반 설정: 특강 모드 — 날짜 무관, 특강 반 전체 학생
    if (state._classMgmtMode === 'teukang' && state.selectedClassCode) {
        return getTeukangClassStudents(state.selectedClassCode);
    }

    // 반 설정: 내신 반코드 선택 시 (글로벌 필터이므로 state.currentCategory 무관)
    if (state._classMgmtMode === 'naesin' && state.selectedClassCode && _isNaesinClassCode(state.selectedClassCode)) {
        return getNaesinStudentsByDerivedCode(state.selectedClassCode).map(({ student }) => student);
    }

    // 반 설정: 정규 모드 — 현재 학기 학생
    if (state.currentCategory === 'class_mgmt') {
        const dayName = getDayName(state.selectedDate);
        let students = state.allStudents.filter(s =>
            s.status !== '퇴원' && getActiveEnrollments(s, state.selectedDate).some(e =>
                e.day.includes(dayName)
            )
        );
        // 타반수업 override-in 학생 추가 (정규 목록에 없는 학생만)
        addOverrideInStudents(students);
        students = students.filter(s => matchesBranchFilter(s));
        if (state.searchQuery) {
            const q = state.searchQuery.trim().toLowerCase();
            students = students.filter(s => {
                return (s.name?.toLowerCase().includes(q)) ||
                    (s.school?.toLowerCase().includes(q)) ||
                    (s.student_phone?.includes(q)) ||
                    (s.parent_phone_1?.includes(q)) ||
                    getActiveEnrollments(s, state.selectedDate).some(e => enrollmentCode(e).toLowerCase().includes(q)) ||
                    getActiveEnrollments(s, state.selectedDate).some(e => { const t = state.classSettings[enrollmentCode(e)]?.teacher; return t && getTeacherName(t).toLowerCase().includes(q); });
            });
        }
        if (state.currentSubFilter.size > 0 && !state.currentSubFilter.has('all')) {
            students = students.filter(s => {
                // 정규 enrollment 매칭
                const hasRegular = getActiveEnrollments(s, state.selectedDate).some(e =>
                    e.day.includes(dayName) && state.currentSubFilter.has(enrollmentCode(e))
                );
                // 타반수업 override-in 매칭
                const hasOverride = state.tempClassOverrides.some(o =>
                    o.student_id === s.docId && state.currentSubFilter.has(o.target_class_code)
                );
                return hasRegular || hasOverride;
            });
        }
        return students;
    }

    const dayName = getDayName(state.selectedDate);

    // 검색어가 있으면 요일 무관, 현재 학기 학생만 (퇴원/종강생은 과거 학생 검색에서 표시)
    // 내신 기간 중에는 getActiveEnrollments가 정규를 숨기므로 만료 여부만 직접 확인
    const today = state.selectedDate || todayStr();
    const validDateStr = (d) => d && /^\d{4}-/.test(d);
    let students;
    if (state.searchQuery) {
        students = state.allStudents.filter(s =>
            (s.enrollments || []).some(e => !(validDateStr(e.end_date) && e.end_date < today))
        );
    } else {
        students = state.allStudents.filter(s => {
            if (PAST_STUDENT_STATUSES.has(s.status)) {
                return getActiveEnrollments(s, state.selectedDate).some(e =>
                    e.class_type === '특강' && e.day.includes(dayName)
                );
            }
            if (LEAVE_STATUSES.includes(s.status) && s.pause_start_date && s.pause_end_date
                && state.selectedDate >= s.pause_start_date && state.selectedDate <= s.pause_end_date) return false;
            return getActiveEnrollments(s, state.selectedDate).some(e => e.day.includes(dayName));
        });
        // 세션 내 퇴원처리된 학생도 특강 수강 중이면 포함
        // (퇴원처리 시 state.allStudents→withdrawnStudents로 이동하므로 별도 체크 필요)
        const studentIds = new Set(students.map(s => s.docId));
        for (const s of state.withdrawnStudents) {
            if (!studentIds.has(s.docId) && getActiveEnrollments(s, state.selectedDate).some(e =>
                e.class_type === '특강' && e.day.includes(dayName)
            )) {
                students.push(s);
                studentIds.add(s.docId);
            }
        }
        // 타반수업 override-in 학생 추가 (반 필터 활성 시 해당 반 타반수업 학생만)
        addOverrideInStudents(students, state.selectedClassCode || null);
    }

    // 소속 글로벌 필터
    students = students.filter(s => matchesBranchFilter(s));

    // 반 글로벌 필터 (검색 시에는 반 필터 무시)
    if (state.selectedClassCode && !state.searchQuery) {
        students = students.filter(s => {
            const hasRegular = getActiveEnrollments(s, state.selectedDate).some(e =>
                e.day.includes(dayName) && enrollmentCode(e) === state.selectedClassCode
            );
            const hasOverride = state.tempClassOverrides.some(o =>
                o.student_id === s.docId && o.target_class_code === state.selectedClassCode
            );
            return hasRegular || hasOverride;
        });
    }

    // 검색어 필터
    if (state.searchQuery) {
        const q = state.searchQuery.trim().toLowerCase();
        students = students.filter(s => {
            return (s.name?.toLowerCase().includes(q)) ||
                (s.school?.toLowerCase().includes(q)) ||
                (s.student_phone?.includes(q)) ||
                (s.parent_phone_1?.includes(q)) ||
                s.enrollments.some(e => enrollmentCode(e).toLowerCase().includes(q)) ||
                s.enrollments.some(e => { const t = state.classSettings[enrollmentCode(e)]?.teacher; return t && getTeacherName(t).toLowerCase().includes(q); });
        });
    }

    // 모든 카테고리 필터를 AND로 적용
    // 현재 카테고리는 state.currentSubFilter, 나머지는 state.savedSubFilters에서
    const allFilters = { ...state.savedSubFilters };
    allFilters[state.currentCategory] = new Set(state.currentSubFilter);

    // 출결 필터
    const attF = allFilters['attendance'];
    if (attF?.size > 0) {
        students = students.filter(s => {
            const rec = state.dailyRecords[s.docId];
            const st = rec?.attendance?.status || '미확인';
            for (const f of attF) {
                if (f === 'pre_arrival' && (!st || st === '미확인')) return hasRegularEnrollmentToday(s);
                if (f === 'present' && st === '출석') return true;
                if (f === 'late' && st === '지각') return true;
                if (f === 'absent' && st === '결석') return true;
                if (f === 'other' && st && !['미확인', '출석', '지각', '결석'].includes(st)) return true;
                if (f === 'teukang' && hasTeukangEnrollmentToday(s)) return true;
            }
            return false;
        });
    }

    // 숙제 필터
    const hwF = allFilters['homework'];
    if (hwF?.size > 0) {
        const isHw1st = hwF.has('hw_1st');
        const isHw2nd = hwF.has('hw_2nd');
        if (isHw1st) {
            // 1차: 전원 표시
        } else if (isHw2nd) {
            students = students.filter(s => {
                const domains = getStudentDomains(s.docId);
                const d1st = state.dailyRecords[s.docId]?.hw_domains_1st || {};
                return domains.some(d => d1st[d] !== 'O');
            });
        } else {
            students = students.filter(s => {
                const rec = state.dailyRecords[s.docId];
                for (const f of hwF) {
                    if (f === 'hw_next') return true; // 반별 UI로 전환되므로 학생 필터링 스킵
                    if (f === 'not_submitted' && (rec?.homework?.some(h => h.status === '미제출') || !rec?.homework?.length)) return true;
                    if (f === 'submitted' && rec?.homework?.some(h => h.status === '제출')) return true;
                    if (f === 'confirmed' && rec?.homework?.some(h => h.status === '확인완료')) return true;
                }
                return false;
            });
        }
    }

    // 테스트 필터
    const testF = allFilters['test'];
    if (testF?.size > 0) {
        const isTest1st = testF.has('test_1st');
        const isTest2nd = testF.has('test_2nd');
        if (isTest1st) {
            // 1차: 전원 표시
        } else if (isTest2nd) {
            students = students.filter(s => {
                const { flat } = getStudentTestItems(s.docId);
                const d1st = state.dailyRecords[s.docId]?.test_domains_1st || {};
                return flat.some(t => d1st[t] !== 'O');
            });
        } else {
            students = students.filter(s => {
                const rec = state.dailyRecords[s.docId];
                for (const f of testF) {
                    if (f === 'scheduled' && rec?.tests?.some(t => t.score === undefined || t.score === null)) return true;
                    if (f === 'pass' && rec?.tests?.some(t => t.result === '통과')) return true;
                    if (f === 'retake' && rec?.tests?.some(t => t.result === '재시필요')) return true;
                }
                return false;
            });
        }
    }

    // 자동화 필터
    const autoF = allFilters['automation'];
    if (autoF?.size > 0) {
        students = students.filter(s => {
            const rec = state.dailyRecords[s.docId];
            for (const f of autoF) {
                if (f === 'auto_hw_missing' && (!rec?.homework?.length || rec.homework.some(h => h.status === '미제출'))) return true;
                if (f === 'auto_retake' && rec?.tests?.some(t => t.result === '재시필요')) return true;
                if (f === 'auto_unchecked' && (!rec?.attendance?.status || rec.attendance.status === '미확인')) return true;
            }
            return false;
        });
    }

    // hw_fail / test_fail / extra_visit 등원일이 오늘인 학생 추가 포함 (정규 수업 없어도 리스트에 나타나야 함)
    // 단, 출결 서브필터 활성 시 비정규 학생은 추가하지 않음 (비정규 페이지에서만 표시)
    const attFilterActive = allFilters['attendance']?.size > 0;
    if (!attFilterActive) {
        const existingIds = new Set(students.map(s => s.docId));
        const visitStudents = state.allStudents.filter(s => {
            if (existingIds.has(s.docId)) return false;
            if (state.selectedClassCode && !s.enrollments.some(e => enrollmentCode(e) === state.selectedClassCode)) return false;
            return isVisitStudent(s.docId);
        });
        if (visitStudents.length > 0) {
            let filtered = visitStudents;
            if (state.searchQuery) {
                const q = state.searchQuery.trim().toLowerCase();
                filtered = filtered.filter(s => {
                    return (s.name?.toLowerCase().includes(q)) ||
                        (s.school?.toLowerCase().includes(q)) ||
                        s.enrollments.some(e => enrollmentCode(e).toLowerCase().includes(q));
                });
            }
            students = [...students, ...filtered];
        }
    }

    // 출결 필터 활성 시 등원시간 임박순 정렬 (비정규 학생 포함 후 수행).
    // 비정규 학생은 enrollment가 없으므로 hw_fail/test_fail/extra_visit의 scheduled_time을 반영.
    const allF = { ...state.savedSubFilters };
    allF[state.currentCategory] = new Set(state.currentSubFilter);
    if (allF['attendance']?.size > 0 || state.currentCategory === 'attendance') {
        const dayName = getDayName(state.selectedDate);
        students.sort((a, b) => {
            return getEffectiveAttendanceTime(a, state.selectedDate, dayName)
                .localeCompare(getEffectiveAttendanceTime(b, state.selectedDate, dayName));
        });
    }

    return students;
}

// formatCompletedBadge, groupVisitsByStudent, renderVisitConfirmBtn, renderVisitSubitem,
// renderVisitGroup, renderScheduledVisitList, renderEnrollPendingItem, renderEnrollPendingSection,
// renderEnrollPendingOnly, renderDepartureCheckList → imported from visit-list-render.js

// renderAbsenceLedgerList → imported from absence-records.js

// renderLeaveRequestList, selectLeaveRequest, renderReturnUpcomingList, selectReturnUpcomingStudent
// → imported from leave-request.js

function renderListPanel() {
    // 내신 서브필터 활성 시 내신 리스트로 전환
    if (state.currentCategory === 'attendance' && state.currentSubFilter.has('naesin')) {
        if (window.renderNaesinList) window.renderNaesinList();
        return;
    }

    // 비정규 L2 또는 L3(sv_*) 서브필터 활성 시 통합 리스트로 전환
    if (state.currentCategory === 'attendance' && (
        state.currentSubFilter.has('scheduled_visit') ||
        SV_L3_KEYS.some(k => state.currentSubFilter.has(k))
    )) {
        renderScheduledVisitList();
        return;
    }

    // 등원예정 L3 선택 시 등원예정만 표시
    if (state.currentCategory === 'attendance' && state.currentSubFilter.has('enroll_pending')) {
        renderEnrollPendingOnly();
        return;
    }

    // 귀가점검 서브필터 활성 시 귀가 체크 리스트로 전환
    if (state.currentCategory === 'attendance' && state.currentSubFilter.has('departure_check')) {
        renderDepartureCheckList();
        return;
    }

    // 결석대장 서브필터 활성 시 결석대장 리스트로 전환
    if (state.currentCategory === 'admin' && state.currentSubFilter.has('absence_ledger')) {
        renderAbsenceLedgerList();
        return;
    }

    // 휴퇴원요청서 서브필터 활성 시 요청서 리스트로 전환
    if (state.currentCategory === 'admin' && state.currentSubFilter.has('leave_request')) {
        renderLeaveRequestList();
        return;
    }

    // 복귀예정 서브필터 활성 시 복귀예정 리스트로 전환
    if (state.currentCategory === 'admin' && state.currentSubFilter.has('return_upcoming')) {
        renderReturnUpcomingList();
        return;
    }

    // hw_next 서브필터 활성 시 반별 리스트로 전환
    if (state.currentCategory === 'homework' && state.currentSubFilter.has('hw_next')) {
        renderNextHwClassList();
        return;
    }

    const students = getFilteredStudents();
    const container = document.getElementById('list-items');
    const countEl = document.getElementById('list-count');
    const todayDate = new Date(todayStr());
    // 필터 칩 렌더링
    renderFilterChips();

    // 과거 학생 비동기 검색 (Firestore prefix 쿼리)
    let pastContactResults = [];
    if (state.searchQuery && state.searchQuery.trim().length >= 2) {
        const searchId = ++state._contactSearchId;
        _searchContactsDSC(state.searchQuery.trim()).then(results => {
            if (searchId !== state._contactSearchId || results.length === 0) return;
            pastContactResults = results;
            _renderPastContacts(results, container);
        });
    }

    // 벌크 모드: 현재 목록에 없는 학생 선택 해제, 0명이면 벌크모드 종료
    if (state.bulkMode) {
        const visibleIds = new Set(students.map(s => s.docId));
        for (const id of [...state.selectedStudentIds]) {
            if (!visibleIds.has(id)) state.selectedStudentIds.delete(id);
        }
        if (state.selectedStudentIds.size === 0) {
            exitBulkMode();
        } else {
            updateBulkBar();
        }
    }

    // 정규(pre_arrival) L2 활성 시 등원예정 인원도 카운트에 포함
    const enrollPendingCount = (state.currentCategory === 'attendance' && state.currentSubFilter.has('pre_arrival'))
        ? getEnrollPendingVisits().length : 0;
    countEl.textContent = `${students.length + enrollPendingCount}명`;

    if (students.length === 0 && pastContactResults.length === 0 && enrollPendingCount === 0) {
        container.innerHTML = `<div class="empty-state">
            <span class="material-symbols-outlined">person_search</span>
            <p>해당하는 학생이 없습니다</p>
        </div>`;
        return;
    }

    // 후속대책 버튼 표시 조건 — 한 번만 계산
    const isHw1stFilter = state.currentCategory === 'homework' && state.currentSubFilter.has('hw_1st');
    const isTest1stFilter = state.currentCategory === 'test' && state.currentSubFilter.has('test_1st');

    // 내신 학생 ID 집합 (오늘 요일 기준): 검색 시 todayStudents 분류 및 반코드 표시에 사용
    const naesinIds = new Set(
        (window._getNaesinStudents?.() || []).map(({ student }) => student.docId)
    );

    const renderItemHtml = (s) => {
        const isActive = s.docId === state.selectedStudentId ? 'active' : '';
        const dayN = getDayName(state.selectedDate);
        const _activeEnrolls = getActiveEnrollments(s, state.selectedDate);
        const _todayEnrolls = _activeEnrolls.filter(e => e.day.includes(dayN));
        // 내신 기간이라 정규 enrollment가 숨겨진 경우 내신 반코드로 대체
        const _naesinCodeFallback = (!_todayEnrolls.length && !_activeEnrolls.length && naesinIds.has(s.docId))
            ? (() => {
                const re = (s.enrollments || []).find(e => e.class_type !== '내신' && e.class_number);
                return re ? (deriveNaesinCode(s, re) || '') : '';
            })() : '';
        const code = _enrollCodeList(_todayEnrolls) || _enrollCodeList(_activeEnrolls) || _naesinCodeFallback;
        const branch = branchFromStudent(s);

        // 타반수업 배지
        const studentOverrides = getStudentOverrides(s.docId, state.selectedDate);
        const overrideBadge = studentOverrides.length > 0
            ? studentOverrides.map(o => `<span class="override-badge">→${esc(o.target_class_code)}</span>`).join('')
            : '';
        const overrideInEntries = state.tempClassOverrides.filter(o => o.student_id === s.docId);
        const overrideInBadge = overrideInEntries.length > 0 && !getActiveEnrollments(s, state.selectedDate).some(e => e.day.includes(dayN))
            ? overrideInEntries.map(o => `<span class="override-in-badge">타반(${esc(o.original_class_code)})</span>`).join('')
            : '';

        let toggleHtml = '';
        const isLeave = LEAVE_STATUSES.includes(s.status);
        // isLeave가 true면 short-circuit으로 every() 미실행
        const isTeukangOnly = !isLeave && _todayEnrolls.length > 0 && _todayEnrolls.every(e => e.class_type === '특강');

        if (isLeave || (PAST_STUDENT_STATUSES.has(s.status) && !isTeukangOnly)) {
            toggleHtml = '';
        } else if (state.currentCategory === 'attendance') {
            const rec = state.dailyRecords[s.docId];
            const attStatus = rec?.attendance?.status || '미확인';
            // 학생 레벨 현재 모드 판정 — 우선순위 비정규 > 내신 > 자유 > 특강 > 정규.
            // enrollment.class_type 단독 판정은 옛 자유학기 enrollment가 내신 기간에 살아남는
            // 경우(getActiveEnrollments step 2 결과) 오분류를 내므로 class_settings 윈도우를 확인.
            let defaultLabel;
            if (_todayEnrolls.length === 0 && isVisitStudent(s.docId)) defaultLabel = '비정규';
            else if (isNaesinActiveToday(s, state.selectedDate)) defaultLabel = '내신';
            else if (isFreeSemesterActiveToday(s, state.selectedDate)) defaultLabel = '자유';
            else if (isTeukangOnly) defaultLabel = '특강';
            else defaultLabel = '정규';
            const statuses = [defaultLabel, '출석', '지각', '결석', '조퇴', '기타'];
            // 저장된 기본 라벨(정규/특강/내신/자유/비정규)과 '미확인'은 현재 컨텍스트의 defaultLabel로 표시
            const currentDisplay = (attStatus === '미확인' || DEFAULT_ATTENDANCE_LABELS.has(attStatus)) ? defaultLabel : attStatus;
            toggleHtml = `<div class="toggle-group">` +
                statuses.map(st => {
                    const classes = ['toggle-btn'];
                    if (st === defaultLabel) classes.push(`default-tone-${DEFAULT_TONE[defaultLabel]}`);
                    if (st === currentDisplay) {
                        if (st === '출석') classes.push('active-present');
                        else if (st === '결석') classes.push('active-absent');
                        else if (st === '지각') classes.push('active-late');
                        else if (st === defaultLabel) classes.push('active-default');
                        else classes.push('active-other');
                    }
                    return `<button class="${classes.join(' ')}" onclick="event.stopPropagation(); toggleAttendance('${escAttr(s.docId)}', '${st}')">${st}</button>`;
                }).join('') +
                `</div>`;
        } else if (state.currentCategory === 'homework') {
            const rec = state.dailyRecords[s.docId];
            const isHw1st = state.currentSubFilter.has('hw_1st');
            const isHw2nd = state.currentSubFilter.has('hw_2nd');
            const isHwNext = state.currentSubFilter.has('hw_next');

            if (isHw1st || isHw2nd) {
                const field = isHw1st ? 'hw_domains_1st' : 'hw_domains_2nd';
                const domainData = rec?.[field] || {};
                const allDomains = getStudentDomains(s.docId);
                // 2차: 1차에서 O가 아닌 영역만 표시
                const domains = isHw2nd
                    ? allDomains.filter(d => (rec?.hw_domains_1st || {})[d] !== 'O')
                    : allDomains;
                toggleHtml = `<div class="hw-domain-group">` +
                    domains.map(d => {
                        const val = domainData[d] || '';
                        const cls = oxDisplayClass(val);
                        return `<div class="hw-domain-item">
                            <span class="hw-domain-label">${esc(d)}</span>
                            <button class="hw-domain-ox ${cls}" data-student="${escAttr(s.docId)}" data-field="${field}" data-domain="${escAttr(d)}"
                                onclick="event.stopPropagation(); toggleHwDomainOX('${escAttr(s.docId)}', '${field}', '${escAttr(d)}')">${esc(val || '—')}</button>
                        </div>`;
                    }).join('') +
                    `</div>`;
            } else if (isHwNext) {
                // L2 hw_next: 기존 커스텀 숙제 배열
                const homework = rec?.homework || [];
                if (homework.length === 0) {
                    toggleHtml = `<div class="toggle-group"><span style="font-size:12px;color:var(--text-sec);">숙제 없음</span></div>`;
                } else {
                    toggleHtml = homework.map((h, i) => {
                        const hStatuses = ['미제출', '제출', '확인완료'];
                        return `<div style="margin-top:4px;"><span style="font-size:12px;color:var(--text-sec);margin-right:8px;">${esc(h.title || '숙제'+(i+1))}</span>
                            <div class="toggle-group" style="display:inline-flex;">` +
                            hStatuses.map(st => {
                                let activeClass = '';
                                if (h.status === st) {
                                    activeClass = st === '확인완료' ? 'active-present' : st === '제출' ? 'active-late' : 'active-absent';
                                }
                                return `<button class="toggle-btn ${activeClass}" onclick="event.stopPropagation(); toggleHomework('${escAttr(s.docId)}', ${i}, '${st}')">${st}</button>`;
                            }).join('') +
                            `</div></div>`;
                    }).join('');
                }
            } else {
                // L1 숙제 (서브필터 없음): 읽기전용 영역 상태 요약
                const d1st = rec?.hw_domains_1st || {};
                const d2nd = rec?.hw_domains_2nd || {};
                const domains = getStudentDomains(s.docId);
                const has1st = Object.values(d1st).some(v => v);
                const has2nd = Object.values(d2nd).some(v => v);

                if (!has1st && !has2nd) {
                    toggleHtml = `<div class="toggle-group"><span style="font-size:12px;color:var(--text-sec);">영역 숙제 미입력</span></div>`;
                } else {
                    let summaryParts = [];
                    if (has1st) {
                        summaryParts.push(`<div class="hw-domain-summary"><span class="hw-domain-summary-label">1차</span><div class="hw-domain-group">` +
                            domains.map(d => {
                                const val = d1st[d] || '';
                                const cls = oxDisplayClass(val);
                                return `<div class="hw-domain-item">
                                    <span class="hw-domain-label">${esc(d)}</span>
                                    <span class="hw-domain-ox readonly ${cls}">${esc(val || '—')}</span>
                                </div>`;
                            }).join('') +
                            `</div></div>`);
                    }
                    if (has2nd) {
                        summaryParts.push(`<div class="hw-domain-summary"><span class="hw-domain-summary-label">2차</span><div class="hw-domain-group">` +
                            domains.map(d => {
                                const val = d2nd[d] || '';
                                const cls = oxDisplayClass(val);
                                return `<div class="hw-domain-item">
                                    <span class="hw-domain-label">${esc(d)}</span>
                                    <span class="hw-domain-ox readonly ${cls}">${esc(val || '—')}</span>
                                </div>`;
                            }).join('') +
                            `</div></div>`);
                    }
                    toggleHtml = summaryParts.join('');
                }
            }
        } else if (state.currentCategory === 'test') {
            const rec = state.dailyRecords[s.docId];
            const isTest1st = state.currentSubFilter.has('test_1st');
            const isTest2nd = state.currentSubFilter.has('test_2nd');

            if (isTest1st || isTest2nd) {
                // 1차/2차: 섹션별 OX 토글
                const field = isTest1st ? 'test_domains_1st' : 'test_domains_2nd';
                const domainData = rec?.[field] || {};
                const { sections } = getStudentTestItems(s.docId);
                const d1st = rec?.test_domains_1st || {};

                let sectionHtmlParts = [];
                for (const [secName, items] of Object.entries(sections)) {
                    const filtered = isTest2nd ? items.filter(t => d1st[t] !== 'O') : items;
                    if (filtered.length === 0) continue;
                    sectionHtmlParts.push(
                        `<div style="margin-top:4px;">` +
                        `<div class="hw-domain-group">` +
                        filtered.map(t => {
                            const val = domainData[t] || '';
                            const cls = oxDisplayClass(val);
                            return `<div class="hw-domain-item">
                                <span class="hw-domain-label">${esc(t)}</span>
                                <button class="hw-domain-ox ${cls}" data-student="${escAttr(s.docId)}" data-field="${field}" data-domain="${escAttr(t)}"
                                    onclick="event.stopPropagation(); toggleHwDomainOX('${escAttr(s.docId)}', '${field}', '${escAttr(t)}')">${esc(val || '—')}</button>
                            </div>`;
                        }).join('') +
                        `</div></div>`
                    );
                }
                toggleHtml = sectionHtmlParts.length > 0
                    ? sectionHtmlParts.join('')
                    : `<div class="toggle-group"><span style="font-size:12px;color:var(--text-sec);">테스트 항목 없음</span></div>`;
            } else {
                // L1 테스트 (서브필터 없음): 읽기전용 요약
                const d1st = rec?.test_domains_1st || {};
                const d2nd = rec?.test_domains_2nd || {};
                const { sections } = getStudentTestItems(s.docId);
                const has1st = Object.values(d1st).some(v => v);
                const has2nd = Object.values(d2nd).some(v => v);

                if (!has1st && !has2nd) {
                    toggleHtml = `<div class="toggle-group"><span style="font-size:12px;color:var(--text-sec);">테스트 미입력</span></div>`;
                } else {
                    let summaryParts = [];
                    for (const [round, data] of [['1차', d1st], ['2차', d2nd]]) {
                        if (!Object.values(data).some(v => v)) continue;
                        let secParts = [];
                        for (const [secName, items] of Object.entries(sections)) {
                            const hasAny = items.some(t => data[t]);
                            if (!hasAny) continue;
                            secParts.push(
                                `<div class="hw-domain-group">` +
                                items.map(t => {
                                    const val = data[t] || '';
                                    const cls = oxDisplayClass(val);
                                    return `<div class="hw-domain-item">
                                        <span class="hw-domain-label">${esc(t)}</span>
                                        <span class="hw-domain-ox readonly ${cls}">${esc(val || '—')}</span>
                                    </div>`;
                                }).join('') +
                                `</div>`
                            );
                        }
                        summaryParts.push(`<div class="hw-domain-summary"><span class="hw-domain-summary-label">${round}</span><div style="display:flex;flex-direction:column;gap:2px;">${secParts.join('')}</div></div>`);
                    }
                    toggleHtml = summaryParts.join('');
                }
            }
        } else if (state.currentCategory === 'automation') {
            const autoRec = state.dailyRecords[s.docId];
            const issues = [];
            if (!autoRec?.homework?.length) {
                issues.push('<span class="tag tag-absent" style="font-size:11px;">숙제 미등록</span>');
            } else {
                const missing = autoRec.homework.filter(h => h.status === '미제출');
                if (missing.length > 0) {
                    issues.push(...missing.map(h => `<span class="tag tag-absent" style="font-size:11px;">미제출: ${esc(h.title || '숙제')}</span>`));
                }
            }
            if (autoRec?.tests?.length) {
                const retakes = autoRec.tests.filter(t => t.result === '재시필요');
                if (retakes.length > 0) {
                    issues.push(...retakes.map(t => `<span class="tag tag-late" style="font-size:11px;">재시: ${esc(t.title || '테스트')} (${t.score != null ? t.score + '점' : '-'})</span>`));
                }
            }
            if (!autoRec?.attendance?.status || autoRec.attendance.status === '미확인') {
                issues.push('<span class="tag tag-pending" style="font-size:11px;">출석 미체크</span>');
            }
            if (issues.length > 0) {
                toggleHtml = `<div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:4px;">${issues.join('')}</div>`;
            } else {
                toggleHtml = `<div style="margin-top:4px;"><span style="font-size:12px;color:var(--text-sec);">이슈 없음</span></div>`;
            }
        } else if (state.currentCategory === 'class_mgmt') {
            toggleHtml = s.enrollments.map((e, idx) => {
                const days = e.day?.join('\u00B7') || '';
                const time = getStudentStartTime(e) ? formatTime12h(getStudentStartTime(e)) : '';
                return `<div style="margin-top:4px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                    <span style="font-size:12px;color:var(--text-sec);">${esc(enrollmentCode(e))} ${days} ${time}</span>
                    <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); openEnrollmentModal('${escAttr(s.docId)}', ${idx})">편집</button>
                </div>`;
            }).join('');
        }

        // 등원시간 (휴원 학생은 미표시)
        let timeHtml = '';
        const rec = state.dailyRecords[s.docId];
        const dayName = getDayName(state.selectedDate);
        const todayEnroll = getActiveEnrollments(s, state.selectedDate).find(e => e.day.includes(dayName));
        if (!isLeave) {
            const arrivalTime = rec?.arrival_time;
            let scheduledTime = getStudentStartTime(todayEnroll);
            if (!scheduledTime) {
                // 비정규(오늘 enrollment 없음) — hw_fail/test_fail/extra_visit의 가장 이른 scheduled_time 사용
                const eff = getEffectiveAttendanceTime(s, state.selectedDate, dayName);
                if (eff !== '99:99') scheduledTime = eff;
            }

            // hw_fail_tasks 등원 예약 시간 (선택날짜 기준 pending)
            const visitTasks = state.hwFailTasks.filter(t =>
                t.student_id === s.docId &&
                t.type === '등원' &&
                t.scheduled_date === state.selectedDate &&
                t.status === 'pending'
            );

            let timeLabel = '', timeValue = '', timeClass = '';
            if (arrivalTime) {
                timeLabel = '등원'; timeValue = formatTime12h(arrivalTime); timeClass = 'arrived';
            } else if (scheduledTime) {
                timeLabel = '예정'; timeValue = formatTime12h(scheduledTime);
            }
            timeHtml = [
                timeValue ? `<div class="item-time-block ${timeClass}">
                    <span class="item-time-label">${timeLabel}</span>
                    <span class="item-time-value">${esc(timeValue)}</span>
                </div>` : '',
                // 정규 수업과 시간이 다른 등원 예약 시간 추가 표시
                ...visitTasks
                    .filter(t => t.scheduled_time && t.scheduled_time !== scheduledTime)
                    .map(t => `<div class="item-time-block" style="color:var(--danger);">
                        <span class="item-time-label" style="color:var(--danger);">보충</span>
                        <span class="item-time-value" style="color:var(--danger);">${esc(formatTime12h(t.scheduled_time))}</span>
                    </div>`)
            ].join('');
        }

        // hw_fail_tasks 기반 아이콘 (대체숙제/등원예약) - pending 상태만
        const pendingTasks = state.hwFailTasks.filter(t => t.student_id === s.docId && t.status === 'pending');
        const hasAltHw = pendingTasks.some(t => t.type === '대체숙제');
        const hasVisit = pendingTasks.some(t => t.type === '등원');
        const hwFailIconHtml = hasAltHw
            ? `<span class="hw-fail-badge hw-fail-alt" title="대체숙제 있음"><span class="material-symbols-outlined" style="font-size:14px;">edit_note</span></span>`
            : hasVisit
            ? `<span class="hw-fail-badge hw-fail-visit" title="등원 예약 있음"><span class="material-symbols-outlined" style="font-size:14px;">directions_walk</span></span>`
            : '';

        // 형제 아이콘
        const hasSibling = state.siblingMap[s.docId]?.size > 0;
        const siblingNames = hasSibling ? [...state.siblingMap[s.docId]].map(sid => state.allStudents.find(x => x.docId === sid)?.name).filter(Boolean).join(', ') : '';
        const siblingIcon = hasSibling ? `<span class="item-icon item-icon-sibling" title="형제: ${esc(siblingNames)}"><span class="material-symbols-outlined">group</span></span>` : '';

        // 담당 뱃지 (첫 번째 반코드 기준)
        const todayCodes = getActiveEnrollments(s, state.selectedDate).filter(e => e.day.includes(dayN)).map(e => enrollmentCode(e));
        const primaryCode = todayCodes[0] || allClassCodes(s)[0] || '';
        const teacherEmail = state.classSettings[primaryCode]?.teacher;
        const teacherBadge = teacherEmail ? `<span class="teacher-badge" title="담당: ${esc(getTeacherName(teacherEmail))}">${esc(getTeacherName(teacherEmail))}</span>` : '';

        let leaveBadge = '';
        if (LEAVE_STATUSES.includes(s.status)) {
            leaveBadge = `<span class="tag tag-leave">${esc(s.status)}</span>`;
        } else if (s.status === '퇴원') {
            // 이번 학기 enrollment이 있거나 퇴원 1개월 이내 → 퇴원, 그 외 → 과거
            const hasCurrentSemester = s.enrollments.length > 0;
            const wdLr = state.leaveRequests.find(lr => lr.student_id === s.docId && lr.status === 'approved' &&
                (lr.request_type === '퇴원요청' || lr.request_type === '휴원→퇴원'));
            const isRecentWithdrawal = wdLr && !_isOlderThan(wdLr.approved_at, { months: 1 });
            if (hasCurrentSemester || isRecentWithdrawal) {
                leaveBadge = `<span class="tag" style="background:#dc2626;color:#fff;">퇴원</span>`;
            } else {
                leaveBadge = `<span class="tag-past">과거</span>`;
            }
        }

        // 신규 학생 뱃지 (enrollment start_date가 14일 이내)
        const newBadge = isNewStudent(s, todayDate) ? '<span class="tag tag-new">N</span>' : '';

        // 휴퇴원요청 승인 대기 태그
        const pendingLR = state.leaveRequests.find(lr => lr.student_id === s.docId && lr.status !== 'approved' && lr.status !== 'cancelled' && lr.status !== 'rejected');
        let lrPendingTags = '';
        if (pendingLR) {
            if (!pendingLR.teacher_approved_by) lrPendingTags += '<span class="tag" style="background:#fef3c7;color:#92400e;font-size:9px;">교수부대기</span>';
            if (!pendingLR.approved_by) lrPendingTags += '<span class="tag" style="background:#fef3c7;color:#92400e;font-size:9px;">행정부대기</span>';
        }

        // 후속대책 버튼: 1차 서브필터에서 미통과(X/△) 영역이 있으면 표시
        let followUpBtnHtml = '';
        if (!isLeave && (isHw1stFilter || isTest1stFilter)) {
            const rec = state.dailyRecords[s.docId] || {};
            const field = isHw1stFilter ? 'hw_domains_1st' : 'test_domains_1st';
            const category = isHw1stFilter ? 'homework' : 'test';
            const hasFail1st = Object.values(rec[field] || {}).some(v => v && v !== 'O');
            if (hasFail1st) {
                followUpBtnHtml = `<button class="follow-up-btn" title="후속대책" onclick="event.stopPropagation(); openFollowUpAction('${escAttr(s.docId)}', '${category}')"><span class="material-symbols-outlined" style="font-size:16px;">assignment_late</span></button>`;
            }
        }

        const naesinBadge = naesinIds.has(s.docId) ? '<span class="tag-naesin">내신</span>' : '';
        return `<div class="list-item ${isActive}${state.bulkMode ? ' bulk-mode' : ''}${state.selectedStudentIds.has(s.docId) ? ' bulk-selected' : ''}" data-id="${escAttr(s.docId)}" onclick="handleListItemClick(event, '${escAttr(s.docId)}')">
            <input type="checkbox" class="list-item-checkbox" ${state.selectedStudentIds.has(s.docId) ? 'checked' : ''} onclick="event.stopPropagation(); toggleStudentCheckbox('${escAttr(s.docId)}', this.checked)">
            <div class="item-info">
                <span class="item-title">${esc(s.name)}${newBadge}${naesinBadge}${leaveBadge}${lrPendingTags}${siblingIcon}${hwFailIconHtml}${overrideBadge}${overrideInBadge} ${teacherBadge}</span>
                <span class="item-desc">${esc(code)}${studentShortLabel(s) ? ' · ' + esc(studentShortLabel(s)) : ''}</span>
            </div>
            ${timeHtml}
            <div class="item-actions">${toggleHtml}</div>
            ${followUpBtnHtml}
        </div>`;
    };

    // 검색 시 현재학기(오늘/다른요일) 분리
    let todayStudents, otherDayStudents;
    if (state.searchQuery) {
        const dayN = getDayName(state.selectedDate);
        // 내신 기간 학생도 포함: getActiveEnrollments가 정규를 숨기므로 naesin.js의 목록도 확인
        todayStudents = students.filter(s =>
            naesinIds.has(s.docId) ||
            getActiveEnrollments(s, state.selectedDate).some(e => e.day.includes(dayN))
        );
        const todayIds = new Set(todayStudents.map(s => s.docId));
        otherDayStudents = students.filter(s => !todayIds.has(s.docId));
    } else {
        todayStudents = students;
        otherDayStudents = [];
    }

    // 휴원 학생 분리 (오늘 수업 학생 기준)
    const activeStudents = todayStudents.filter(s => !LEAVE_STATUSES.includes(s.status));
    const leaveStudents = todayStudents.filter(s => LEAVE_STATUSES.includes(s.status));

    // 정규/비정규 분리 조건: attendance 카테고리이고 출석/지각/결석/기타 서브필터 활성 시
    const shouldSplitRegular = !state.searchQuery && state.currentCategory === 'attendance' &&
        state.currentSubFilter.size > 0 &&
        !state.currentSubFilter.has('all') &&
        !state.currentSubFilter.has('pre_arrival') &&
        !state.currentSubFilter.has('enroll_pending') &&
        !state.currentSubFilter.has('scheduled_visit') &&
        !state.currentSubFilter.has('departure_check') &&
        !state.currentSubFilter.has('teukang') &&
        !SV_L3_KEYS.some(k => state.currentSubFilter.has(k));

    // 정규/특강 분리: 특강 전용 학생은 정규 탭에서 제외 (특강 탭에서만 표시)
    let regularActive;
    if (shouldSplitRegular) {
        regularActive = activeStudents.filter(s => hasRegularEnrollmentToday(s));
    } else {
        regularActive = activeStudents;
    }

    const appendIrregularAndLeave = (html) => {
        if (leaveStudents.length > 0) {
            html += `<div class="leave-section-divider"><span>휴원 학생 (${leaveStudents.length}명)</span></div>`;
            html += leaveStudents.map(renderItemHtml).join('');
        }
        return html;
    };

    // 정규(pre_arrival) L2 선택 시 등원예정 섹션 상단 삽입
    const enrollPendingHtml = (state.currentCategory === 'attendance' && state.currentSubFilter.has('pre_arrival'))
        ? renderEnrollPendingSection() : '';

    // 그룹 뷰 or 일반 렌더링
    if (state.groupViewMode !== 'none' && !state.searchQuery) {
        const groups = {};
        regularActive.forEach(s => {
            if (state.groupViewMode === 'branch') {
                const key = branchFromStudent(s) || '미지정';
                if (!groups[key]) groups[key] = [];
                groups[key].push(s);
            } else {
                const codes = allClassCodes(s);
                const key = codes.length ? codes[0] : '미지정';
                if (!groups[key]) groups[key] = [];
                groups[key].push(s);
            }
        });
        const sortedKeys = Object.keys(groups).sort((a, b) => a.localeCompare(b, 'ko'));
        let html = enrollPendingHtml + sortedKeys.map(key => {
            const headerHtml = `<div class="group-header"><span class="group-label">${esc(key)}</span><span class="group-count">${groups[key].length}명</span></div>`;
            return headerHtml + groups[key].map(renderItemHtml).join('');
        }).join('');
        container.innerHTML = appendIrregularAndLeave(html);
    } else {
        let html = enrollPendingHtml + regularActive.map(renderItemHtml).join('');
        container.innerHTML = appendIrregularAndLeave(html);
    }

    // 다른 요일 학생 표시 (검색 시)
    if (otherDayStudents.length > 0) {
        let otherHtml = `<div class="leave-section-divider"><span>다른 요일 (${otherDayStudents.length}명)</span></div>`;
        otherHtml += otherDayStudents.map(renderItemHtml).join('');
        container.insertAdjacentHTML('beforeend', otherHtml);
    }

    // 과거 학생은 _searchContactsDSC에서 비동기로 렌더링 (위에서 호출됨)

    // 반 상세 표시: 반(+소속)만 선택되고, 콘텐츠 서브필터 없을 때
    // 내신/특강 반 설정 모드에서는 항상 반 상세 표시
    if (((state._classMgmtMode === 'naesin' && _isNaesinClassCode(state.selectedClassCode)) ||
         state._classMgmtMode === 'teukang') && state.selectedClassCode && !state.selectedStudentId) {
        renderClassDetail(state.selectedClassCode);
    } else {
        const allFilters = { ...state.savedSubFilters };
        allFilters[state.currentCategory] = new Set(state.currentSubFilter);
        const hasContentFilter = ['attendance', 'homework', 'test', 'automation', 'admin'].some(cat => allFilters[cat]?.size > 0);
        if (state.selectedClassCode && !state.selectedStudentId && !hasContentFilter) {
            renderClassDetail(state.selectedClassCode);
        }
    }
}


// _stripYear, _fmtTs, _isNoShow, _renderRescheduleHistory → imported from ui-utils.js

// ─── 밀린 Task 재지정 → reschedule-modal.js로 분리됨 ────────────────────────

// ─── Test Fail Action → test-management.js로 분리됨 ────────────────────────

// getStudentChecklistStatus, renderChecklistCard, confirmDeparture → student-detail.js로 분리됨
window.confirmDeparture = confirmDeparture;

// renderTempAttendanceDetail, deleteTempAttendance → imported from diagnostic.js

// ─── Student Detail Panel ───────────────────────────────────────────────────

// buildStayStatsHtml, switchDetailTab, loadReportCard, renderReportCard,
// renderTempClassOverrideCard → student-detail.js로 분리됨
window.switchDetailTab = switchDetailTab;
window.loadReportCard = loadReportCard;

// renderReturnConsultCard, _renderLRRow, renderLeaveRequestCard → imported from leave-request.js

// 특정 날짜의 요일에 수업이 있는 반 코드 목록 (학생 본인의 반 제외)
function getClassCodesForDate(dateStr, excludeStudentId) {
    const dayName = getDayName(dateStr);
    const codes = new Set();
    state.allStudents.forEach(s => {
        if (s.status === '퇴원') return;
        if (!matchesBranchFilter(s)) return;
        getActiveEnrollments(s, dateStr).forEach(e => {
            if (!e.day.includes(dayName)) return;
            const code = enrollmentCode(e);
            if (code) codes.add(code);
        });
    });
    if (excludeStudentId) {
        const student = state.allStudents.find(s => s.docId === excludeStudentId);
        if (student) {
            getActiveEnrollments(student, dateStr).forEach(e => {
                codes.delete(enrollmentCode(e));
            });
        }
    }
    return [...codes].sort();
}

window.openTempClassOverrideModal = function(studentId) {
    const student = state.allStudents.find(s => s.docId === studentId);
    if (!student) return;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    overlay.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h3>타반수업 추가 — ${esc(student.name)}</h3>
                <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">
                    <span class="material-symbols-outlined">close</span>
                </button>
            </div>
            <div class="modal-body">
                <div class="form-field">
                    <label class="field-label">날짜</label>
                    <input type="date" class="field-input" id="ovr-date" value="${state.selectedDate}">
                    <div style="font-size:11px;color:var(--text-sec);margin-top:4px;">여러 날짜는 추가 후 반복 등록하세요</div>
                </div>
                <div class="form-field">
                    <label class="field-label">대상 반 <span id="ovr-day-label" style="color:var(--text-sec);font-weight:normal;">(${getDayName(state.selectedDate)}요일)</span></label>
                    <select class="field-input" id="ovr-target-class"></select>
                    <div id="ovr-no-class" style="font-size:11px;color:var(--warning);margin-top:4px;display:none;">선택한 날짜에 수업이 있는 반이 없습니다.</div>
                </div>
                <div class="form-field">
                    <label class="field-label">사유 (선택)</label>
                    <input type="text" class="field-input" id="ovr-reason" placeholder="사유 입력">
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">취소</button>
                <button class="btn btn-primary" id="ovr-submit-btn" onclick="submitTempClassOverrideFromModal('${escAttr(studentId)}')">등록</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    function updateClassOptions() {
        const dateVal = document.getElementById('ovr-date')?.value;
        if (!dateVal) return;
        const codes = getClassCodesForDate(dateVal, studentId);
        const sel = document.getElementById('ovr-target-class');
        const noMsg = document.getElementById('ovr-no-class');
        const dayLabel = document.getElementById('ovr-day-label');
        const submitBtn = document.getElementById('ovr-submit-btn');
        if (dayLabel) dayLabel.textContent = `(${getDayName(dateVal)}요일)`;
        sel.innerHTML = codes.map(c => `<option value="${escAttr(c)}">${esc(c)}</option>`).join('');
        if (codes.length === 0) {
            noMsg.style.display = '';
            submitBtn.disabled = true;
            submitBtn.style.opacity = '0.5';
        } else {
            noMsg.style.display = 'none';
            submitBtn.disabled = false;
            submitBtn.style.opacity = '';
        }
    }

    document.getElementById('ovr-date').addEventListener('change', updateClassOptions);
    updateClassOptions();
};

window.submitTempClassOverrideFromModal = async function(studentId) {
    const targetClass = document.getElementById('ovr-target-class')?.value;
    const dateVal = document.getElementById('ovr-date')?.value;
    const reason = document.getElementById('ovr-reason')?.value || '';
    if (!targetClass || !dateVal) { alert('대상 반과 날짜를 선택해주세요.'); return; }
    document.querySelector('.modal-overlay')?.remove();
    await window.createTempClassOverride(studentId, targetClass, [dateVal], reason);
};

// renderStudentDetail, renderClinicInputs, saveExtraVisit, addExtraVisit,
// clearExtraVisit, _lastRenderedStudentId, _pendingClinicStudentId
// → student-detail.js로 분리됨 (state._pendingClinicStudentId 사용)


// cycleTempArrival, cycleVisitAttendance, toggleAttendance,
// autoCreateAbsenceRecord, autoRemoveAbsenceRecord, syncAbsenceRecords,
// applyAttendance, doesStatusMatchFilter, isNewStudent, isAttendedStatus,
// checkCanEditGrading, _isVisitAttended, handleAttendanceChange
// → imported from attendance.js

window.cycleTempArrival = cycleTempArrival;


// updateDateDisplay, reloadForDate, changeDate, openDatePicker, goToday → imported from data-layer.js

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('date-picker')?.addEventListener('change', (e) => {
        if (e.target.value) {
            state.selectedDate = e.target.value;
            reloadForDate();
        }
    });
    initHelpGuide();

    // 탭 복귀 시 자동 데이터 갱신 (5분 이상 비활성 후 돌아오면)
    let lastActiveTime = Date.now();
    const AUTO_RELOAD_THRESHOLD = 5 * 60 * 1000; // 5분

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            lastActiveTime = Date.now();
        } else if (state.currentUser && Date.now() - lastActiveTime >= AUTO_RELOAD_THRESHOLD) {
            reloadForDate();
            showToast('데이터를 자동 갱신했습니다');
        }
    });
});

// ─── Retake actions ─────────────────────────────────────────────────────────

async function completeRetake(retakeDocId) {
    if (!confirm('이 일정을 완료 처리하시겠습니까?')) return;
    showSaveIndicator('saving');
    try {
        const completedBy = (state.currentUser?.email || '').split('@')[0];
        await auditUpdate(doc(db, 'retake_schedule', retakeDocId), {
            status: '완료',
            completed_by: completedBy,
            completed_at: new Date().toISOString()
        });
        const r = state.retakeSchedules.find(r => r.docId === retakeDocId);
        if (r) { r.status = '완료'; r.completed_by = completedBy; }
        renderSubFilters();
        if (state.selectedStudentId) renderStudentDetail(state.selectedStudentId);
        showSaveIndicator('saved');
    } catch (err) {
        console.error('완료 처리 실패:', err);
        showSaveIndicator('error');
    }
}

async function cancelRetake(retakeDocId) {
    if (!confirm('이 일정을 취소하시겠습니까?')) return;
    showSaveIndicator('saving');
    try {
        const cancelledBy = (state.currentUser?.email || '').split('@')[0];
        await auditUpdate(doc(db, 'retake_schedule', retakeDocId), {
            status: '취소',
            cancelled_by: cancelledBy,
            cancelled_at: new Date().toISOString()
        });
        const r = state.retakeSchedules.find(r => r.docId === retakeDocId);
        if (r) { r.status = '취소'; r.cancelled_by = cancelledBy; }
        renderSubFilters();
        if (state.selectedStudentId) renderStudentDetail(state.selectedStudentId);
        showSaveIndicator('saved');
    } catch (err) {
        console.error('취소 처리 실패:', err);
        showSaveIndicator('error');
    }
}

// ─── Modal helpers ──────────────────────────────────────────────────────────

function closeModal(id, event) {
    if (!event || event.target === event.currentTarget) {
        document.getElementById(id).style.display = 'none';
    }
}

// 휴퇴원요청서 모달 로직 → imported from leave-request.js

let _scheduleTargetIds = [];

function openScheduleModal(studentIds) {
    _scheduleTargetIds = studentIds;
    // 기본값 설정
    const d = parseDateKST(state.selectedDate);
    d.setDate(d.getDate() + 1);
    const nextDay = toDateStrKST(d);

    document.getElementById('schedule-type').value = '재시';
    document.getElementById('schedule-subject').value = '';
    document.getElementById('schedule-title').value = '';
    document.getElementById('schedule-date').value = nextDay;
    document.getElementById('schedule-modal').style.display = 'flex';
}

function openHomeworkModal(studentId) {
    if (!checkCanEditGrading(studentId)) return;
    state.selectedStudentId = studentId;
    const domains = getStudentDomains(studentId);
    const select = document.getElementById('hw-subject');
    select.innerHTML = domains.map(d =>
        `<option value="${esc(d)}">${esc(d)}</option>`
    ).join('') + '<option value="기타">기타</option>';
    document.getElementById('hw-title').value = '';
    document.getElementById('hw-status').value = '미제출';
    document.getElementById('homework-modal').style.display = 'flex';
}

function openTestModal(studentId) {
    if (!checkCanEditGrading(studentId)) return;
    state.selectedStudentId = studentId;
    const domains = getStudentDomains(studentId);
    const select = document.getElementById('test-subject');
    select.innerHTML = domains.map(d =>
        `<option value="${esc(d)}">${esc(d)}</option>`
    ).join('') + '<option value="기타">기타</option>';
    document.getElementById('test-title').value = '';
    document.getElementById('test-type').value = '정기';
    document.getElementById('test-score').value = '';
    document.getElementById('test-pass-score').value = '80';
    document.getElementById('test-modal').style.display = 'flex';
}

// ─── Modal save functions ───────────────────────────────────────────────────

async function saveScheduleFromModal() {
    const type = document.getElementById('schedule-type').value;
    const subject = document.getElementById('schedule-subject').value.trim();
    const title = document.getElementById('schedule-title').value.trim();
    const scheduledDate = document.getElementById('schedule-date').value;

    if (!title) { alert('제목을 입력하세요.'); return; }
    if (!scheduledDate) { alert('날짜를 선택하세요.'); return; }

    showSaveIndicator('saving');
    try {
        await Promise.all(_scheduleTargetIds.map(studentId =>
            saveRetakeSchedule({
                student_id: studentId,
                type,
                subject,
                title,
                original_date: state.selectedDate,
                scheduled_date: scheduledDate,
                status: '예정',
                result_score: null
            })
        ));
        document.getElementById('schedule-modal').style.display = 'none';
        _scheduleTargetIds = [];
        renderSubFilters();
        if (state.selectedStudentId) renderStudentDetail(state.selectedStudentId);
        showSaveIndicator('saved');
    } catch (err) {
        console.error('일정 저장 실패:', err);
        showSaveIndicator('error');
    }
}

async function saveHomeworkFromModal() {
    const title = document.getElementById('hw-title').value.trim();
    const subject = document.getElementById('hw-subject').value;
    const status = document.getElementById('hw-status').value;

    if (!title) { alert('숙제 제목을 입력하세요.'); return; }
    if (!state.selectedStudentId) return;

    const rec = state.dailyRecords[state.selectedStudentId] || {};
    const homework = [...(rec.homework || []), { title, subject, status, note: '' }];

    saveDailyRecord(state.selectedStudentId, { homework });

    if (!state.dailyRecords[state.selectedStudentId]) {
        state.dailyRecords[state.selectedStudentId] = { student_id: state.selectedStudentId, date: state.selectedDate };
    }
    state.dailyRecords[state.selectedStudentId].homework = homework;

    document.getElementById('homework-modal').style.display = 'none';
    renderStudentDetail(state.selectedStudentId);
}

async function saveTestFromModal() {
    const title = document.getElementById('test-title').value.trim();
    const subject = document.getElementById('test-subject').value;
    const type = document.getElementById('test-type').value;
    const score = document.getElementById('test-score').value ? Number(document.getElementById('test-score').value) : null;
    const passScore = document.getElementById('test-pass-score').value ? Number(document.getElementById('test-pass-score').value) : null;

    if (!title) { alert('테스트명을 입력하세요.'); return; }
    if (!state.selectedStudentId) return;

    let result = '미완료';
    if (score != null && passScore != null) {
        result = score >= passScore ? '통과' : '재시필요';
    }

    const rec = state.dailyRecords[state.selectedStudentId] || {};
    const tests = [...(rec.tests || []), { title, subject, type, score, pass_score: passScore, result, note: '' }];

    saveDailyRecord(state.selectedStudentId, { tests });

    if (!state.dailyRecords[state.selectedStudentId]) {
        state.dailyRecords[state.selectedStudentId] = { student_id: state.selectedStudentId, date: state.selectedDate };
    }
    state.dailyRecords[state.selectedStudentId].tests = tests;

    document.getElementById('test-modal').style.display = 'none';
    renderStudentDetail(state.selectedStudentId);
}

// ─── 등원예정시간 (학생 상세 패널에서 사용, students 컬렉션에 영구 저장) ──────

async function saveStudentScheduledTime(studentId, classCode, time) {
    const student = state.allStudents.find(s => s.docId === studentId);
    if (!student) return;

    const dayName = getDayName(state.selectedDate);
    const enrollments = [...student.enrollments];
    const idx = enrollments.findIndex(e => e.day.includes(dayName) && enrollmentCode(e) === classCode);
    if (idx === -1) return;

    // 반 기본시간과 동일하거나 빈값이면 개별시간 제거 (fallback 사용)
    const classDefault = state.classSettings[classCode]?.default_time || '';
    if (!time || time === classDefault) {
        const { start_time, ...rest } = enrollments[idx];
        enrollments[idx] = rest;
    } else {
        enrollments[idx] = { ...enrollments[idx], start_time: time };
    }

    showSaveIndicator('saving');
    try {
        await auditUpdate(doc(db, 'students', studentId), { enrollments });
        student.enrollments = enrollments;
        showSaveIndicator('saved');
        renderStudentDetail(studentId);
    } catch (err) {
        console.error('등원예정시간 저장 실패:', err);
        showSaveIndicator('error');
    }
}

// ─── 롤/메모 → role-memo.js로 분리됨 ──────────────────────────────────────

// ─── Enrollment 편집 ─────────────────────────────────────────────────────────
let editingEnrollment = { studentId: null, enrollIdx: 0 };

function openEnrollmentModal(studentId, enrollIdx) {
    const student = findStudent(studentId);
    if (!student) return;

    editingEnrollment = { studentId, enrollIdx };
    const enroll = student.enrollments[enrollIdx] || {};

    document.getElementById('enroll-student-name').textContent = student.name || '';
    document.getElementById('enroll-level').value = enroll.level_symbol || '';
    document.getElementById('enroll-class-num').value = enroll.class_number || '';
    document.getElementById('enroll-class-type').value = enroll.class_type || '정규';
    document.getElementById('enroll-time').value = enroll.start_time || enroll.time || '';
    document.getElementById('enroll-start-date').value = enroll.start_date || '';
    document.getElementById('enroll-end-date').value = enroll.end_date || '';

    // 요일 버튼 초기화
    const days = enroll.day || [];
    document.querySelectorAll('#enroll-days .day-btn').forEach(btn => {
        btn.classList.toggle('active', days.includes(btn.dataset.day));
    });

    document.getElementById('enrollment-modal').style.display = 'flex';
}

async function saveEnrollment() {
    const { studentId, enrollIdx } = editingEnrollment;
    const student = findStudent(studentId);
    if (!student) return;

    const levelSymbol = document.getElementById('enroll-level').value.trim();
    const classNumber = document.getElementById('enroll-class-num').value.trim();
    const classType = document.getElementById('enroll-class-type').value;
    const startTime = document.getElementById('enroll-time').value;
    const startDate = document.getElementById('enroll-start-date').value;
    const endDate = document.getElementById('enroll-end-date').value;

    // 선택된 요일 수집
    const selectedDays = [];
    document.querySelectorAll('#enroll-days .day-btn.active').forEach(btn => {
        selectedDays.push(btn.dataset.day);
    });

    // enrollments 배열 업데이트
    const enrollments = [...student.enrollments];
    const newCode = `${levelSymbol}${classNumber}`;
    const newSemester = enrollments[enrollIdx]?.semester || '';

    // 중복 반코드 체크 (같은 학기+수업종류+요일 내 다른 enrollment에 동일 코드가 있는지)
    const isDuplicate = enrollments.some((e, i) => {
        if (i === enrollIdx) return false;
        if (enrollmentCode(e) !== newCode) return false;
        if ((e.semester || '') !== newSemester) return false;
        if ((e.class_type || '정규') !== classType) return false;
        // 요일이 겹치는지 확인
        const existingDays = e.day || [];
        return selectedDays.some(d => existingDays.includes(d));
    });
    if (isDuplicate) {
        alert(`같은 반(${newCode}, ${classType})에 겹치는 요일이 있습니다.`);
        return;
    }

    const updated = {
        ...enrollments[enrollIdx],
        level_symbol: levelSymbol,
        class_number: classNumber,
        class_type: classType,
        day: selectedDays,
        start_time: startTime
    };
    if (startDate) updated.start_date = startDate;
    else delete updated.start_date;
    if (endDate) updated.end_date = endDate;
    else delete updated.end_date;

    enrollments[enrollIdx] = updated;

    showSaveIndicator('saving');
    try {
        await auditUpdate(doc(db, 'students', studentId), { enrollments });

        // 로컬 캐시 업데이트
        student.enrollments = enrollments;

        document.getElementById('enrollment-modal').style.display = 'none';
        renderSubFilters();
        renderListPanel();
        if (state.selectedStudentId === studentId) renderStudentDetail(studentId);
        showSaveIndicator('saved');
    } catch (err) {
        console.error('수강 정보 저장 실패:', err);
        showSaveIndicator('error');
    }
}

// ─── Sidebar toggle (mobile) ────────────────────────────────────────────────

window.toggleSidebar = () => {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');

    if (window.innerWidth <= 768) {
        sidebar.classList.toggle('mobile-open');
        overlay.classList.toggle('visible');
    } else {
        sidebar.classList.toggle('hidden');
    }
};

window.closeSidebar = () => {
    document.getElementById('sidebar').classList.remove('mobile-open');
    document.getElementById('sidebar-overlay').classList.remove('visible');
};

window.closeDetail = () => {
    document.getElementById('detail-panel').classList.remove('mobile-visible');
    state.selectedStudentId = null;
    renderListPanel();
};

// ─── Auth ───────────────────────────────────────────────────────────────────

onAuthStateChanged(auth, async (user) => {
    if (user) {
        const email = user.email || '';
        const allowed = email.endsWith('@gw.impact7.kr') || email.endsWith('@impact7.kr');
        if (!user.emailVerified || !allowed) {
            alert('허용되지 않은 계정입니다.\n학원 계정(@gw.impact7.kr 또는 @impact7.kr)으로 다시 로그인해주세요.');
            await logout();
            return;
        }

        state.currentUser = user;
        window._auditUser = user.email || null;
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('main-screen').style.display = '';
        document.getElementById('user-email').textContent = user.email;
        document.getElementById('user-avatar').textContent = (user.email || 'U')[0].toUpperCase();

        // 날짜/UI는 데이터 로드 실패와 무관하게 반드시 표시
        updateDateDisplay();

        try {
            await loadStudents();
            await promoteEnrollPending();
            await loadWithdrawnStudents();
            buildSiblingMap();
            await trackTeacherLogin(user);
            await Promise.allSettled([loadDailyRecords(state.selectedDate), loadRetakeSchedules(), loadHwFailTasks(), loadTestFailTasks(), loadTempAttendances(state.selectedDate), loadTempClassOverrides(state.selectedDate), loadAbsenceRecords(), loadLeaveRequests(), loadUserRole(), loadClassSettings(), loadClassNextHw(state.selectedDate), loadTeachers()]);
            await syncAbsenceRecords();
            await loadRoleMemos().catch(() => {});
        } catch (err) {
            console.error('[init] 데이터 로드 중 오류:', err);
        }
        // 백그라운드 후처리 (실패해도 앱 동작에 영향 없음)
        autoCloseOldRecords().catch(e => console.warn('[autoClose]', e));
        syncTaskStudentNames().catch(e => console.warn('[syncNames]', e));
        updateDateDisplay();
            renderBranchFilter();
        renderSubFilters();
        updateL1ExpandIcons();
        renderListPanel();

        // Restore group view button state
        if (state.groupViewMode !== 'none') {
            const btn = document.getElementById('group-view-btn');
            const labels = { none: 'view_agenda', branch: 'location_city', class: 'school' };
            const titles = { none: '그룹 뷰 (소속별)', branch: '그룹 뷰: 소속별 → 반별로 전환', class: '그룹 뷰: 반별 → 해제' };
            if (btn) {
                btn.querySelector('.material-symbols-outlined').textContent = labels[state.groupViewMode];
                btn.title = titles[state.groupViewMode];
                btn.classList.add('active');
            }
        }
    } else {
        state.currentUser = null;
        window._auditUser = null;
        document.getElementById('login-screen').style.display = '';
        document.getElementById('main-screen').style.display = 'none';
    }
});

// ─── Keyboard shortcut: ESC closes modals ───────────────────────────────────
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        ['schedule-modal', 'homework-modal', 'test-modal', 'enrollment-modal', 'memo-modal', 'next-hw-modal', 'parent-msg-modal', 'temp-attendance-modal', 'bulk-confirm-modal', 'bulk-memo-modal', 'bulk-notify-modal', 'leave-request-modal'].forEach(id => {
            const modal = document.getElementById(id);
            if (modal?.style.display !== 'none') {
                modal.style.display = 'none';
            }
        });
    }
});

// loadPickerApi, pickDriveFolder, exportDailyReport
// → imported from export-report.js

// ─── Window global exposure ─────────────────────────────────────────────────

window.handleLogin = async () => {
    try {
        if (state.currentUser) await logout();
        else await signInWithGoogle();
    } catch (error) {
        const messages = {
            'auth/popup-blocked': '팝업이 차단됨 — 브라우저에서 팝업을 허용해주세요',
            'auth/popup-closed-by-user': '팝업이 닫혔습니다.',
            'auth/cancelled-popup-request': '이미 로그인 팝업이 열려 있습니다.',
        };
        alert(messages[error.code] || `로그인 실패: ${error.code}`);
    }
};

let _searchTimer = null;
window.handleSearch = (value) => {
    state.searchQuery = value;
    const clearBtn = document.getElementById('search-clear');
    if (clearBtn) clearBtn.style.display = value ? 'flex' : 'none';
    if (_searchTimer) clearTimeout(_searchTimer);
    _searchTimer = setTimeout(() => renderListPanel(), 150);
};
window.clearSearch = () => {
    state.searchQuery = '';
    const input = document.getElementById('search-input');
    if (input) input.value = '';
    const clearBtn = document.getElementById('search-clear');
    if (clearBtn) clearBtn.style.display = 'none';
    renderListPanel();
};

// enterBulkMode, exitBulkMode, updateBulkBar, renderBulkSummary,
// openBulkAttendanceFromSummary, openBulkOXFromSummary,
// toggleSelectAll, toggleStudentCheckbox, openBulkModal, confirmBulkAction,
// resetBulkModal, cancelBulkAction, handleListItemClick, toggleGroupView,
// openBulkMemo, saveBulkMemo, openBulkNotify, saveBulkNotify
// → imported from bulk-mode.js

window.toggleBulkMode = () => { if (state.bulkMode) exitBulkMode(); else enterBulkMode(); };
window.exitBulkMode = exitBulkMode;
window.openBulkAttendanceFromSummary = openBulkAttendanceFromSummary;
window.openBulkOXFromSummary = openBulkOXFromSummary;
window.pickBulkDomain = pickBulkDomain;
window.toggleSelectAll = toggleSelectAll;
window.toggleStudentCheckbox = toggleStudentCheckbox;
window.toggleGroupView = toggleGroupView;
window.selectBulkValue = selectBulkValue;
window.resetBulkModal = resetBulkModal;
window.confirmBulkAction = confirmBulkAction;
window.cancelBulkAction = cancelBulkAction;
window.handleListItemClick = handleListItemClick;

window.changeDate = changeDate;
window.openDatePicker = openDatePicker;
window.goToday = goToday;
window.setCategory = setCategory;
if (import.meta.env?.DEV) { window._debug = { get absenceRecords() { return state.absenceRecords; }, get dailyRecords() { return state.dailyRecords; }, get selectedDate() { return state.selectedDate; }, set selectedDate(v) { state.selectedDate = v; }, get allStudents() { return state.allStudents; } }; }
window.setSubFilter = setSubFilter;
window.setBranch = setBranch;
window.setBranchLevel = setBranchLevel;
window.toggleAttendance = toggleAttendance;
window.cycleVisitAttendance = cycleVisitAttendance;
window.toggleHomework = toggleHomework;
window.toggleHwDomainOX = toggleHwDomainOX;
window.setClassCode = setClassCode;
window.closeSidebar = closeSidebar;
window.closeDetail = closeDetail;
window.renderStudentDetail = renderStudentDetail;

window.refreshData = async () => {
    showSaveIndicator('saving');
    await loadStudents();
    await promoteEnrollPending();
    await loadWithdrawnStudents();
    await Promise.allSettled([loadDailyRecords(state.selectedDate), loadRetakeSchedules(), loadHwFailTasks(), loadTestFailTasks(), loadTempAttendances(state.selectedDate), loadTempClassOverrides(state.selectedDate), loadAbsenceRecords(), loadLeaveRequests(), loadRoleMemos(), loadClassSettings(true), loadClassNextHw(state.selectedDate), loadTeachers()]);
    await syncAbsenceRecords();
    renderBranchFilter();
    renderSubFilters();
    renderListPanel();
    if (state.selectedStudentId) renderStudentDetail(state.selectedStudentId);
    showSaveIndicator('saved');
};

window.selectStudent = selectStudent;

window.openFollowUpAction = (studentId, category) => {
    selectStudent(studentId);
    requestAnimationFrame(() => {
        const cards = document.querySelectorAll('.hw-fail-card');
        const card = category === 'test' ? (cards[1] || cards[0]) : cards[0];
        if (card) {
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            card.classList.add('highlight-pulse');
            setTimeout(() => card.classList.remove('highlight-pulse'), 2000);
        }
    });
};

window.closeModal = closeModal;
window.saveSchedule = saveScheduleFromModal;
window.saveHomework = saveHomeworkFromModal;
window.saveTest = saveTestFromModal;
window.saveDailyRecord = saveDailyRecord;
window.saveDetailNote = async function(studentId) {
    const ta = document.getElementById(`detail-note-${studentId}`);
    if (!ta) return;
    await saveDailyRecord(studentId, { note: ta.value });
};
// saveStudentMemoArray, addStudentMemo, deleteStudentMemo, toggleStudentMemoPin → role-memo.js로 분리됨
window.handleAttendanceChange = handleAttendanceChange;
window.openScheduleModal = openScheduleModal;
window.openHomeworkModal = openHomeworkModal;
window.openTestModal = openTestModal;
window.completeRetake = completeRetake;
window.cancelRetake = cancelRetake;
window.openEnrollmentModal = openEnrollmentModal;
window.saveEnrollment = saveEnrollment;
window.saveStudentScheduledTime = saveStudentScheduledTime;
window.selectNextHwClass = selectNextHwClass;
window.openNextHwModal = openNextHwModal;
window.saveNextHwFromModal = saveNextHwFromModal;
window.saveNextHwNone = saveNextHwNone;
window.openPersonalNextHwModal = openPersonalNextHwModal;
window.saveExtraVisit = saveExtraVisit;
window.addExtraVisit = addExtraVisit;
window.clearExtraVisit = clearExtraVisit;
window.renderClinicInputs = renderClinicInputs;
window.addClassDomain = addClassDomain;
window.removeClassDomain = removeClassDomain;
window.resetClassDomains = resetClassDomains;
window.addTestToSection = addTestToSection;
window.removeTestFromSection = removeTestFromSection;
window.addTestSection = addTestSection;
window.removeTestSection = removeTestSection;
window.resetTestSections = resetTestSections;
window.resetTestSection = resetTestSection;
window.saveClassDefaultTime = saveClassDefaultTime;

// 롤/메모 관련 → role-memo.js에서 import
initRoleMemoDeps({ renderStudentDetail });
window.selectRole = selectRole;
window.toggleMemoSection = toggleMemoSection;
window.toggleMemoPanel = toggleMemoPanel;
window.setMemoTab = setMemoTab;
window.openMemoModal = openMemoModal;
window.sendMemo = sendMemo;
window.toggleMemoStudentField = toggleMemoStudentField;
window.searchMemoStudent = searchMemoStudent;
window.selectMemoStudent = selectMemoStudent;
window.markMemoRead = markMemoRead;
window.expandMemo = expandMemo;
window.toggleMemoPin = toggleMemoPin;
window.addStudentMemo = addStudentMemo;
window.deleteStudentMemo = deleteStudentMemo;
window.toggleStudentMemoPin = toggleStudentMemoPin;

// 휴퇴원요청서 window 할당 → 위쪽 initLeaveRequestDeps 블록으로 이동 완료

// openParentMessageModal, regenerateParentMessage, copyParentMessage,
// switchParentMsgTab, togglePromptEditor, saveCustomPrompt, resetPromptToDefault
// → imported from parent-message.js

// completeScheduledVisit, resetScheduledVisit, cycleVisitStatus, confirmVisitStatus,
// rescheduleVisit, _showDiagnosticActionModal, toggleDiagnosticReschedule,
// saveDiagnosticReschedule, confirmDiagnosticCancel → imported from scheduled-visits.js

window.rescheduleVisit = rescheduleVisit;
window._showDiagnosticActionModal = _showDiagnosticActionModal;
window.completeScheduledVisit = completeScheduledVisit;
window.resetScheduledVisit = resetScheduledVisit;
window.cycleVisitStatus = cycleVisitStatus;
window.confirmVisitStatus = confirmVisitStatus;
window.toggleDiagnosticReschedule = toggleDiagnosticReschedule;
window.saveDiagnosticReschedule = saveDiagnosticReschedule;
window.confirmDiagnosticCancel = confirmDiagnosticCancel;

// _searchContactsDSC, _renderPastContacts → imported from past-search.js

// _makeContactDocId, _tryTempContactAutofill, openTempAttendanceModal,
// _upsertStudentFromTemp, saveTempAttendance, openTempAttendanceForEdit,
// renderTempEditHistory, openContactAsTemp → imported from diagnostic.js
// openBulkMemo, saveBulkMemo, openBulkNotify, saveBulkNotify → imported from bulk-mode.js
window.openBulkMemo = openBulkMemo;
window.saveBulkMemo = saveBulkMemo;
window.openBulkNotify = openBulkNotify;
window.saveBulkNotify = saveBulkNotify;

// 내신 반코드 판별: 유도된 내신 코드(한글 포함)인지 확인
function _isNaesinClassCode(code) {
    if (!code) return false;
    return /[가-힣]/.test(code);
}
window._isNaesinClassCode = _isNaesinClassCode;

// ─── 내신 모듈용 state 접근자 ─────────────────────────────────────────────────
Object.defineProperties(window, {
    _naesinState: {
        get() {
            return {
                get allStudents() { return state.allStudents; },
                get selectedDate() { return state.selectedDate; },
                get selectedBranch() { return state.selectedBranch; },
                get classSettings() { return state.classSettings; },
                get dailyRecords() { return state.dailyRecords; },
                get currentUser() { return state.currentUser; },
            };
        },
        configurable: true,
    },
    selectedStudentId: {
        get() { return state.selectedStudentId; },
        set(v) { state.selectedStudentId = v; },
        configurable: true,
    },
    selectedClassCode: {
        get() { return state.selectedClassCode; },
        configurable: true,
    },
    _classMgmtMode: {
        get() { return state._classMgmtMode; },
        configurable: true,
    },
});
window.enrollmentCode = enrollmentCode;
window.renderClassDetail = renderClassDetail;
// _pendingClinicStudentId는 state로 이동(state._pendingClinicStudentId).
// naesin.js 등은 window.state._pendingClinicStudentId로 접근.

// 내신 모듈에서 사용하는 유틸 함수/데이터 노출
window._attToggleClass = _attToggleClass;
window.getStudentStartTime = getStudentStartTime;
window.showSaveIndicator = showSaveIndicator;
window.renderFilterChips = renderFilterChips;
window._esc = esc;
window._escAttr = escAttr;
window._formatTime12h = formatTime12h;
window.getTeacherName = getTeacherName;
Object.defineProperty(window, 'state.teachersList', { get() { return state.teachersList; }, configurable: true });

// ─── 일회성 마이그레이션: class_type='내신' enrollment → 정규 변환 ─────────────
// 사용법 (브라우저 콘솔):
//   await window.migrateNaesinEnrollments()         // dry-run (확인만)
//   await window.migrateNaesinEnrollments(true)     // 실제 저장
window.migrateNaesinEnrollments = async function(save = false) {
    const targets = [];
    for (const student of state.allStudents) {
        const enrollments = student.enrollments || [];
        const naesinIdx = enrollments.findIndex(e => e.class_type === '내신');
        if (naesinIdx === -1) continue;

        const hasRegular = enrollments.some(
            (e, i) => i !== naesinIdx && e.class_type !== '내신'
        );
        let newEnrollments;
        if (hasRegular) {
            // 정규가 이미 있으면 내신 enrollment 제거
            newEnrollments = enrollments.filter((_, i) => i !== naesinIdx);
        } else {
            // 정규가 없으면 class_type을 '정규'로 변경, end_date 제거
            newEnrollments = enrollments.map((e, i) => {
                if (i !== naesinIdx) return e;
                const { class_type, end_date, ...rest } = e;
                return { class_type: '정규', ...rest };
            });
        }
        targets.push({ student, newEnrollments });
    }

    console.log(`[migrate] 대상 학생 ${targets.length}명:`);
    targets.forEach(({ student, newEnrollments }) => {
        console.log(`  ${student.name} (${student.docId}): ${JSON.stringify(newEnrollments)}`);
    });

    if (!save) {
        console.log('[migrate] dry-run 완료. 실제 저장하려면 migrateNaesinEnrollments(true) 실행');
        return;
    }

    let ok = 0, fail = 0;
    for (const { student, newEnrollments } of targets) {
        try {
            await auditUpdate(doc(db, 'students', student.docId), { enrollments: newEnrollments });
            student.enrollments = newEnrollments;
            ok++;
        } catch (err) {
            console.error(`  실패: ${student.name}`, err);
            fail++;
        }
    }
    console.log(`[migrate] 완료: 성공 ${ok}명, 실패 ${fail}명`);
    if (ok > 0) renderListPanel();
};

console.log('[DailyOps] App initialized.');
