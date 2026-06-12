import { onAuthStateChanged } from 'firebase/auth';
import {
    collection, getDocs, doc,
    query, where
} from 'firebase/firestore';
import { auth, db, dataAuthReady } from './firebase-config.js';
import { signInWithGoogle, logout, getGoogleAccessToken } from './auth.js';
import { initHelpGuide } from './help-guide.js';
import { todayStr, getDayName, PAST_STUDENT_STATUSES } from './src/shared/firestore-helpers.js';
import { staffLabel } from '@impact7/shared/staff-label';
import { auditUpdate, auditSet, normalizeImpact7Email } from './audit.js';
import {
    state,
    OX_CYCLE, VISIT_STATUS_CYCLE, DEFAULT_DOMAINS, KOREAN_CHAR_RE,
    SV_SOURCE_MAP, SV_L3_KEYS, SOURCE_PRIORITY, SOURCE_SHORT,
    LEAVE_STATUSES, NEW_STUDENT_DAYS, TEMP_FIELD_LABELS, LEVEL_SHORT,
    DAY_ORDER, _subFilterBaseRef
} from './state.js';
import {
    esc, escAttr, decodeHtmlEntities, formatTime12h, renderTime12hOptions, nowTimeStr,
    showSaveIndicator, showToast, nextOXValue, oxDisplayClass,
    _attToggleClass, _toVisitStatus, _visitBtnStyles, _visitLabel,
    _stripYear, _fmtTs, _isNoShow, _renderRescheduleHistory
} from './ui-utils.js';
import {
    normalizeDays, branchFromStudent, matchesBranchFilter,
    enrollmentCode, allClassCodes, activeClassCodes, _enrollCodeList,
    deriveNaesinCode, displayCodeFromCsKey, getActiveEnrollments, getStudentStartTime, isOnLeaveAt, isWithdrawnAt,
    isNaesinActiveToday, isFreeSemesterActiveToday, isActiveNaesinBase, isPauseExpired, pauseExpiredDays,
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
    _getReturnUpcomingStudents,
    renderReturnConsultCard, renderLeaveRequestCard,
    toggleReturnConsult, updateReturnConsultNote,
    openLeaveRequestModal, onLeaveRequestTypeChange, searchLeaveRequestStudent, selectLeaveRequestStudentById,
    submitLeaveRequest, toggleCancelLeaveRequest, cancelScheduledLeave, cancelScheduledWithdrawal, teacherApproveLeaveRequest,
    approveLeaveRequest, cancelLeaveRequest,
    openReEnrollModal, openReturnFromLeaveModal, submitReturnFromLeave,
    retryFinalize
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
    saveTeukangPeriod, saveFreeSemesterPeriod, searchTeukangAddStudent, addStudentToTeukang,
    confirmDeleteClass, deleteClass, CLASS_MODE_LABELS, getClassPeriodInfo,
    autoCleanupClasses
} from './class-detail.js';
import {
    initHwManagementDeps,
    renderHwFailActionCard, saveHwFailAction, selectHwFailType, clearHwFailType, saveHwFailFields,
    renderPendingTasksCard, completeHwFailTask, cancelHwFailTask,
    renderNextHwClassList, selectNextHwClass, openNextHwModal, saveNextHwFromModal, saveNextHwNone,
    openPersonalNextHwModal, savePersonalNextHwFromModal, savePersonalNextHwNone,
    restoreModalHandlers, refreshNextHwViews, renderNextHwClassDetail,
    toggleHomework, oxFieldLabel, toggleHwDomainOX, applyHwDomainOX, handleHomeworkStatusChange,
    reopenHwFailDomain
} from './hw-management.js';
import {
    initTestManagementDeps,
    getClassTestSections, renderTestFailActionCard,
    selectTestFailType, clearTestFailType, saveTestFailFields,
    saveTestFailAction, completeTestFailTask, cancelTestFailTask,
    reopenTestFailDomain
} from './test-management.js';
import {
    initAttendanceDeps,
    cycleTempArrival, cycleVisitAttendance, toggleAttendance,
    autoCreateAbsenceRecord, autoRemoveAbsenceRecord, syncAbsenceRecords,
    applyAttendance, doesStatusMatchFilter, isNewStudent, isAttendedStatus,
    checkCanEditGrading, _isVisitAttended, handleAttendanceChange,
    confirmPauseExpiredOrAbort,
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
    saveClassSettings, loadStudents, promoteEnrollPending, backfillStudentNumbers, promoteWithdrawalDate, promoteScheduledLeave,
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
import {
    getUniqueClassCodes, getClassMgmtCount,
    isInTeukangClass, getTeukangClassStudents, getFreeSemesterClassStudents, getRegularClassStudents,
    _getAllClassCodes, getNaesinStudentsByDerivedCode, _getClassesForBranchLevel,
    _isNaesinClassCode
} from './class-resolver.js';
import {
    initModalsDeps,
    openTempClassOverrideModal, submitTempClassOverrideFromModal,
    closeModal, openScheduleModal, openHomeworkModal, openTestModal,
    saveScheduleFromModal, saveHomeworkFromModal, saveTestFromModal,
    saveStudentScheduledTime, openEnrollmentModal, saveEnrollment
} from './modals.js';
import {
    initListViewDeps,
    renderListPanel,
    hasRegularEnrollmentToday, hasTeukangEnrollmentToday, isVisitStudent
} from './list-view.js';
import {
    initFilterNavDeps,
    setCategory, updateL1ExpandIcons, renderSubFilters, renderBranchFilter, renderClassCodeFilter,
    setClassCode, setBranch, setBranchLevel, setBranchClass,
    renderFilterChips, removeFilterChip, clearAllFilters, setSubFilter,
    toggleClassDeleteMode, toggleClassDeleteSelect, setClassMgmtMode
} from './filter-nav.js';
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
window.cancelScheduledLeave = cancelScheduledLeave;
window.cancelScheduledWithdrawal = cancelScheduledWithdrawal;
window.teacherApproveLeaveRequest = teacherApproveLeaveRequest;
window.approveLeaveRequest = approveLeaveRequest;
window.cancelLeaveRequest = cancelLeaveRequest;
window.openReEnrollModal = openReEnrollModal;
window.openReturnFromLeaveModal = openReturnFromLeaveModal;
window.submitReturnFromLeave = submitReturnFromLeave;
window._retryFinalize = retryFinalize;

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
initClassDetailDeps({ getOverrideStudentsForClass, getOverridingOutFromClass, getClassDomains, getClassTestSections, getTeacherName, saveClassSettings, isInTeukangClass, getTeukangClassStudents, getRegularClassStudents, renderStudentDetail, renderListPanel, _isNaesinClassCode });
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
window.saveFreeSemesterPeriod = saveFreeSemesterPeriod;
window.confirmDeleteClass = confirmDeleteClass;
window.deleteClass = deleteClass;
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
window.reopenHwFailDomain = reopenHwFailDomain;
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
window.reopenTestFailDomain = reopenTestFailDomain;

// attendance.js 의존성 주입
initAttendanceDeps({ renderSubFilters, renderListPanel, renderStudentDetail, openBulkModal });

// data-layer.js 의존성 주입
initDataLayerDeps({ renderSubFilters, renderListPanel, renderStudentDetail, renderClassDetail, getClassTestSections });
initDataLayerDeps2({ loadRoleMemos, syncAbsenceRecords });

// bulk-mode.js 의존성 주입
function selectStudent(id) {
    // 출결 화면에서 휴원 만료 학생을 선택하면 복귀 처리 안내 confirm. 취소 시 선택 중단.
    if (state.currentCategory === 'attendance' && id && !confirmPauseExpiredOrAbort(id)) return;
    state.selectedStudentId = id;
    renderListPanel();
    renderStudentDetail(id);
}
// 비원생 검색 결과 등 외부 모듈에서도 학생 선택 가능하도록 노출.
window.selectStudent = selectStudent;
initBulkModeDeps({ renderSubFilters, renderListPanel, renderStudentDetail, applyAttendance, applyHwDomainOX, isAttendedStatus, oxFieldLabel, selectStudent });

// scheduled-visits.js 의존성 주입
initScheduledVisitsDeps({ renderSubFilters, renderListPanel, renderStudentDetail, _isVisitAttended, getScheduledVisits, openRescheduleModal: (...args) => window.openRescheduleModal(...args), _subFilterBaseRef });

// reschedule-modal.js 의존성 주입 + window 노출
initRescheduleModalDeps({ renderSubFilters, renderListPanel, renderStudentDetail, _subFilterBaseRef });
window.openRescheduleModal = openRescheduleModal;
window.saveReschedule = saveReschedule;

// student-detail.js 의존성 주입
initStudentDetailDeps({ renderSubFilters, renderListPanel, _isNaesinClassCode });

// visit-list-render.js 의존성 주입
initVisitRenderDeps({ getStudentChecklistStatus, renderFilterChips });

// modals.js 의존성 주입
initModalsDeps({ renderSubFilters, renderListPanel });

// list-view.js 의존성 주입
initListViewDeps({ renderFilterChips });

// filter-nav.js 의존성 주입
initFilterNavDeps({ renderListPanel, isVisitStudent, hasRegularEnrollmentToday, hasTeukangEnrollmentToday });

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

// getUniqueClassCodes, getClassMgmtCount → class-resolver.js로 분리됨

// ─── Category & SubFilter / 필터·내비게이션 UI → filter-nav.js로 분리됨 ─────
// (setCategory, updateL1ExpandIcons, renderSubFilters, renderBranchFilter, _renderL3Chip,
//  renderClassCodeFilter, setClassCode, setBranch*, renderFilterChips, removeFilterChip,
//  clearAllFilters, setSubFilter, getSubFilterCount, toggleClassDelete*, setClassMgmtMode)

window.branchFromStudent = branchFromStudent;
window.deriveNaesinCode = deriveNaesinCode;
window.displayCodeFromCsKey = displayCodeFromCsKey;
window.getNaesinStudentsByDerivedCode = getNaesinStudentsByDerivedCode;
// _renderL3Chip, renderClassCodeFilter, toggleClassDeleteMode, toggleClassDeleteSelect → filter-nav.js로 분리됨
window.toggleClassDeleteMode = toggleClassDeleteMode;
window.toggleClassDeleteSelect = toggleClassDeleteSelect;

// 순차 실행 — deleteClass가 state.allStudents.enrollments를 in-place 변경하므로
// Promise.all로 병렬 처리하면 같은 학생의 enrollments가 두 deletion에서 race 발생.
async function _runBulkDelete(items, label) {
    let success = 0, failed = 0;
    for (const { mode, code } of items) {
        try {
            const result = await deleteClass(code, mode, { skipRender: true });
            if (result?.readOnly) failed++;
            else success++;
        } catch (err) {
            console.error(`[${label}] ${mode}/${code} 실패:`, err);
            failed++;
        }
    }
    state._classDeleteMode = false;
    state._classDeleteSelected.clear();
    state._classMgmtMode = null;
    state.selectedClassCode = null;
    renderClassCodeFilter();
    renderListPanel();
    renderStudentDetail(null);
    showToast(`${label}: 성공 ${success}건${failed > 0 ? ` / 실패 ${failed}건` : ''}`);
}

window.bulkDeleteSelectedClasses = async function() {
    const selected = [...state._classDeleteSelected].map(k => {
        const [mode, code] = k.split('|');
        return { mode, code };
    });
    if (selected.length === 0) return;

    const hasRegular = selected.some(s => s.mode === 'regular');
    const inProgress = selected.filter(s => getClassPeriodInfo(s.code, s.mode)?.inProgress);
    const labels = selected.map(s => {
        const period = getClassPeriodInfo(s.code, s.mode);
        const flag = period?.inProgress ? ' (진행 중)' : '';
        return `[${CLASS_MODE_LABELS[s.mode] || s.mode}] ${s.code}${flag}`;
    }).join('\n');

    if (hasRegular || inProgress.length > 0) {
        const reasons = [];
        if (hasRegular) reasons.push('정규 반이 포함되어 있어 학생들의 정규 등록이 끊깁니다.');
        if (inProgress.length > 0) reasons.push(`진행 중인 반 ${inProgress.length}개가 포함되어 있습니다. 해당 학생들이 즉시 정규로 복귀합니다.`);
        const first = confirm(`⚠️ ${selected.length}개 반 일괄 삭제\n\n${reasons.join('\n')}\n\n${labels}\n\n진짜 삭제하시겠습니까?`);
        if (!first) return;
        const typed = prompt(`정말 일괄 삭제하려면 "삭제"를 입력하세요`);
        if (typed !== '삭제') {
            alert('입력이 일치하지 않아 취소되었습니다.');
            return;
        }
    } else {
        const ok = confirm(`${selected.length}개 반 일괄 삭제\n\n${labels}\n\n진행하시겠습니까?`);
        if (!ok) return;
    }

    await _runBulkDelete(selected, '일괄 삭제');
};
// setClassMgmtMode, setClassCode, setBranch*, renderFilterChips, removeFilterChip,
// clearAllFilters, setSubFilter, _getSubFilterBase, getSubFilterCount → filter-nav.js로 분리됨
window.setClassMgmtMode = setClassMgmtMode;
window.removeFilterChip = removeFilterChip;
window.clearAllFilters = clearAllFilters;


// getScheduledVisits, getEnrollPendingVisits → imported from visit-list-render.js

// ─── Filtering / 리스트 패널 렌더링 → list-view.js로 분리됨
// (getFilteredStudents, renderListPanel)


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
// getClassCodesForDate → class-resolver.js로 분리됨

// openTempClassOverrideModal, submitTempClassOverrideFromModal → modals.js로 분리됨
window.openTempClassOverrideModal = openTempClassOverrideModal;
window.submitTempClassOverrideFromModal = submitTempClassOverrideFromModal;

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
        const completedBy = staffLabel(state.currentUser?.email);
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
        const cancelledBy = staffLabel(state.currentUser?.email);
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
// closeModal, openScheduleModal, openHomeworkModal, openTestModal,
// saveScheduleFromModal, saveHomeworkFromModal, saveTestFromModal,
// saveStudentScheduledTime, openEnrollmentModal, saveEnrollment
// → modals.js로 분리됨

// ─── 롤/메모 → role-memo.js로 분리됨 ──────────────────────────────────────

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

// 데스크톱↔오버레이(<=1100px) 경계를 넘을 때 stale 클래스 정리 —
// 안 하면 데스크톱에서 남은 mobile-visible이 좁은 화면에서 빈 detail 패널(z-index 160)로
// 리스트와 사이드바 드로어를 덮는다. 768px 경계(모바일↔태블릿)는 양쪽 다 오버레이라 정리 불필요.
window.matchMedia('(max-width: 1100px)').addEventListener('change', (e) => {
    document.getElementById('detail-panel')?.classList.remove('mobile-visible');
    if (!e.matches) window.closeSidebar();
});


// ─── Auth ───────────────────────────────────────────────────────────────────

onAuthStateChanged(auth, async (user) => {
    if (user) {
        // dataApp(Firestore) auth 미러링 완료 보장 — 미완이면 첫 쿼리가 unauthenticated로 거부됨
        await dataAuthReady();
        const email = user.email || '';
        const allowed = email.endsWith('@impact7.kr') || email.endsWith('@gw.impact7.kr');
        if (!user.emailVerified || !allowed) {
            alert('허용되지 않은 계정입니다.\n학원 계정(@impact7.kr 또는 @gw.impact7.kr)으로 다시 로그인해주세요.');
            await logout();
            return;
        }

        state.currentUser = user;
        window._auditUser = normalizeImpact7Email(user.email) || null;
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('boot-splash')?.remove();
        document.getElementById('main-screen').style.display = '';
        document.getElementById('user-email').textContent = staffLabel(user.email);
        document.getElementById('user-avatar').textContent = (user.email || 'U')[0].toUpperCase();
        document.getElementById('user-avatar').title = `${normalizeImpact7Email(user.email)} (클릭: 로그아웃)`;

        // 날짜/UI는 데이터 로드 실패와 무관하게 반드시 표시
        updateDateDisplay();

        try {
            await loadStudents();
            await promoteEnrollPending();
            await backfillStudentNumbers();
            await promoteWithdrawalDate();
            await promoteScheduledLeave();
            buildSiblingMap();
            // 비차단: write가 서버 ack을 못 받아도 초기 렌더링을 막지 않음 (내부 try-catch 있음)
            trackTeacherLogin(user);
            await Promise.allSettled([loadDailyRecords(state.selectedDate), loadRetakeSchedules(), loadHwFailTasks(), loadTestFailTasks(), loadTempAttendances(state.selectedDate), loadTempClassOverrides(state.selectedDate), loadAbsenceRecords(), loadLeaveRequests(), loadUserRole(), loadClassSettings(), loadClassNextHw(state.selectedDate), loadTeachers()]);
        } catch (err) {
            console.error('[init] 데이터 로드 중 오류:', err);
        }
        // 백그라운드 후처리 (실패해도 앱 동작에 영향 없음)
        syncTaskStudentNames().catch(e => console.warn('[syncNames]', e));
        updateDateDisplay();
        renderBranchFilter();
        renderSubFilters();
        updateL1ExpandIcons();
        renderListPanel();

        // ── 첫 렌더 후 지연 작업. 퇴원생(1.5만+건)은 시스템 전반이 비원생 포함
        //    전제라 전체 적재가 필요하다 — 단 첫 조작(학생 클릭) 경합을 피해
        //    idle에 시작하고, 로드 자체도 캐시 우선 + 청크 분할(data-layer 참조).
        (async () => {
            try {
                await syncAbsenceRecords();
                await autoCleanupClasses();
                await loadRoleMemos().catch(() => {});
                renderListPanel();
                await new Promise(r => (window.requestIdleCallback || ((f) => setTimeout(f, 3000)))(r));
                await loadWithdrawnStudents();
            } catch (err) {
                console.error('[init-deferred] 후속 로드 중 오류:', err);
            }
        })();

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
        document.getElementById('boot-splash')?.remove();
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
// 모듈 로드 완료 — HTML에서 disabled로 시작한 로그인 버튼 활성화
{
    const loginBtn = document.getElementById('login-btn');
    if (loginBtn) {
        loginBtn.disabled = false;
        loginBtn.style.opacity = '';
        loginBtn.style.cursor = '';
    }
}

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
window.showToast = showToast;
window.setCategory = setCategory;
if (import.meta.env?.DEV) { window._debug = { get absenceRecords() { return state.absenceRecords; }, get dailyRecords() { return state.dailyRecords; }, get selectedDate() { return state.selectedDate; }, set selectedDate(v) { state.selectedDate = v; }, get allStudents() { return state.allStudents; } }; }
window.setSubFilter = setSubFilter;
window.setBranch = setBranch;
window.setBranchLevel = setBranchLevel;
window.setBranchClass = setBranchClass;
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
    await backfillStudentNumbers();
    await promoteWithdrawalDate();
    await promoteScheduledLeave();
    // 퇴원생(1.5만+건)은 전체 로드된 적 있을 때만 갱신 (검색의 부분 push는 제외)
    if (state._withdrawnFullyLoaded) await loadWithdrawnStudents();
    await Promise.allSettled([loadDailyRecords(state.selectedDate), loadRetakeSchedules(), loadHwFailTasks(), loadTestFailTasks(), loadTempAttendances(state.selectedDate), loadTempClassOverrides(state.selectedDate), loadAbsenceRecords(), loadLeaveRequests(), loadRoleMemos(), loadClassSettings(true), loadClassNextHw(state.selectedDate), loadTeachers()]);
    await syncAbsenceRecords();
    await autoCleanupClasses();
    renderBranchFilter();
    renderSubFilters();
    renderListPanel();
    if (state.selectedStudentId) renderStudentDetail(state.selectedStudentId);
    showSaveIndicator('saved');
};

window.runOldRecordCleanup = async (force = false) => {
    if (!force && !confirm('오래된 결석/휴퇴원/미통과 기록을 자동 정리합니다. production 데이터가 변경됩니다. 진행하시겠습니까?')) return;
    await autoCloseOldRecords();
    renderSubFilters();
    renderListPanel();
    if (state.selectedStudentId) renderStudentDetail(state.selectedStudentId);
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

// _isNaesinClassCode → class-resolver.js로 분리됨
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
window._renderTime12hOptions = renderTime12hOptions;
window.getTeacherName = getTeacherName;
Object.defineProperty(window, 'teachersList', { get() { return state.teachersList; }, configurable: true });

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
            (e, i) => i !== naesinIdx && (e.class_type === '정규' || e.class_type === '자유학기')
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
