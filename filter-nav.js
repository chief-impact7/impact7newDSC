// ─── Filter / Navigation ────────────────────────────────────────────────────
// daily-ops.js에서 분리한 필터/내비게이션 UI (클러스터 1: 좌측 트리 + 칩)

import { state, SV_SOURCE_MAP } from './state.js';
import { getDayName, studentLevel, ATTENDANCE_ACTIONS, normalizeAttendanceLabel } from './src/shared/firestore-helpers.js';
import {
    branchFromStudent, matchesBranchFilter, enrollmentCode, getActiveEnrollments,
    isWithdrawnAt, isOnLeaveAt
} from './student-helpers.js';
import { esc, escAttr } from './ui-utils.js';
import { renderStudentDetail } from './student-detail.js';
import { CLASS_MODE_LABELS } from './class-detail.js';
import {
    _getClassesForBranchLevel, _getAllClassCodes, getClassMgmtCount,
    getTeukangClassStudents, getUniqueClassCodes
} from './class-resolver.js';
import { _isOlderThan, getStudentDomains, getNextHwStatus, getStudentTestItems, updateDateDisplay } from './data-layer.js';
import { clearVisitCache, getScheduledVisits, getEnrollPendingVisits } from './visit-list-render.js';
import { resetReturnUpcomingCache, _getReturnUpcomingStudents } from './leave-request.js';

// 잔류/타모듈(list-view) 함수 주입
let renderListPanel, isVisitStudent, hasRegularEnrollmentToday, hasTeukangEnrollmentToday;
export function initFilterNavDeps(deps) {
    ({ renderListPanel, isVisitStudent, hasRegularEnrollmentToday, hasTeukangEnrollmentToday } = deps);
}

// ─── Category & SubFilter ──────────────────────────────────────────────────

export function setCategory(category) {
    // 소속 ↔ 반설정 트리는 상호 배타: 한쪽을 펼치면 반대쪽 트리·상태를 정리한다.
    if (category === 'branch') {
        const branchL1 = document.querySelector('.nav-l1[data-category="branch"]');
        const isExpanded = branchL1?.classList.contains('expanded');
        branchL1?.classList.toggle('expanded', !isExpanded);
        // 반설정 트리 닫고 모드/코드 클리어
        document.querySelector('.nav-l1[data-category="class_mgmt"]')?.classList.remove('expanded');
        const hadClassSelection = state._classMgmtMode || state.selectedClassCode;
        if (hadClassSelection) {
            state._classMgmtMode = null;
            state.selectedClassCode = null;
            state.selectedStudentId = null;
        }
        renderBranchFilter();
        renderClassCodeFilter();
        renderFilterChips();
        renderSubFilters();
        renderListPanel();
        if (hadClassSelection) renderStudentDetail(null);
        return;
    }

    if (category === 'class_mgmt') {
        const classL1 = document.querySelector('.nav-l1[data-category="class_mgmt"]');
        const isExpanded = classL1?.classList.contains('expanded');
        classL1?.classList.toggle('expanded', !isExpanded);
        // 소속 트리 닫고 필터 클리어 — 반설정은 모든 학생을 다룸 (소속 무관)
        document.querySelector('.nav-l1[data-category="branch"]')?.classList.remove('expanded');
        const hadBranchFilter = state.selectedBranch || state.selectedBranchLevel;
        if (hadBranchFilter) {
            state.selectedBranch = null;
            state.selectedBranchLevel = null;
            state.selectedStudentId = null;
        }
        renderBranchFilter();
        renderClassCodeFilter();
        renderFilterChips();
        renderSubFilters();
        renderListPanel();
        if (hadBranchFilter) renderStudentDetail(null);
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

        // 반 설정/소속 L4 모드 리셋 (콘텐츠 카테고리 전환 시 필터 누출 방지). regular 포함 — 소속 트리에서 L4를 선택한 상태로 다른 카테고리로 이동해도 자동 해제.
        if (state._classMgmtMode) { state._classMgmtMode = null; state.selectedClassCode = null; state._classFilterSource = null; }

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

    // 카테고리에 따라 과거/미래 날짜 배너 표시 여부가 달라지므로 갱신
    updateDateDisplay();

    // L2 서브필터 렌더링
    renderSubFilters();
    updateL1ExpandIcons();

    renderListPanel();
}

export function updateL1ExpandIcons() {
    document.querySelectorAll('.nav-l1').forEach(el => {
        const icon = el.querySelector('.nav-l1-expand');
        if (!icon) return;
        // branch, class_mgmt는 별도 관리
        if (el.dataset.category === 'branch' || el.dataset.category === 'class_mgmt') return;
        const isActive = el.dataset.category === state.currentCategory;
        icon.textContent = (isActive && state.l2Expanded) ? 'expand_less' : 'expand_more';
    });
}

// 사이드바 카운트(count/total)의 의미 — getSubFilterCount의 필터별 산식과 짝을 맞춘다
const COUNT_TOOLTIPS = {
    scheduled_visit: '미시행 / 전체 일정',
    pre_arrival: '출결 미입력 / 오늘 대상',
    enroll_pending: '등원예정 인원',
    present: '출석 / 오늘 정규',
    late: '지각 / 오늘 정규',
    absent: '결석 / 오늘 정규',
    other: '기타 / 오늘 정규',
    departure_check: '하원 완료 / 오늘 정규',
    naesin: '오늘 내신 인원',
    teukang: '오늘 특강 인원',
    sv_absence_makeup: '미시행 / 전체 일정',
    sv_clinic: '미시행 / 전체 일정',
    sv_diagnostic: '미시행 / 전체 일정',
    sv_fail: '미시행 / 전체 일정',
    absence_ledger: '열린 결석 기록',
    leave_request: '대기 요청 / 대기+최근 승인',
    return_upcoming: '7일 이내 복귀 / 전체 예정',
    hw_1st: '1차 입력 완료 / 오늘 대상',
    hw_2nd: '2차 대상 / 오늘 대상',
    hw_next: '입력 시작한 반 / 오늘 수업 반',
    test_1st: '1차 입력 완료 / 오늘 대상',
    test_2nd: '2차 대상 / 오늘 대상',
    auto_hw_missing: '미제출 숙제 인원',
    auto_retake: '재시 필요 인원',
    auto_unchecked: '출결 미체크 인원',
};

function _countBadge(key, count, total) {
    if (count <= 0 && total <= 0) return '';
    const tooltip = COUNT_TOOLTIPS[key] ? ` title="${escAttr(COUNT_TOOLTIPS[key])}"` : '';
    return `<span class="nav-l2-count"${tooltip}>${total > 0 ? `${count}/${total}` : count}</span>`;
}

export function renderSubFilters() {
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
                { key: 'departure_check', label: '하원점검' }
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
        state._subFilterBase = null; // 캐시 초기화
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
            const badge = _countBadge(f.key, count, total);
            html += `<div class="nav-l2 ${parentClass} ${isExpanded} ${isActive}" data-filter="${f.key}" onclick="setSubFilter('${f.key}')">
                ${esc(f.label)}
                ${badge}
                ${expandIcon}
            </div>`;
            if (f.children && parentOrChildActive) {
                for (const child of f.children) {
                    const childActive = state.currentSubFilter.has(child.key) ? 'active' : '';
                    const { count: cc, total: ct } = getSubFilterCount(child.key);
                    const childBadge = _countBadge(child.key, cc, ct);
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

export function renderBranchFilter() {
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
    // attendance에서만 휴원 학생을 별도 섹션으로 표시하므로 카운트에 포함.
    // 그 외 카테고리(숙제·테스트·행정)에서는 휴원 학생이 화면에서 빠지므로 카운트도 제외.
    const includeOnLeave = state.currentCategory === 'attendance';
    const active = state.allStudents.filter(s => {
        if (isWithdrawnAt(s, state.selectedDate)) return false;
        if (!includeOnLeave && isOnLeaveAt(s, state.selectedDate)) return false;
        return getActiveEnrollments(s, state.selectedDate).some(e => e.day.includes(dayName));
    });

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
                const levelCount = branchStudents.filter(s => studentLevel(s) === level).length;
                const isLevelActive = state.selectedBranchLevel === level;
                const levelActive = isLevelActive ? 'active' : '';
                html += `<div class="nav-l2 nav-l3 ${levelActive}" data-filter="${b.key}_${level}" onclick="setBranchLevel('${level}')">
                    ${esc(level)}
                    ${levelCount > 0 ? `<span class="nav-l2-count">${levelCount}</span>` : ''}
                </div>`;
                if (isLevelActive) {
                    for (const c of _getClassesForBranchLevel(b.key, level)) {
                        const l4Active = state.selectedClassCode === c.code ? 'active' : '';
                        const typeLabel = CLASS_MODE_LABELS[c.mode] || c.mode;
                        html += `<div class="nav-l2 nav-l3 nav-l4 ${l4Active}" onclick="setBranchClass('${escAttr(c.mode)}', '${escAttr(c.code)}')">
                            <span style="margin-left:12px;">${esc(c.display)}</span>
                            <span style="opacity:.55;font-size:10px;margin-left:6px;">${typeLabel}</span>
                            ${c.count > 0 ? `<span class="nav-l2-count">${c.count}</span>` : ''}
                        </div>`;
                    }
                }
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

function _renderL3Chip(code, displayLabel, count, mode) {
    const isActive = state.selectedClassCode === code ? 'active' : '';
    const isDeleteMode = state._classDeleteMode;
    const selectKey = `${mode}|${code}`;
    const isSelected = isDeleteMode && state._classDeleteSelected.has(selectKey);
    const onclick = isDeleteMode
        ? `window.toggleClassDeleteSelect('${escAttr(mode)}', '${escAttr(code)}')`
        : `setClassCode('${escAttr(code)}')`;
    const checkbox = isDeleteMode
        ? `<span class="material-symbols-outlined" style="font-size:16px;margin-right:4px;color:${isSelected ? '#dc2626' : '#9ca3af'};">${isSelected ? 'check_box' : 'check_box_outline_blank'}</span>`
        : '';
    const selectedStyle = isSelected ? 'background:#fef2f2;color:#b91c1c;' : '';
    return `<div class="nav-l2 nav-l3 ${isActive}" style="${selectedStyle}" onclick="${onclick}">
        ${checkbox}${esc(displayLabel)}${count > 0 ? `<span class="nav-l2-count">${count}</span>` : ''}
    </div>`;
}

export function renderClassCodeFilter() {
    let container = document.getElementById('nav-class-l2');
    const classL1 = document.querySelector('.nav-l1[data-category="class_mgmt"]');
    if (!classL1) return;

    if (!container) {
        container = document.createElement('div');
        container.id = 'nav-class-l2';
        container.className = 'nav-l2-group';
        classL1.after(container);
    }

    const { regular, naesin, teukang, free } = _getAllClassCodes();

    const regExpanded = state._classMgmtMode === 'regular';
    const freeExpanded = state._classMgmtMode === 'free';
    const naeExpanded = state._classMgmtMode === 'naesin';
    const tekExpanded = state._classMgmtMode === 'teukang';

    let html = '';

    const isDeleteMode = state._classDeleteMode;
    const selectedCount = state._classDeleteSelected.size;
    html += `<div class="nav-l2-actions" style="padding:6px 8px;display:flex;gap:6px;flex-wrap:nowrap;border-bottom:1px solid var(--border);">
        <button class="btn btn-secondary btn-sm" style="font-size:11px;flex:1;white-space:nowrap;padding:4px 6px;" onclick="window.toggleClassDeleteMode()">
            ${isDeleteMode ? '선택 취소' : '선택 모드'}
        </button>
    </div>`;
    if (isDeleteMode && selectedCount > 0) {
        html += `<div style="padding:6px 8px;">
            <button class="btn" style="background:#dc2626;color:#fff;font-size:11px;width:100%;" onclick="window.bulkDeleteSelectedClasses()">
                선택 ${selectedCount}개 일괄 삭제
            </button>
        </div>`;
    }

    // 정규 L2
    html += `<div class="nav-l2 l2-parent ${regExpanded ? 'active l2-expanded' : ''}" onclick="window.setClassMgmtMode('regular')">
        정규<span class="nav-l2-count">${regular.length}</span>
        <span class="material-symbols-outlined l2-expand-icon">${regExpanded ? 'expand_less' : 'expand_more'}</span>
    </div>`;
    if (regExpanded) {
        html += regular.map(code => _renderL3Chip(code, code, getClassMgmtCount(code), 'regular')).join('');
    }

    // 자유학기 L2
    html += `<div class="nav-l2 l2-parent ${freeExpanded ? 'active l2-expanded' : ''}" onclick="window.setClassMgmtMode('free')">
        자유학기<span class="nav-l2-count">${free.length}</span>
        <span class="material-symbols-outlined l2-expand-icon">${freeExpanded ? 'expand_less' : 'expand_more'}</span>
    </div>`;
    if (freeExpanded) {
        html += free.map(({ code, count }) => _renderL3Chip(code, code, count, 'free')).join('');
    }

    // 내신 L2
    html += `<div class="nav-l2 l2-parent ${naeExpanded ? 'active l2-expanded' : ''}" onclick="window.setClassMgmtMode('naesin')">
        내신<span class="nav-l2-count">${naesin.length}</span>
        <span class="material-symbols-outlined l2-expand-icon">${naeExpanded ? 'expand_less' : 'expand_more'}</span>
    </div>`;
    if (naeExpanded) {
        html += naesin.map(({ code, displayCode, count }) => _renderL3Chip(code, displayCode, count, 'naesin')).join('');
    }

    // 특강 L2
    html += `<div class="nav-l2 l2-parent ${tekExpanded ? 'active l2-expanded' : ''}" onclick="window.setClassMgmtMode('teukang')">
        특강<span class="nav-l2-count">${teukang.length}</span>
        <span class="material-symbols-outlined l2-expand-icon">${tekExpanded ? 'expand_less' : 'expand_more'}</span>
    </div>`;
    if (tekExpanded) {
        html += teukang.map(code => _renderL3Chip(code, code, getTeukangClassStudents(code).length, 'teukang')).join('');
    }

    container.innerHTML = html;

    const isExpanded = classL1.classList.contains('expanded');
    container.style.display = isExpanded ? '' : 'none';

    const icon = classL1.querySelector('.nav-l1-expand');
    if (icon) icon.textContent = isExpanded ? 'expand_less' : 'expand_more';

    // 소속 트리에서 L4 반을 클릭하면 selectedBranchLevel + selectedClassCode가 동시에 활성된다.
    // 그 경우 반 설정 L1을 시각적으로 활성화하지 않아 트리 간 혼동을 방지.
    // (setCategory는 branch/class_mgmt L1 클릭 시 카테고리를 바꾸지 않으므로 currentCategory로 구별 불가.)
    const isL4Selection = !!(state.selectedBranchLevel && state.selectedClassCode);
    classL1.classList.toggle('has-filter', !!state.selectedClassCode && !isL4Selection);
}

export function toggleClassDeleteMode() {
    state._classDeleteMode = !state._classDeleteMode;
    state._classDeleteSelected.clear();
    renderClassCodeFilter();
}

export function toggleClassDeleteSelect(mode, code) {
    const key = `${mode}|${code}`;
    if (state._classDeleteSelected.has(key)) state._classDeleteSelected.delete(key);
    else state._classDeleteSelected.add(key);
    renderClassCodeFilter();
}

export function setClassMgmtMode(mode) {
    state._classMgmtMode = (state._classMgmtMode === mode) ? null : mode; // 토글
    state._classFilterSource = state._classMgmtMode ? 'classmgmt' : null; // 반설정 트리 = 반 관리 맥락 (등원예정 포함)
    state.selectedClassCode = null;
    // 반설정 모드 진입 시 소속 필터 해제 (반설정은 모든 학생을 다룸)
    if (state._classMgmtMode) {
        state.selectedBranch = null;
        state.selectedBranchLevel = null;
    }
    renderClassCodeFilter();
    renderBranchFilter();
    renderFilterChips();
    renderStudentDetail(null);
    renderListPanel();
}

export function setClassCode(code) {
    state.selectedClassCode = state.selectedClassCode === code ? null : code;
    state._classFilterSource = 'classmgmt'; // 반설정 트리 = 반 관리 맥락 (등원예정 포함)
    state.selectedStudentId = null; // 반 변경 시 학생 선택 해제
    // 반설정에서 반 선택 시 소속 필터 해제 (반설정은 모든 학생을 다룸)
    if (state.selectedClassCode) {
        state.selectedBranch = null;
        state.selectedBranchLevel = null;
    }

    renderClassCodeFilter();
    renderBranchFilter();
    renderFilterChips();
    renderSubFilters();

    renderListPanel();
    // 반 해제 시 디테일 초기화
    if (!state.selectedClassCode) {
        renderStudentDetail(null);
    }
}

export function setBranch(branchKey) {
    if (state.selectedBranch === branchKey) {
        state.selectedBranch = null;
        state.selectedBranchLevel = null;
    } else {
        state.selectedBranch = branchKey;
        state.selectedBranchLevel = null;
    }
    // 단지 전환 시 L4 반 선택 해제
    state._classMgmtMode = null;
    state.selectedClassCode = null;
    state.selectedStudentId = null;

    renderBranchFilter();
    renderSubFilters();
    renderListPanel();
    renderStudentDetail(null);
}

export function setBranchLevel(level) {
    state.selectedBranchLevel = state.selectedBranchLevel === level ? null : level;
    // 학부 전환 시 이전 L4 반 선택 해제
    state._classMgmtMode = null;
    state.selectedClassCode = null;
    state.selectedStudentId = null;

    renderBranchFilter();
    renderSubFilters();
    renderListPanel();
    renderStudentDetail(null);
}

// L4(반) chip 클릭. 소속 트리에서 호출되며, 반 상세 편집 UI는 띄우지 않고
// 학생 리스트만 그 반으로 필터링한다 (반 상세 가드는 renderStudentDetail에서 처리).
export function setBranchClass(mode, code) {
    const isSame = state._classMgmtMode === mode && state.selectedClassCode === code;
    state._classMgmtMode = isSame ? null : mode;
    state.selectedClassCode = isSame ? null : code;
    state._classFilterSource = isSame ? null : 'branch'; // 소속 트리 = 출결 맥락 (등원예정 제외)
    state.selectedStudentId = null;

    renderBranchFilter();
    renderFilterChips();
    renderSubFilters();
    renderListPanel();
    renderStudentDetail(null);
}


export function renderFilterChips() {
    const container = document.getElementById('filter-chips');
    if (!container) return;

    const categoryLabels = { attendance: '출결', homework: '숙제', test: '테스트', automation: '자동화', admin: '행정' };
    const subFilterLabels = {
        scheduled_visit: '비정규', pre_arrival: '정규', present: '출석', late: '지각', absent: '결석', other: '기타',
        departure_check: '하원점검', enroll_pending: '등원예정',
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

    // 필터가 걸린 채 검색 중이면 검색 범위 안내 배너 표시 (검색은 의도적으로 현재 필터 안에서 동작)
    // 반 필터는 검색 중 적용되지 않으므로(list-view.js) 배너 라벨에서 제외
    const scopeBanner = document.getElementById('search-scope-banner');
    if (scopeBanner) {
        const scopeChips = chips.filter(c => c.onRemove !== 'clearClassCode');
        const show = !!state.searchQuery?.trim() && scopeChips.length > 0;
        scopeBanner.style.display = show ? '' : 'none';
        if (show) {
            document.getElementById('search-scope-text').textContent =
                `${scopeChips.map(c => c.label).join(' · ')} 내 검색 결과`;
        }
    }
}

export function removeFilterChip(action) {
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

export function clearAllFilters() {
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

export function setSubFilter(filterKey) {
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

// 캐시: renderSubFilters에서 탭당 반복 호출 시 base list 재계산 방지
// (_subFilterBase는 state.js로 승격 — 클러스터 1·3 순환 해소)

function _getSubFilterBase() {
    if (state._subFilterBase) return state._subFilterBase;

    const dayName = getDayName(state.selectedDate);
    let todayStudents = state.allStudents.filter(s =>
        !isWithdrawnAt(s, state.selectedDate) && getActiveEnrollments(s, state.selectedDate).some(e =>
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
    state._subFilterBase = { todayStudents, visitStudentIds, regularOnly };
    return state._subFilterBase;
}

export function getSubFilterCount(filterKey) {
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
                const departed = realRegular.filter(s => normalizeAttendanceLabel(state.dailyRecords[s.docId]?.departure?.status) === ATTENDANCE_ACTIONS.departure).length;
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
