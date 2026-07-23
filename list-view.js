// ─── List View ──────────────────────────────────────────────────────────────
// daily-ops.js에서 분리한 학생 필터링 파이프라인 + 리스트 패널 렌더링 (클러스터 3+4)

import { msIcon } from './ms-icon.js';
import {
    state, LEAVE_STATUSES, SV_L3_KEYS, DEFAULT_TONE, REGULAR_CLASS_TYPES
} from './state.js';
import { getDayName, todayStr, PAST_STUDENT_STATUSES, finalApprovalDate } from './src/shared/firestore-helpers.js';
import {
    branchFromStudent, matchesBranchFilter, enrollmentCode, allClassCodes,
    getActiveEnrollments, getStudentStartTime, isOnLeaveAt, isWithdrawnAt,
    isNaesinActiveToday, isFreeSemesterActiveToday, isPauseExpired, pauseExpiredDays, isValidDateStr,
    findStudent, buildSiblingMap, studentMatchesSearchTerms,
} from './student-helpers.js';
import { findSeparateTeukangVisit } from './student-core.js';
import { schoolSearchTerms } from './school-normalizer.js';
import { ENROLLABLE_STATUSES } from '@impact7/shared/enrollment-status';
import { esc, escAttr, formatTime12h, oxChip, oxChipBtn } from './ui-utils.js';
import {
    getTeacherName, addOverrideInStudents, getStudentOverrides, getStudentDomains, getStudentTestItems,
    _isOlderThan, _isDetailInputFocused, loadWithdrawnStudents
} from './data-layer.js';
import { isNewStudent, ensureNewStudentStatuses, DEFAULT_ATTENDANCE_LABELS } from './attendance.js';
import { importantRecordTooltip } from './docu-records.js';
import { renderClassDetail, renderBranchClassDetail } from './class-detail.js';
import { renderStudentDetail } from './student-detail.js';
import {
    getEnrollPendingVisits,
    renderScheduledVisitList, renderEnrollPendingOnly, renderEnrollPendingSection,
    renderDepartureCheckList
} from './visit-list-render.js';
import { renderAbsenceLedgerList } from './absence-records.js';
import { renderLeaveRequestList, renderReturnUpcomingList } from './leave-request.js';
import { renderNextHwClassList } from './hw-management.js';
import { exitBulkMode, updateBulkBar } from './bulk-mode.js';
import {
    getRegularClassStudents, getTeukangClassStudents, getFreeSemesterClassStudents,
    getNaesinStudentsByDerivedCode, _isNaesinClassCode
} from './class-resolver.js';

// 잔류 모듈(클러스터 1) 함수 주입
let renderFilterChips;
export function initListViewDeps(deps) {
    ({ renderFilterChips } = deps);
}

let _regularDayCache = { date: null, dayName: null };
export function hasRegularEnrollmentToday(student) {
    if (_regularDayCache.date !== state.selectedDate) {
        _regularDayCache = { date: state.selectedDate, dayName: getDayName(state.selectedDate) };
    }
    const dayName = _regularDayCache.dayName;
    return getActiveEnrollments(student, state.selectedDate).some(e =>
        e.day.includes(dayName) &&
        REGULAR_CLASS_TYPES.includes(e.class_type || '정규')
    );
}

export function hasTeukangEnrollmentToday(student) {
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
export function getEffectiveAttendanceTime(s, date, dayName) {
    const times = [];
    for (const e of getActiveEnrollments(s, date)) {
        if (!(e.day || []).includes(dayName)) continue;
        const t = getStudentStartTime(e, dayName);
        if (t) times.push(t);
    }
    times.push(...collectVisitTimes(s, date));
    return times.length === 0 ? '99:99' : times.sort()[0];
}

function collectVisitTimes(s, date) {
    const times = [];
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
    return times;
}

export function isVisitStudent(docId) {
    const hwFail = state.dailyRecords[docId]?.hw_fail_action || {};
    if (Object.values(hwFail).some(a => a.type === '등원' && a.scheduled_date === state.selectedDate)) return true;
    if (state.hwFailTasks.some(t => t.student_id === docId && t.type === '등원' && t.status === 'pending' &&
        t.scheduled_date === state.selectedDate)) return true;
    if (state.testFailTasks.some(t => t.student_id === docId && t.type === '등원' && t.status === 'pending' &&
        t.scheduled_date === state.selectedDate)) return true;
    if (state.dailyRecords[docId]?.extra_visit?.date === state.selectedDate) return true;
    return false;
}

// ─── Filtering ──────────────────────────────────────────────────────────────

// 학생 검색 술어 (SSoT). 호출처마다 매칭 범위가 다르므로 플래그로 절을 켠다.
// name·학교는 항상 매칭; enroll(반코드)·phone(학생/학부모)·teacher(담당교사)는 옵션.
// 전부 OR 논리라 절 평가 순서는 결과에 영향 없다.
function studentMatchesQuery(s, q, { enroll = false, phone = false, teacher = false } = {}) {
    const extraTerms = [...schoolSearchTerms(s)];
    if (enroll) extraTerms.push(...(s.enrollments || []).map(enrollmentCode));
    if (teacher) extraTerms.push(...(s.enrollments || []).map(e => {
        const t = state.classSettings[enrollmentCode(e)]?.teacher;
        return t ? getTeacherName(t) : '';
    }));
    const searchableStudent = phone ? s : { name: s.name };
    return studentMatchesSearchTerms(searchableStudent, q, extraTerms);
}

export function getFilteredStudents() {
    if (state.searchQuery?.trim()) {
        const q = state.searchQuery.trim().toLowerCase();
        const studentsById = new Map(
            [...state.withdrawnStudents, ...state.allStudents].map(s => [s.docId, s])
        );
        return [...studentsById.values()].filter(s =>
            studentMatchesQuery(s, q, { enroll: true, phone: true, teacher: true })
        );
    }

    // 반 설정/소속 L4: 정규 모드 + 반 선택 — 그 반에 등록된 모든 정규/자유학기 학생 (요일 무관)
    // + 오늘 그 반으로 들어온 타반수업 학생도 포함 (a101 김여원이 a103에서 수업하면 a103 화면에서도 보이도록)
    if (state._classMgmtMode === 'regular' && state.selectedClassCode) {
        // 반설정 트리에서 선택 시 등원예정 멤버 포함, 소속 트리(출결)에서 선택 시 제외
        const students = getRegularClassStudents(state.selectedClassCode, state._classFilterSource === 'classmgmt');
        addOverrideInStudents(students, state.selectedClassCode);
        return students;
    }

    // 반 설정: 특강 모드 — 날짜 무관, 특강 반 전체 학생 + 오늘 그 반으로 들어온 타반수업 학생
    if (state._classMgmtMode === 'teukang' && state.selectedClassCode) {
        const students = getTeukangClassStudents(state.selectedClassCode);
        addOverrideInStudents(students, state.selectedClassCode);
        return students;
    }

    // 반 설정: 자유학기 모드 — 날짜 무관, 자유학기 enrollment 가진 학생 + 오늘 그 반으로 들어온 타반수업 학생
    if (state._classMgmtMode === 'free' && state.selectedClassCode) {
        const students = getFreeSemesterClassStudents(state.selectedClassCode);
        addOverrideInStudents(students, state.selectedClassCode);
        return students;
    }

    // 반 설정: 내신 반코드 선택 시 (글로벌 필터이므로 state.currentCategory 무관) + 오늘 그 반으로 들어온 타반수업 학생
    if (state._classMgmtMode === 'naesin' && state.selectedClassCode && _isNaesinClassCode(state.selectedClassCode)) {
        const students = getNaesinStudentsByDerivedCode(state.selectedClassCode).map(({ student }) => student);
        addOverrideInStudents(students, state.selectedClassCode);
        return students;
    }

    // 반 설정: 정규 모드 — 등록된 모든 정규/자유학기 학생 (요일 무관, 내신 기간 중인 학생도 포함)
    // 반설정의 목적은 반 멤버십 확인이므로 오늘 등원 여부·내신/자유학기 기간 여부와 무관하게
    // 정규 등록(class_number)이 살아있는 학생을 모두 노출. getActiveEnrollments는 내신/자유학기
    // 기간 중 정규를 숨기므로 raw enrollments에서 직접 조회.
    if (state.currentCategory === 'class_mgmt') {
        const today = state.selectedDate;
        const isActiveRegular = (e) =>
            (e.class_type === '정규' || e.class_type === '자유학기') &&
            e.class_number &&
            !(isValidDateStr(e.end_date) && e.end_date < today);
        let students = state.allStudents.filter(s =>
            !isWithdrawnAt(s, today) && (s.enrollments || []).some(isActiveRegular)
        );
        // 타반수업 override-in 학생 추가 (정규 목록에 없는 학생만)
        addOverrideInStudents(students);
        students = students.filter(s => matchesBranchFilter(s));
        if (state.searchQuery) {
            const q = state.searchQuery.trim().toLowerCase();
            students = students.filter(s => studentMatchesQuery(s, q, { enroll: true, phone: true, teacher: true }));
        }
        if (state.currentSubFilter.size > 0 && !state.currentSubFilter.has('all')) {
            students = students.filter(s => {
                // 정규 enrollment 매칭 (요일 무관)
                const hasRegular = (s.enrollments || []).some(e =>
                    isActiveRegular(e) && state.currentSubFilter.has(enrollmentCode(e))
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

    let students = state.allStudents.filter(s => {
        if (PAST_STUDENT_STATUSES.has(s.status)) {
            return getActiveEnrollments(s, state.selectedDate).some(e =>
                e.class_type === '특강' && e.day.includes(dayName)
            );
        }
        if (isOnLeaveAt(s, state.selectedDate) && state.currentCategory !== 'attendance') return false;
        return getActiveEnrollments(s, state.selectedDate).some(e => e.day.includes(dayName));
    });
    const studentIds = new Set(students.map(s => s.docId));
    for (const s of state.withdrawnStudents) {
        if (!studentIds.has(s.docId) && getActiveEnrollments(s, state.selectedDate).some(e =>
            e.class_type === '특강' && e.day.includes(dayName)
        )) {
            students.push(s);
            studentIds.add(s.docId);
        }
    }
    addOverrideInStudents(students, state.selectedClassCode || null);

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
        students = students.filter(s => studentMatchesQuery(s, q, { enroll: true, phone: true, teacher: true }));
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
            if (!matchesBranchFilter(s)) return false;
            return isVisitStudent(s.docId);
        });
        if (visitStudents.length > 0) {
            let filtered = visitStudents;
            if (state.searchQuery) {
                const q = state.searchQuery.trim().toLowerCase();
                filtered = filtered.filter(s => studentMatchesQuery(s, q, { enroll: true }));
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

export function renderListPanel() {
    const searching = !!state.searchQuery?.trim();
    const searchTerm = state.searchQuery?.trim() || '';
    const loadingPastStudents = searching && !state._withdrawnFullyLoaded;

    if (loadingPastStudents) {
        loadWithdrawnStudents().then(loaded => {
            if (state.searchQuery?.trim() !== searchTerm) return;
            if (!loaded) {
                const countEl = document.getElementById('list-count');
                const container = document.getElementById('list-items');
                const matchCount = getFilteredStudents().length;
                if (countEl) countEl.textContent = `${matchCount}명 · 비원생 검색 실패`;
                if (container && matchCount === 0) {
                    container.innerHTML = `<div class="empty-state">
                        ${msIcon('person_search')}
                        <p>비원생 검색을 불러오지 못했습니다</p>
                    </div>`;
                }
                return;
            }
            buildSiblingMap();
            renderListPanel();
            if (state.selectedStudentId) renderStudentDetail(state.selectedStudentId);
        });
    }

    // 내신 서브필터 활성 시 내신 리스트로 전환
    if (!searching && state.currentCategory === 'attendance' && state.currentSubFilter.has('naesin')) {
        if (window.renderNaesinList) window.renderNaesinList();
        return;
    }

    // 비정규 L2 또는 L3(sv_*) 서브필터 활성 시 통합 리스트로 전환
    if (!searching && state.currentCategory === 'attendance' && (
        state.currentSubFilter.has('scheduled_visit') ||
        SV_L3_KEYS.some(k => state.currentSubFilter.has(k))
    )) {
        renderScheduledVisitList();
        return;
    }

    // 등원예정 L3 선택 시 등원예정만 표시
    if (!searching && state.currentCategory === 'attendance' && state.currentSubFilter.has('enroll_pending')) {
        renderEnrollPendingOnly();
        return;
    }

    // 하원점검 서브필터 활성 시 하원 체크 리스트로 전환
    if (!searching && state.currentCategory === 'attendance' && state.currentSubFilter.has('departure_check')) {
        renderDepartureCheckList();
        return;
    }

    // 결석대장 서브필터 활성 시 결석대장 리스트로 전환
    if (!searching && state.currentCategory === 'admin' && state.currentSubFilter.has('absence_ledger')) {
        renderAbsenceLedgerList();
        return;
    }

    // 휴퇴원요청서 서브필터 활성 시 요청서 리스트로 전환
    if (!searching && state.currentCategory === 'admin' && state.currentSubFilter.has('leave_request')) {
        renderLeaveRequestList();
        return;
    }

    // 복귀예정 서브필터 활성 시 복귀예정 리스트로 전환
    if (!searching && state.currentCategory === 'admin' && state.currentSubFilter.has('return_upcoming')) {
        renderReturnUpcomingList();
        return;
    }

    // hw_next 서브필터 활성 시 반별 리스트로 전환
    if (!searching && state.currentCategory === 'homework' && state.currentSubFilter.has('hw_next')) {
        renderNextHwClassList();
        return;
    }

    const students = getFilteredStudents();
    const container = document.getElementById('list-items');
    const countEl = document.getElementById('list-count');
    const todayDate = new Date(`${todayStr()}T00:00:00+09:00`);
    ensureNewStudentStatuses(students, todayDate).then(changed => {
        if (changed) renderListPanel();
    });
    // 필터 칩 렌더링
    renderFilterChips();

    // 벌크 모드: 현재 목록에 없는 학생 선택 해제, 0명이면 벌크모드 종료
    if (state.bulkMode) {
        const visibleIds = new Set(students.filter(s => ENROLLABLE_STATUSES.has(s.status)).map(s => s.docId));
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
    const enrollPendingCount = (!searching && state.currentCategory === 'attendance' && state.currentSubFilter.has('pre_arrival'))
        ? getEnrollPendingVisits().length : 0;
    countEl.textContent = loadingPastStudents
        ? `${students.length}명 · 전체 검색 중`
        : `${students.length + enrollPendingCount}명`;

    if (students.length === 0 && enrollPendingCount === 0) {
        container.innerHTML = `<div class="empty-state">
            ${msIcon('person_search')}
            <p>${loadingPastStudents ? '전체 학생을 검색하고 있습니다' : '해당하는 학생이 없습니다'}</p>
        </div>`;
        return;
    }

    // 후속대책 버튼 표시 조건 — 한 번만 계산
    const isHw1stFilter = state.currentCategory === 'homework' && state.currentSubFilter.has('hw_1st');
    const isTest1stFilter = state.currentCategory === 'test' && state.currentSubFilter.has('test_1st');

    // 내신 학생 ID 집합 (오늘 요일 기준): 검색 시 todayStudents 분류 및 일일 운영 집계에 사용
    const naesinIds = new Set(
        (window._getNaesinStudents?.() || []).map(({ student }) => student.docId)
    );
    // 표시용 내신 집합 (요일 무관, 내신 기간 기준): 카드 배지에 사용.
    // 같은 학생이 보는 요일에 따라 다르게 표시되지 않도록 운영 집계와 분리한다.
    const naesinPeriodIds = window._getNaesinPeriodStudentIds?.() || naesinIds;

    const renderItemHtml = (s) => {
        const isActive = s.docId === state.selectedStudentId ? 'active' : '';
        const canBulkSelect = ENROLLABLE_STATUSES.has(s.status);
        const dayN = getDayName(state.selectedDate);
        const _activeEnrolls = getActiveEnrollments(s, state.selectedDate);
        const _todayEnrolls = _activeEnrolls.filter(e => e.day.includes(dayN));
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
        let mainAttendanceToggle = '';
        let visit2AttendanceToggle = '';
        let visit2First = false;
        const isLeave = LEAVE_STATUSES.includes(s.status);
        const sepVisit = isLeave ? null : findSeparateTeukangVisit(_todayEnrolls, (e) => getStudentStartTime(e, dayN));
        const mainEnrolls = _todayEnrolls.filter(e => REGULAR_CLASS_TYPES.includes(e.class_type || '정규'));
        // dayN 전달 — 합성 내신/자유학기 enrollment의 schedule 객체에서 요일별 시간 조회 가능해야 함.
        // 누락 시 fallback이 hw_fail/test_fail 보충 시간(17:30 등)을 가장 이른 시간으로 끌어와 정규 등원시간을 덮음.
        let scheduledTime = mainEnrolls.map(e => getStudentStartTime(e, dayN)).filter(Boolean).sort()[0] || '';
        if (!scheduledTime && mainEnrolls.length === 0) {
            // 비정규(오늘 enrollment 없음) — hw_fail/test_fail/extra_visit의 가장 이른 scheduled_time 사용
            const eff = getEffectiveAttendanceTime(s, state.selectedDate, dayN);
            if (eff !== '99:99') scheduledTime = eff;
        }
        // classSettings 검증 인라인 — end_date 없는 구 정규/고아 enrollment 오분류 방지, _todayEnrolls 재사용
        const isTeukangOnly = !isLeave
            && _todayEnrolls.some(e => { const ec = enrollmentCode(e); return e.class_type === '특강' && ec && state.classSettings[ec]?.class_type === '특강'; })
            && !_todayEnrolls.some(e => { if (!REGULAR_CLASS_TYPES.includes(e.class_type || '정규')) return false; const ec = enrollmentCode(e); return !ec || state.classSettings[ec] !== undefined; });

        if (!canBulkSelect || isLeave) {
            toggleHtml = '';
        } else if (state.currentCategory === 'attendance') {
            const rec = state.dailyRecords[s.docId];
            const attStatus = rec?.attendance?.status || '미확인';
            // 학생 레벨 현재 모드 판정 — 우선순위 내신 > 자유 > 특강 > 비정규 > 정규.
            // enrollment.class_type 단독 판정은 옛 자유학기 enrollment가 내신 기간에 살아남는
            // 경우(getActiveEnrollments step 2 결과) 오분류를 내므로 class_settings 윈도우를 확인.
            let defaultLabel;
            if (isNaesinActiveToday(s, state.selectedDate)) defaultLabel = '내신';
            else if (isFreeSemesterActiveToday(s, state.selectedDate)) defaultLabel = '자유';
            else if (isTeukangOnly) defaultLabel = '특강';
            else if (_todayEnrolls.length === 0 && isVisitStudent(s.docId)) defaultLabel = '비정규';
            else defaultLabel = '정규';
            const statuses = [defaultLabel, '출석', '지각', '결석', '조퇴', '기타'];
            // 저장된 기본 라벨(정규/특강/내신/자유/비정규)과 '미확인'은 현재 컨텍스트의 defaultLabel로 표시
            const currentDisplay = (attStatus === '미확인' || DEFAULT_ATTENDANCE_LABELS.has(attStatus)) ? defaultLabel : attStatus;
            mainAttendanceToggle = `<div class="toggle-group">` +
                statuses.map(st => {
                    const classes = ['toggle-btn'];
                    if (st === defaultLabel) classes.push('type-tag', `default-tone-${DEFAULT_TONE[defaultLabel]}`);
                    if (st === currentDisplay) {
                        if (st === '출석') classes.push('active-present');
                        else if (st === '결석') classes.push('active-absent');
                        else if (st === '지각') classes.push('active-late');
                        else if (st === defaultLabel) classes.push('active-default');
                        else classes.push('active-other');
                    }
                    return `<button class="${classes.join(' ')}" aria-pressed="${st === currentDisplay}" onclick="event.stopPropagation(); toggleAttendance('${escAttr(s.docId)}', '${st}')">${st}</button>`;
                }).join('') +
                `</div>`;
            toggleHtml = mainAttendanceToggle;
            if (sepVisit) {
                const v2Status = rec?.visit2?.status || '미확인';
                const v2Display = v2Status === '미확인' ? '특강' : v2Status;
                visit2AttendanceToggle = `<div class="toggle-group">` +
                    ['특강', '출석', '지각', '결석', '조퇴', '기타'].map(st => {
                        const classes = ['toggle-btn'];
                        if (st === '특강') classes.push('type-tag', `default-tone-${DEFAULT_TONE['특강']}`);
                        if (st === v2Display) {
                            if (st === '출석') classes.push('active-present');
                            else if (st === '결석') classes.push('active-absent');
                            else if (st === '지각') classes.push('active-late');
                            else if (st === '특강') classes.push('active-default');
                            else classes.push('active-other');
                        }
                        return `<button class="${classes.join(' ')}" aria-pressed="${st === v2Display}" onclick="event.stopPropagation(); toggleVisit2Attendance('${escAttr(s.docId)}', '${st}')">${st}</button>`;
                    }).join('') + `</div>`;
            }
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
                    domains.map(d => oxChipBtn(d, domainData[d] || '', s.docId, field)).join('') +
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
                                return `<button class="toggle-btn ${activeClass}" aria-pressed="${h.status === st}" onclick="event.stopPropagation(); toggleHomework('${escAttr(s.docId)}', ${i}, '${st}')">${st}</button>`;
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
                            domains.map(d => oxChip(d, d1st[d] || '')).join('') +
                            `</div></div>`);
                    }
                    if (has2nd) {
                        summaryParts.push(`<div class="hw-domain-summary"><span class="hw-domain-summary-label">2차</span><div class="hw-domain-group">` +
                            domains.map(d => oxChip(d, d2nd[d] || '')).join('') +
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
                        filtered.map(t => oxChipBtn(t, domainData[t] || '', s.docId, field)).join('') +
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
                                items.map(t => oxChip(t, data[t] || '')).join('') +
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
                const days = e.day?.join('·') || '';
                const time = getStudentStartTime(e) ? formatTime12h(getStudentStartTime(e)) : '';
                return `<div style="margin-top:4px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                    <span style="font-size:12px;color:var(--text-sec);">${esc(enrollmentCode(e))} ${days} ${time}</span>
                    <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); openEnrollmentModal('${escAttr(s.docId)}', ${idx})">편집</button>
                </div>`;
            }).join('');
        }

        // 등원시간 (휴원 학생은 미표시)
        let timeHtml = '';
        let mainTimeBlockHtml = '';
        let visit2TimeBlockHtml = '';
        const rec = state.dailyRecords[s.docId];
        if (!isLeave) {
            const arrivalTime = rec?.arrival_time;

            // 비정규 등원 예약 시간 (hw_fail/test_fail/extra_visit/hw_fail_action 통합).
            // 정규/fallback 예정 시간(scheduledTime)과 다른 것만 보충 블록으로 표시.
            const visitBonusTimes = collectVisitTimes(s, state.selectedDate);
            const uniqueBonusTimes = [...new Set(visitBonusTimes)].filter(t => t !== scheduledTime && t !== sepVisit?.time).sort();

            let timeLabel = '', timeValue = '', timeClass = '';
            if (arrivalTime) {
                timeLabel = '등원'; timeValue = formatTime12h(arrivalTime); timeClass = 'arrived';
            } else if (scheduledTime) {
                timeLabel = '예정'; timeValue = formatTime12h(scheduledTime);
            } else if (_todayEnrolls.length === 0 && isVisitStudent(s.docId)) {
                // 비정규인데 모든 visit task의 scheduled_time이 비어있음 — 시간 미입력 표시
                timeLabel = '예정'; timeValue = '(미정)'; timeClass = 'time-unset';
            } else if (sepVisit) {
                timeLabel = '예정'; timeValue = '(미정)'; timeClass = 'time-unset';
            }
            const timeBlocks = [];
            if (timeValue) {
                mainTimeBlockHtml = `<div class="item-time-block ${timeClass}">
                <span class="item-time-label">${timeLabel}</span>
                <span class="item-time-value">${esc(timeValue)}</span>
            </div>`;
                timeBlocks.push({ sort: scheduledTime || arrivalTime || '99:99', html: mainTimeBlockHtml });
            }
            if (sepVisit) {
                const v2 = rec?.visit2;
                const v2Arrived = !!v2?.arrival_time;
                const v2Time = v2Arrived ? v2.arrival_time : sepVisit.time;
                visit2TimeBlockHtml = `<div class="item-time-block ${v2Arrived ? 'arrived' : (v2Time ? '' : 'time-unset')}">
                    <span class="item-time-label">${v2Arrived ? '등원' : '예정'}</span>
                    <span class="item-time-value">${v2Time ? esc(formatTime12h(v2Time)) : '(미정)'}</span>
                </div>`;
                timeBlocks.push({ sort: v2Time || '99:99', html: visit2TimeBlockHtml });
            }
            timeBlocks.sort((a, b) => a.sort.localeCompare(b.sort));
            const bonusTimeHtml = uniqueBonusTimes.map(t => `<div class="item-time-block" style="color:var(--danger);">
                <span class="item-time-label" style="color:var(--danger);">보충</span>
                <span class="item-time-value" style="color:var(--danger);">${esc(formatTime12h(t))}</span>
            </div>`).join('');
            timeHtml = [
                ...timeBlocks.map(b => b.html),
                bonusTimeHtml
            ].join('');

            if (state.currentCategory === 'attendance' && sepVisit) {
                visit2First = (rec?.visit2?.arrival_time || sepVisit.time || '99:99')
                    < (arrivalTime || scheduledTime || '99:99');
                const pair1 = `<div class="visit-pair">${mainTimeBlockHtml}${mainAttendanceToggle}</div>`;
                const pair2 = `<div class="visit-pair">${visit2TimeBlockHtml}${visit2AttendanceToggle}</div>`;
                const pairedAttendance = visit2First ? pair2 + pair1 : pair1 + pair2;
                timeHtml = bonusTimeHtml;
                toggleHtml = pairedAttendance;
            }
        }

        // hw_fail_tasks 기반 아이콘 (대체숙제/등원예약) - pending 상태만
        const pendingTasks = state.hwFailTasks.filter(t => t.student_id === s.docId && t.status === 'pending');
        const hasAltHw = pendingTasks.some(t => t.type === '대체숙제');
        const hasVisit = pendingTasks.some(t => t.type === '등원');
        const hwFailIconHtml = hasAltHw
            ? `<span class="hw-fail-badge hw-fail-alt" title="대체숙제 있음">${msIcon('edit_note', '', 'style="font-size:14px;"')}</span>`
            : hasVisit
            ? `<span class="hw-fail-badge hw-fail-visit" title="등원 예약 있음">${msIcon('directions_walk', '', 'style="font-size:14px;"')}</span>`
            : '';

        // 형제 아이콘
        const activeSiblingNames = [...(state.siblingMap[s.docId] || [])]
            .map(sid => findStudent(sid))
            .filter(sibling => ENROLLABLE_STATUSES.has(sibling?.status))
            .map(sibling => sibling.name);
        const siblingIcon = activeSiblingNames.length
            ? `<span class="item-icon item-icon-sibling" title="형제: ${esc(activeSiblingNames.join(', '))}">${msIcon('group')}</span>`
            : '';

        const importantRecord = state.importantRecordsByStudent.get(s.docId);
        const importantTooltip = importantRecordTooltip(importantRecord);
        const importantRecordIcon = importantRecord
            ? `<span class="item-icon item-icon-important" role="img" tabindex="0" aria-label="${escAttr(importantTooltip)}" title="${escAttr(importantTooltip)}">${msIcon('keep')}</span>`
            : '';

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
            const isRecentWithdrawal = wdLr && !_isOlderThan(finalApprovalDate(wdLr), { months: 1 });
            if (hasCurrentSemester || isRecentWithdrawal) {
                leaveBadge = `<span class="tag" style="background:#dc2626;color:#fff;">퇴원</span>`;
            } else {
                leaveBadge = `<span class="tag-past">비원생</span>`;
            }
        }

        // 휴/퇴원 기간 — 출결 버튼이 없는 자리에 대신 노출 (만료 전에도 기간이 보이게)
        let leavePeriodHtml = '';
        if (LEAVE_STATUSES.includes(s.status)) {
            const start = s.pause_start_date ? esc(s.pause_start_date) : '';
            const end = s.pause_end_date ? esc(s.pause_end_date) : '';
            const range = start && end ? `${start} ~ ${end}` : end ? `~ ${end}` : start ? `${start} ~` : '기간 미정';
            leavePeriodHtml = `<span class="leave-period">휴원 ${range}</span>`;
        } else if (s.status === '퇴원' && s.withdrawal_date) {
            leavePeriodHtml = `<span class="leave-period">퇴원 ${esc(s.withdrawal_date)}</span>`;
        }

        // 휴원 만료 경고 뱃지 (실제 오늘 기준) — status 자동 전환 금지, 담당자 복귀 처리 유도
        const pauseExpiredBadge = isPauseExpired(s)
            ? `<span class="tag tag-pause-expired" title="휴원 기간이 만료됐습니다. 복귀 처리(상태 변경)가 필요합니다.">${msIcon('warning', '', 'style="font-size:1em;"')} 휴원만료 (~${esc(s.pause_end_date)}, ${pauseExpiredDays(s)}일 경과) · 복귀처리 필요</span>`
            : '';

        // 신규 학생 뱃지 (현재 연속 재원기간의 첫 등원일이 14일 이내)
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
        if (canBulkSelect && !isLeave && (isHw1stFilter || isTest1stFilter)) {
            const rec = state.dailyRecords[s.docId] || {};
            const field = isHw1stFilter ? 'hw_domains_1st' : 'test_domains_1st';
            const category = isHw1stFilter ? 'homework' : 'test';
            const hasFail1st = Object.values(rec[field] || {}).some(v => v && v !== 'O');
            if (hasFail1st) {
                followUpBtnHtml = `<button class="follow-up-btn" title="후속대책" aria-label="후속대책" onclick="event.stopPropagation(); openFollowUpAction('${escAttr(s.docId)}', '${category}')">${msIcon('assignment_late', '', 'style="font-size:16px;"')}</button>`;
            }
        }

        const isNaesinStudent = naesinPeriodIds.has(s.docId);
        const naesinBadge = isNaesinStudent ? '<span class="tag-naesin">내신</span>' : '';
        return `<div class="list-item ${isActive}${state.bulkMode ? ' bulk-mode' : ''}${state.selectedStudentIds.has(s.docId) ? ' bulk-selected' : ''}" data-id="${escAttr(s.docId)}" role="button" tabindex="0" data-keyclick onclick="handleListItemClick(event, '${escAttr(s.docId)}')">
            ${canBulkSelect ? `<input type="checkbox" class="list-item-checkbox" aria-label="학생 선택" ${state.selectedStudentIds.has(s.docId) ? 'checked' : ''} onclick="event.stopPropagation(); toggleStudentCheckbox('${escAttr(s.docId)}', this.checked)">` : ''}
            <div class="item-info">
                <span class="item-title">${esc(s.name)}${newBadge}${naesinBadge}${leaveBadge}${pauseExpiredBadge}${lrPendingTags}${siblingIcon}${importantRecordIcon}${hwFailIconHtml}${overrideBadge}${overrideInBadge}</span>
                ${teacherBadge}
            </div>
            <div class="item-times">${timeHtml}</div>
            <div class="item-actions">${toggleHtml || leavePeriodHtml}</div>
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
    const enrollPendingHtml = (!searching && state.currentCategory === 'attendance' && state.currentSubFilter.has('pre_arrival'))
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

    // 반 상세 표시: 반(+소속)만 선택되고, 콘텐츠 서브필터 없을 때
    // 내신/특강/자유학기 반 설정 모드에서는 항상 반 상세 표시
    // 단, 소속 트리에서 L4 반을 선택한 경우(selectedBranchLevel + selectedClassCode 동시 활성)는
    // 학생 리스트만 노출하고 반 상세 편집 UI는 띄우지 않음 (반설정 오접근 방지).
    // 이전 반 상세가 잔존하지 않도록 명시적으로 빈 상태로 복원.
    // onSnapshot 재렌더가 단체안내 입력 중 textarea를 지우지 않도록, 상세 입력 포커스 중이면 반 상세
    // 재렌더를 건너뛴다(renderStudentDetail의 _isDetailInputFocused 가드와 동일 정신). 사용자 액션 시엔
    // 포커스가 상세 밖(사이드바 등)으로 이동하므로 통과한다.
    const detailInputFocused = _isDetailInputFocused();
    const isL4Selection = !!(state.selectedBranchLevel && state.selectedClassCode);
    if (isL4Selection && !state.selectedStudentId) {
        // L4 + 학생 미선택: 소속반 뷰(현황=반 정보+학생목록, 메시지=단체 안내) 표시.
        // 반설정 편집 UI는 없다(반설정 오접근 방지). 학생 선택 시 renderStudentDetail이 다시 노출.
        if (!detailInputFocused) renderBranchClassDetail(state.selectedClassCode);
    } else if (((state._classMgmtMode === 'naesin' && _isNaesinClassCode(state.selectedClassCode)) ||
         state._classMgmtMode === 'teukang' ||
         state._classMgmtMode === 'free') && state.selectedClassCode && !state.selectedStudentId) {
        if (!detailInputFocused) renderClassDetail(state.selectedClassCode);
    } else {
        const allFilters = { ...state.savedSubFilters };
        allFilters[state.currentCategory] = new Set(state.currentSubFilter);
        const hasContentFilter = ['attendance', 'homework', 'test', 'automation', 'admin'].some(cat => allFilters[cat]?.size > 0);
        if (state.selectedClassCode && !state.selectedStudentId && !hasContentFilter) {
            if (!detailInputFocused) renderClassDetail(state.selectedClassCode);
        } else if (!state.selectedClassCode && !state.selectedStudentId && !hasContentFilter) {
            // 반·학생 모두 미선택(서브필터 없음): 직전 학생/반 카드 잔존 방지 — 빈 상태로 강제 복원.
            renderStudentDetail(null);
        }
    }
}
