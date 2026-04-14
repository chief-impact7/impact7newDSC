// visit-list-render.js
// daily-ops.js에서 분리된 비정규(Scheduled Visit) 집계 및 리스트 렌더링 모듈.
// 역방향 의존: daily-ops.js가 `getScheduledVisits`, `getEnrollPendingVisits`,
// `renderScheduledVisitList`, `renderEnrollPendingOnly`, `renderEnrollPendingSection`,
// `renderDepartureCheckList`, `clearVisitCache`를 import하여 사용한다.
// Injection: `getStudentChecklistStatus`, `renderFilterChips`는 daily-ops.js에서 주입.

import {
    state,
    SV_SOURCE_MAP, SOURCE_PRIORITY, SOURCE_SHORT, KOREAN_CHAR_RE
} from './state.js';
import {
    esc, escAttr, formatTime12h,
    _attToggleClass, _toVisitStatus, _visitBtnStyles, _visitLabel,
    _stripYear
} from './ui-utils.js';
import {
    matchesBranchFilter, enrollmentCode
} from './student-helpers.js';
import {
    todayStr, getDayName, studentShortLabel
} from './src/shared/firestore-helpers.js';

// ─── Injection slots ────────────────────────────────────────────────────────
let getStudentChecklistStatus, renderFilterChips;

export function initVisitRenderDeps(deps) {
    ({ getStudentChecklistStatus, renderFilterChips } = deps);
}

// ─── Module-local caches ────────────────────────────────────────────────────
let _enrollPendingCache = null;
let _cachedToday = '';

export function clearVisitCache() {
    _enrollPendingCache = null;
    state._scheduledVisitsCache = null;
}

// ─── Aggregation ────────────────────────────────────────────────────────────

export function getScheduledVisits() {
    if (state._scheduledVisitsCache) return state._scheduledVisitsCache;
    const visits = [];
    // 이메일/아이디에서 이름 prefix 추출: "홍길동" → "길동", "Iris Lee" → "Iris", "chief" → "chief"
    const callerName = (emailOrId) => {
        if (!emailOrId) return '';
        const id = emailOrId.split('@')[0];
        const teacher = state.teachersList.find(tc => tc.email === emailOrId || tc.email.split('@')[0] === id);
        const name = teacher?.display_name || id;
        if (KOREAN_CHAR_RE.test(name)) return name.length >= 2 ? name.slice(1) : name;
        return name.split(' ')[0];
    };

    // 1) 진단평가 (temp_attendance)
    for (const ta of state.tempAttendances) {
        visits.push({
            id: `temp_${ta.docId}`,
            source: 'temp',
            sourceLabel: '진단평가',
            sourceColor: '#7c3aed',
            studentId: null,
            name: ta.name || '(이름 없음)',
            time: ta.temp_time || '',
            detail: studentShortLabel(ta) || '',
            status: (ta.visit_status === '완료' || ta.visit_status === '기타') ? 'completed' : 'pending',
            visitStatus: _toVisitStatus(ta.visit_status),
            caller: callerName(ta.created_by),
            completedBy: callerName(ta.completed_by),
            completedAt: ta.completed_at || '',
            docId: ta.docId
        });
    }

    // 학생 이름 조회용 Map (동명이인 구분을 위해 실시간 이름 사용)
    const studentNameMap = new Map(state.allStudents.map(s => [s.docId, s.name]));

    // 2) 숙제미통과 등원 (state.hwFailTasks)
    const today = todayStr();
    const isToday = state.selectedDate === today;
    for (const t of state.hwFailTasks) {
        if (t.type !== '등원' || (t.status !== 'pending' && t.status !== '완료' && t.status !== '기타')) continue;
        // 해당 날짜 task이거나, 오늘 볼 때 지연된(overdue) pending task 포함
        const isScheduledToday = t.scheduled_date === state.selectedDate;
        const isOverdue = isToday && t.status === 'pending' && t.scheduled_date && t.scheduled_date < today;
        if (!isScheduledToday && !isOverdue) continue;
        visits.push({
            id: `hw_fail_${t.docId}`,
            source: 'hw_fail',
            sourceLabel: '숙제미통과',
            sourceColor: '#dc2626',
            studentId: t.student_id,
            name: studentNameMap.get(t.student_id) || t.student_name || t.student_id,
            time: t.scheduled_time || '',
            detail: `${t.domain || ''} (${_stripYear(t.source_date)})`,
            status: (t.status === '완료' || t.status === '기타') ? 'completed' : 'pending',
            visitStatus: _toVisitStatus(t.status),
            caller: callerName(t.created_by || ''),
            completedBy: callerName(t.completed_by || ''),
            completedAt: t.completed_at || '',
            docId: t.docId,
            overdue: isOverdue,
            originalDate: isOverdue ? t.scheduled_date : null
        });
    }

    // 3) 테스트미통과 등원 (state.testFailTasks)
    for (const t of state.testFailTasks) {
        if (t.type !== '등원' || (t.status !== 'pending' && t.status !== '완료' && t.status !== '기타')) continue;
        const isScheduledToday = t.scheduled_date === state.selectedDate;
        const isOverdue = isToday && t.status === 'pending' && t.scheduled_date && t.scheduled_date < today;
        if (!isScheduledToday && !isOverdue) continue;
        visits.push({
            id: `test_fail_${t.docId}`,
            source: 'test_fail',
            sourceLabel: '테스트미통과',
            sourceColor: '#ea580c',
            studentId: t.student_id,
            name: studentNameMap.get(t.student_id) || t.student_name || t.student_id,
            time: t.scheduled_time || '',
            detail: `${t.item || t.domain || ''} (${_stripYear(t.source_date)})`,
            status: (t.status === '완료' || t.status === '기타') ? 'completed' : 'pending',
            visitStatus: _toVisitStatus(t.status),
            caller: callerName(t.created_by || ''),
            completedBy: callerName(t.completed_by || ''),
            completedAt: t.completed_at || '',
            docId: t.docId,
            overdue: isOverdue,
            originalDate: isOverdue ? t.scheduled_date : null
        });
    }

    // 4) 클리닉 (state.dailyRecords[*].extra_visit)
    for (const [sid, rec] of Object.entries(state.dailyRecords)) {
        const ev = rec.extra_visit;
        if (!ev || ev.date !== state.selectedDate) continue;
        const student = state.allStudents.find(s => s.docId === sid);
        visits.push({
            id: `extra_${sid}`,
            source: 'extra',
            sourceLabel: '클리닉',
            sourceColor: '#2563eb',
            studentId: sid,
            name: student?.name || sid,
            time: ev.time || '',
            detail: ev.reason || '',
            status: (ev.visit_status === '완료' || ev.visit_status === '기타') ? 'completed' : 'pending',
            visitStatus: _toVisitStatus(ev.visit_status),
            caller: callerName(rec.updated_by),
            completedBy: callerName(ev.completed_by),
            completedAt: ev.completed_at || '',
            docId: sid
        });
    }

    // 5) 결석보충 (state.absenceRecords) — 등원예정은 정규 쪽으로 이동
    for (const r of state.absenceRecords) {
        if (r.resolution !== '보충' || r.makeup_date !== state.selectedDate || r.status !== 'open') continue;
        visits.push({
            id: `absence_makeup_${r.docId}`,
            source: 'absence_makeup',
            sourceLabel: '결석보충',
            sourceColor: '#dc2626',
            studentId: r.student_id,
            name: studentNameMap.get(r.student_id) || r.student_name || r.student_id,
            time: r.makeup_time || '',
            detail: `${r.class_code || ''} (${_stripYear(r.absence_date)})`,
            status: r.makeup_status === '완료' ? 'completed' : 'pending',
            visitStatus: r.makeup_status === '완료' ? '완료' : (r.makeup_status === '미등원' ? '미등원' : ''),
            caller: '',
            completedBy: r.makeup_completed_by ? (r.makeup_completed_by.split('@')[0]) : '',
            completedAt: r.makeup_completed_at || '',
            docId: r.docId
        });
    }

    // 소속 필터 적용 (글로벌 branch 필터)
    const filtered = (state.selectedBranch || state.selectedBranchLevel) ? visits.filter(v => {
        if (!v.studentId) return true; // 진단평가 등 학생 미연동 항목은 항상 포함
        const student = state.allStudents.find(s => s.docId === v.studentId);
        return student ? matchesBranchFilter(student) : true;
    }) : visits;

    // 시간임박순 정렬
    filtered.sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));

    state._scheduledVisitsCache = filtered;
    return filtered;
}

export function getEnrollPendingVisits() {
    if (_enrollPendingCache) return _enrollPendingCache;
    const visits = [];
    for (const s of state.allStudents) {
        if (s.status !== '등원예정') continue;
        if (!matchesBranchFilter(s)) continue;
        const todaysEnrolls = (s.enrollments || []).filter(e => e.start_date === state.selectedDate);
        if (!todaysEnrolls.length) continue;
        visits.push({
            id: `enroll_${s.docId}`,
            source: 'enroll_pending',
            sourceLabel: '등원예정',
            sourceColor: '#059669',
            studentId: s.docId,
            name: s.name || s.docId,
            time: '',
            detail: todaysEnrolls.map(e => `${e.level_symbol || ''}${e.class_number || ''}`).filter(Boolean).join(', '),
            status: 'pending',
            caller: '',
            completedBy: '',
            completedAt: '',
            docId: s.docId
        });
    }
    _enrollPendingCache = visits;
    return visits;
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function formatCompletedBadge(completedBy, completedAt) {
    if (!completedBy) return '';
    let timeStr = '';
    if (completedAt) {
        const d = new Date(completedAt);
        if (!isNaN(d)) timeStr = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
    return `<span class="visit-caller-badge">(${esc(completedBy)}${timeStr ? ': ' + timeStr : ''} 확인)</span>`;
}

function groupVisitsByStudent(visits) {
    const grouped = {};   // studentId → visit[]
    const ungrouped = []; // studentId===null (진단평가 등)
    for (const v of visits) {
        if (!v.studentId) { ungrouped.push(v); continue; }
        if (!grouped[v.studentId]) grouped[v.studentId] = [];
        grouped[v.studentId].push(v);
    }
    // 각 그룹 내부: 소스 순서 유지 (extra → temp → hw_fail → test_fail → absence_makeup)
    for (const sid of Object.keys(grouped)) {
        grouped[sid].sort((a, b) => (SOURCE_PRIORITY[a.source] ?? 9) - (SOURCE_PRIORITY[b.source] ?? 9));
    }
    // 그룹 목록: 가장 빠른 시간 기준 정렬
    const groups = Object.entries(grouped).sort((a, b) => {
        const timeA = a[1][0]?.time || '99:99';
        const timeB = b[1][0]?.time || '99:99';
        return timeA.localeCompare(timeB);
    });
    return { groups, ungrouped };
}

function renderVisitConfirmBtn(v) {
    const isCompleted = v.status === 'completed';
    if (isCompleted) {
        const vs = _visitLabel(v.visitStatus || '완료', v.source);
        const { cls, sty } = _visitBtnStyles(vs);
        const isIncomplete = v.visitStatus === '미완료' || v.visitStatus === 'pending';
        let rescheduleBtn = '';
        if (isIncomplete && v.source === 'temp') {
            rescheduleBtn = `<button class="toggle-btn" style="padding:2px 10px;font-size:12px;min-width:auto;margin-left:4px;background:#2563eb;color:#fff;border-color:#2563eb;" onclick="event.stopPropagation(); _showDiagnosticActionModal('${escAttr(v.docId)}')">재지정</button>`;
        } else if (isIncomplete && (v.source === 'hw_fail' || v.source === 'test_fail')) {
            rescheduleBtn = `<button class="toggle-btn" style="padding:2px 10px;font-size:12px;min-width:auto;margin-left:4px;background:#2563eb;color:#fff;border-color:#2563eb;" onclick="event.stopPropagation(); rescheduleVisit('${escAttr(v.source)}', '${escAttr(v.docId)}')">재지정</button>`;
        }
        return `<button class="toggle-btn ${cls}" style="${sty}pointer-events:none;opacity:0.7;">${esc(vs)}</button>${rescheduleBtn}<button class="toggle-btn" style="padding:2px 10px;font-size:12px;min-width:auto;margin-left:4px;color:var(--text-sec);border-color:var(--border);" onclick="event.stopPropagation(); resetScheduledVisit('${escAttr(v.source)}', '${escAttr(v.docId)}', ${v.studentId ? `'${escAttr(v.studentId)}'` : 'null'})">초기화</button>`;
    }
    if (v.overdue) {
        const vs = _visitLabel(v.visitStatus || '미완료', v.source);
        const { cls, sty } = _visitBtnStyles(vs);
        const sid = v.studentId ? `'${escAttr(v.studentId)}'` : 'null';
        return `<button class="toggle-btn" style="padding:2px 10px;font-size:12px;min-width:auto;background:#2563eb;color:#fff;border-color:#2563eb;" onclick="event.stopPropagation(); rescheduleVisit('${escAttr(v.source)}', '${escAttr(v.docId)}')">재지정</button><button class="toggle-btn ${cls}" data-visit-id="${escAttr(v.docId)}" style="${sty}margin-left:4px;" onclick="event.stopPropagation(); cycleVisitStatus('${escAttr(v.source)}', '${escAttr(v.docId)}', ${sid})">${esc(vs)}</button><button class="toggle-btn" style="padding:2px 10px;font-size:12px;min-width:auto;margin-left:4px;" onclick="event.stopPropagation(); confirmVisitStatus('${escAttr(v.docId)}')">확인</button>`;
    }
    // pending (normal)
    const vs = _visitLabel(v.visitStatus || '미완료', v.source);
    const { cls, sty } = _visitBtnStyles(vs);
    const sid = v.studentId ? `'${escAttr(v.studentId)}'` : 'null';
    return `<button class="toggle-btn ${cls}" data-visit-id="${escAttr(v.docId)}" style="${sty}" onclick="event.stopPropagation(); cycleVisitStatus('${escAttr(v.source)}', '${escAttr(v.docId)}', ${sid})">${esc(vs)}</button><button class="toggle-btn" style="padding:2px 10px;font-size:12px;min-width:auto;margin-left:4px;" onclick="event.stopPropagation(); confirmVisitStatus('${escAttr(v.docId)}')">확인</button>`;
}

function renderVisitSubitem(v) {
    const isCompleted = v.status === 'completed';
    const completedClass = isCompleted ? 'visit-completed' : '';
    const overdueBadge = v.overdue ? `<span class="visit-overdue-badge">지연 ${_stripYear(v.originalDate)}</span>` : '';
    const callerBadge = v.caller ? `<span class="visit-caller-badge">(${esc(v.caller)})</span>` : '';
    const completedInfo = isCompleted ? formatCompletedBadge(v.completedBy, v.completedAt) : '';
    const confirmBtn = renderVisitConfirmBtn(v);
    // 날짜 표시 (overdue가 아닌 경우에도 originalDate가 오늘이 아니면 표시)
    let dateInfo = '';
    if (v.originalDate && v.originalDate !== _cachedToday) {
        dateInfo = ` (${_stripYear(v.originalDate)})`;
    }

    return `<div class="visit-group-subitem ${completedClass}">
        <span class="visit-source-badge" style="background:${v.sourceColor};flex-shrink:0;">${esc(v.sourceLabel)}</span>
        <span class="visit-subitem-detail">${overdueBadge}${esc(v.detail)}${dateInfo} ${callerBadge}${completedInfo}</span>
        <span class="visit-subitem-actions">${confirmBtn}</span>
    </div>`;
}

function renderVisitGroup(studentId, visits) {
    const name = visits[0].name;
    const isCompleted = visits.every(v => v.status === 'completed');
    const completedClass = isCompleted ? 'visit-completed' : '';

    // 클릭 → 학생 상세
    const clickHandler = `onclick="state.selectedStudentId='${escAttr(studentId)}'; renderStudentDetail('${escAttr(studentId)}'); document.querySelectorAll('.list-item').forEach(el=>el.classList.remove('active')); this.closest('.visit-group').classList.add('active');"`;

    // 소스 배지 모음 (중복 제거)
    const uniqueSources = [...new Set(visits.map(v => v.source))];
    const sourceBadges = uniqueSources.map(src => {
        const v = visits.find(x => x.source === src);
        return `<span class="visit-source-badge" style="background:${v.sourceColor};font-size:9px;">${esc(SOURCE_SHORT[src] || src)}</span>`;
    }).join('');

    // 시간 블록 + 출결 토글 (학생 단위)
    let timeHtml = '';
    const rec = state.dailyRecords[studentId];
    const arrivalTime = rec?.arrival_time;
    if (arrivalTime) {
        timeHtml = `<div class="item-time-block arrived">
            <span class="item-time-label">등원</span>
            <span class="item-time-value">${esc(formatTime12h(arrivalTime))}</span>
        </div>`;
    } else if (visits[0].time) {
        timeHtml = `<div class="item-time-block">
            <span class="item-time-label">예정</span>
            <span class="item-time-value">${esc(formatTime12h(visits[0].time))}</span>
        </div>`;
    }
    const { display: currentDisplay, cls: activeClass } = _attToggleClass(rec?.attendance?.status || '미확인');
    const toggleHtml = `<button class="toggle-btn ${activeClass}" style="min-width:48px;" onclick="event.stopPropagation(); cycleVisitAttendance('${escAttr(studentId)}')">${currentDisplay}</button>`;

    const subitemsHtml = visits.map(renderVisitSubitem).join('');

    return `<div class="visit-group ${completedClass}" data-id="${escAttr(studentId)}">
        <div class="visit-group-header" ${clickHandler} style="cursor:pointer;">
            <div class="item-info">
                <span class="item-title">${esc(name)}</span>
                <span class="item-desc">${sourceBadges} <span style="font-size:11px;color:var(--text-sec);">${visits.length}건</span></span>
            </div>
            ${timeHtml}
            ${toggleHtml}
        </div>
        <div class="visit-group-items">${subitemsHtml}</div>
    </div>`;
}

export function renderScheduledVisitList() {
    _cachedToday = todayStr();
    let visits = getScheduledVisits();

    // L3 필터 적용
    const activeL3 = [...state.currentSubFilter].find(k => SV_SOURCE_MAP[k]);
    if (activeL3) {
        const sources = SV_SOURCE_MAP[activeL3];
        visits = visits.filter(v => sources.includes(v.source));
    }

    // 검색 필터
    if (state.searchQuery) {
        const q = state.searchQuery.trim().toLowerCase();
        visits = visits.filter(v => v.name?.toLowerCase().includes(q) || v.detail?.toLowerCase().includes(q));
    }

    const container = document.getElementById('list-items');
    const countEl = document.getElementById('list-count');

    // 고유 학생 수 계산
    const uniqueStudentIds = new Set();
    let ungroupedCount = 0;
    for (const v of visits) {
        if (v.studentId) uniqueStudentIds.add(v.studentId);
        else ungroupedCount++;
    }
    const totalStudents = uniqueStudentIds.size + ungroupedCount;

    renderFilterChips();
    countEl.textContent = totalStudents === visits.length
        ? `${visits.length}건`
        : `${totalStudents}명 ${visits.length}건`;

    if (visits.length === 0) {
        container.innerHTML = `<div class="empty-state">
            <span class="material-symbols-outlined">event_available</span>
            <p>비정규 항목이 없습니다</p>
        </div>`;
        return;
    }

    // 등원전 / 등원완료 / 확인완료 분리
    const isPreArrival = (v) => {
        if (!v.studentId) return true; // 비등록(진단평가 등)은 등원전 취급
        const st = state.dailyRecords[v.studentId]?.attendance?.status || '미확인';
        return st === '미확인';
    };
    const pendingVisits = visits.filter(v => v.status === 'pending' && !v.overdue);
    const overdueVisits = visits.filter(v => v.status === 'pending' && v.overdue);
    const completedVisits = visits.filter(v => v.status === 'completed');
    const preArrival = pendingVisits.filter(v => isPreArrival(v));
    const arrived = pendingVisits.filter(v => !isPreArrival(v));

    // 단일 항목 렌더 (1건 학생 + ungrouped)
    const renderVisitItem = (v) => {
        const isCompleted = v.status === 'completed';
        const completedClass = isCompleted ? 'visit-completed' : '';
        const clickHandler = v.studentId
            ? `onclick="state.selectedStudentId='${escAttr(v.studentId)}'; renderStudentDetail('${escAttr(v.studentId)}'); document.querySelectorAll('.list-item').forEach(el=>el.classList.remove('active')); this.classList.add('active');"`
            : (v.source === 'temp' ? `onclick="renderTempAttendanceDetail('${escAttr(v.docId)}'); document.querySelectorAll('.list-item').forEach(el=>el.classList.remove('active')); this.classList.add('active');"` : '');
        const guestBadge = !v.studentId ? '<span class="visit-guest-badge">비등록</span>' : '';
        const overdueBadge = v.overdue ? `<span class="visit-overdue-badge">지연 ${_stripYear(v.originalDate)}</span>` : '';
        const callerBadge = v.caller ? `<span class="visit-caller-badge">(${esc(v.caller)})</span>` : '';
        const completedInfo = isCompleted ? formatCompletedBadge(v.completedBy, v.completedAt) : '';
        const dataId = v.studentId || v.id;

        let timeHtml = '';
        let toggleHtml = '';
        const rec = v.studentId ? state.dailyRecords[v.studentId] : null;
        const arrivalTime = rec?.arrival_time;
        if (arrivalTime) {
            timeHtml = `<div class="item-time-block arrived">
                <span class="item-time-label">등원</span>
                <span class="item-time-value">${esc(formatTime12h(arrivalTime))}</span>
            </div>`;
        } else if (v.time) {
            timeHtml = `<div class="item-time-block">
                <span class="item-time-label">예정</span>
                <span class="item-time-value">${esc(formatTime12h(v.time))}</span>
            </div>`;
        }

        if (v.studentId) {
            const { display: currentDisplay, cls: activeClass } = _attToggleClass(rec?.attendance?.status || '미확인');
            toggleHtml = `<button class="toggle-btn ${activeClass}" style="min-width:48px;" onclick="event.stopPropagation(); cycleVisitAttendance('${escAttr(v.studentId)}')">${currentDisplay}</button>`;
        } else if (v.source === 'temp') {
            const ta = state.tempAttendances.find(t => t.docId === v.docId);
            const arrStatus = ta?.temp_arrival || '';
            const arrDisplay = arrStatus === '등원' ? '등원' : arrStatus === '미등원' ? '미등원' : '등원전';
            let activeClass = '';
            if (arrDisplay === '등원') activeClass = 'active-present';
            else if (arrDisplay === '미등원') activeClass = 'active-absent';
            else activeClass = 'active-other';
            toggleHtml = `<button class="toggle-btn ${activeClass}" style="min-width:48px;" onclick="event.stopPropagation(); cycleTempArrival('${escAttr(v.docId)}')">${arrDisplay}</button>`;
        }

        const confirmBtn = renderVisitConfirmBtn(v);

        return `<div class="list-item visit-item ${completedClass}" data-id="${escAttr(dataId)}" ${clickHandler} style="${(v.studentId || v.source === 'temp') ? 'cursor:pointer;' : ''}">
            <div class="item-info">
                <span class="item-title">${esc(v.name)}</span>
                <span class="item-desc"><span class="visit-source-badge" style="background:${v.sourceColor};">${esc(v.sourceLabel)}</span> ${guestBadge}${overdueBadge}</span>
            </div>
            ${timeHtml}
            ${toggleHtml}
            <div class="item-actions">
                <span style="font-size:12px;color:var(--text-sec);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${callerBadge ? callerBadge + ' ' : ''}${esc(v.detail)}${completedInfo ? ' ' + completedInfo : ''}</span>
            </div>
            ${confirmBtn}
        </div>`;
    };

    // 섹션 렌더 헬퍼: 학생별 그룹핑 적용
    const renderVisitSection = (sectionVisits) => {
        const { groups, ungrouped } = groupVisitsByStudent(sectionVisits);
        let out = '';
        for (const [sid, studentVisits] of groups) {
            if (studentVisits.length >= 2) {
                out += renderVisitGroup(sid, studentVisits);
            } else {
                out += renderVisitItem(studentVisits[0]);
            }
        }
        for (const v of ungrouped) {
            out += renderVisitItem(v);
        }
        return out;
    };

    let html = '';
    // 0) 지연 (overdue): 예정일이 지났지만 미완료인 건
    if (overdueVisits.length > 0) {
        html += `<div class="leave-section-divider" style="color:#dc2626;"><span>지연 — 미완료 (${overdueVisits.length}건)</span></div>`;
        html += renderVisitSection(overdueVisits);
    }
    // 1) 등원전: 시간임박순
    if (preArrival.length > 0) {
        html += renderVisitSection(preArrival);
    }
    // 2) 등원완료 (소스별 구분자 제거 → 학생별 그룹핑)
    if (arrived.length > 0) {
        html += `<div class="leave-section-divider"><span>등원 완료 (${arrived.length}건)</span></div>`;
        html += renderVisitSection(arrived);
    }
    // 3) 확인 완료
    if (completedVisits.length > 0) {
        html += `<div class="leave-section-divider"><span>확인 완료 (${completedVisits.length}건)</span></div>`;
        html += renderVisitSection(completedVisits);
    }
    container.innerHTML = html;
}

function renderEnrollPendingItem(v) {
    const clickHandler = `onclick="state.selectedStudentId='${escAttr(v.studentId)}'; renderStudentDetail('${escAttr(v.studentId)}'); document.querySelectorAll('.list-item').forEach(el=>el.classList.remove('active')); this.classList.add('active');"`;
    return `<div class="list-item visit-item" data-id="${escAttr(v.studentId)}" ${clickHandler} style="cursor:pointer;">
        <div class="item-info">
            <span class="item-title">${esc(v.name)}</span>
            <span class="item-desc"><span class="visit-source-badge" style="background:${v.sourceColor};">${esc(v.sourceLabel)}</span> ${esc(v.detail)}</span>
        </div>
    </div>`;
}

export function renderEnrollPendingSection() {
    const visits = getEnrollPendingVisits();
    if (visits.length === 0) return '';
    let html = `<div class="leave-section-divider"><span>등원예정 (${visits.length}건)</span></div>`;
    html += visits.map(renderEnrollPendingItem).join('');
    return html;
}

export function renderEnrollPendingOnly() {
    let visits = getEnrollPendingVisits();
    if (state.searchQuery) {
        const q = state.searchQuery.trim().toLowerCase();
        visits = visits.filter(v => v.name?.toLowerCase().includes(q));
    }
    const container = document.getElementById('list-items');
    const countEl = document.getElementById('list-count');

    renderFilterChips();
    countEl.textContent = `${visits.length}건`;

    if (visits.length === 0) {
        container.innerHTML = `<div class="empty-state">
            <span class="material-symbols-outlined">event_available</span>
            <p>등원예정 학생이 없습니다</p>
        </div>`;
        return;
    }

    container.innerHTML = visits.map(renderEnrollPendingItem).join('');
}

export function renderDepartureCheckList() {
    const dayName = getDayName(state.selectedDate);
    let students = state.allStudents.filter(s =>
        s.status !== '퇴원' && s.enrollments.some(e =>
            e.day.includes(dayName)
        )
    );
    students = students.filter(s => matchesBranchFilter(s));
    if (state.selectedClassCode) students = students.filter(s => s.enrollments.some(e =>
        e.day.includes(dayName) && enrollmentCode(e) === state.selectedClassCode
    ));
    if (state.searchQuery) {
        const q = state.searchQuery.toLowerCase();
        students = students.filter(s =>
            s.name?.toLowerCase().includes(q) ||
            s.enrollments.some(e => enrollmentCode(e).toLowerCase().includes(q))
        );
    }

    // 정렬: 미귀가 먼저, 그 안에서 진행률 높은순
    students.sort((a, b) => {
        const depA = state.dailyRecords[a.docId]?.departure?.status === '귀가' ? 1 : 0;
        const depB = state.dailyRecords[b.docId]?.departure?.status === '귀가' ? 1 : 0;
        if (depA !== depB) return depA - depB;
        const checkA = getStudentChecklistStatus(a.docId);
        const checkB = getStudentChecklistStatus(b.docId);
        const pctA = checkA.filter(i => i.done).length / (checkA.length || 1);
        const pctB = checkB.filter(i => i.done).length / (checkB.length || 1);
        return pctB - pctA; // 진행률 높은순
    });

    const container = document.getElementById('list-items');
    const countEl = document.getElementById('list-count');
    renderFilterChips();
    countEl.textContent = `${students.length}명`;

    if (students.length === 0) {
        container.innerHTML = `<div class="empty-state">
            <span class="material-symbols-outlined">fact_check</span>
            <p>해당하는 학생이 없습니다</p>
        </div>`;
        return;
    }

    container.innerHTML = students.map(s => {
        const items = getStudentChecklistStatus(s.docId);
        const doneCount = items.filter(i => i.done).length;
        const total = items.length;
        const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;
        const isDeparted = state.dailyRecords[s.docId]?.departure?.status === '귀가';
        const isActive = s.docId === state.selectedStudentId ? 'active' : '';

        let statusTag = '';
        if (isDeparted) {
            statusTag = '<span class="departure-status-tag departed">귀가</span>';
        } else if (doneCount > 0) {
            statusTag = '<span class="departure-status-tag in-progress">진행중</span>';
        } else {
            statusTag = '<span class="departure-status-tag not-started">대기</span>';
        }

        return `<div class="list-item departure-list-item ${isActive}" data-id="${s.docId}"
            onclick="state.selectedStudentId='${escAttr(s.docId)}'; renderStudentDetail('${escAttr(s.docId)}'); document.querySelectorAll('.list-item').forEach(el=>el.classList.remove('active')); this.classList.add('active');"
            style="cursor:pointer;${isDeparted ? 'opacity:0.5;' : ''}">
            <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;">
                <span style="font-weight:500;min-width:56px;">${esc(s.name)}</span>
                ${statusTag}
                <span style="font-size:11px;color:var(--text-sec);">${doneCount}/${total}</span>
            </div>
            <div class="departure-list-progress" style="width:60px;">
                <div class="departure-list-progress-fill ${pct === 100 ? 'complete' : ''}" style="width:${pct}%"></div>
            </div>
        </div>`;
    }).join('');
}
