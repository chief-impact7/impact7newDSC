/**
 * naesin.js — 내신 반 관리 모듈
 *
 * 의존성:
 *   - daily-ops.js가 먼저 로드되어 window._naesinState를 노출해야 함
 *   - src/shared/firestore-helpers.js의 getDayName
 */

import { getDayName, studentShortLabel } from './src/shared/firestore-helpers.js';
import { db } from './firebase-config.js';
import { doc, getDoc } from 'firebase/firestore';
import { auditUpdate, auditSet } from './audit.js';
import { NAESIN_OVERRIDE_EXCLUDE } from './student-helpers.js';
import { renderAddStudentCard, createStudentSearcher } from './class-student-search.js';

// ─── State 접근자 ─────────────────────────────────────────────────────────────
function _state() {
    return window._naesinState;
}

// class_settings 기간/스케줄 기반 내신 정보 조회 (공통 헬퍼)
// 반환: { enrollment, naesinCode, csKey, classDays, cs } 또는 null
// naesinCode: 표시용 (branch 없음, 예: "신목중2A")
// csKey:      Firestore 키 (branch 포함, 예: "2단지신목중2A")
function getNaesinInfo(student, selectedDate, dayName) {
    const { classSettings } = _state();

    // 정규 enrollment 확인 (초등 제외는 class_settings에 naesin 기간 없으면 자연히 걸러짐)
    const regularEnroll = (student.enrollments || []).find(
        e => e.class_type !== '내신' && e.class_number
    );
    if (!regularEnroll) return null;

    // 내신 반 매칭: 수동 override 우선, 없으면 자동 유도 (빈 문자열 override = 배제)
    const csKey = window.resolveNaesinCsKey?.(student, regularEnroll);
    if (!csKey) return null;

    // 표시용 반코드: csKey에서 소속 접두사 제거
    const naesinCode = window.displayCodeFromCsKey?.(csKey, window.branchFromStudent?.(student)) || csKey;

    const cs = classSettings?.[csKey];
    if (!cs?.naesin_start || !cs?.naesin_end) return null;
    if (cs.naesin_start > selectedDate || cs.naesin_end < selectedDate) return null;

    const classDays = Object.keys(cs.schedule || {});

    // 오늘 요일이 반 스케줄에 있는지 확인
    if (dayName && !classDays.includes(dayName)) return null;

    // 학생 개별 내신 요일이 설정된 경우, 해당 요일만 표시
    const studentNaesinDays = regularEnroll.naesin_days;
    if (dayName && studentNaesinDays?.length > 0 && !studentNaesinDays.includes(dayName)) return null;

    return { enrollment: regularEnroll, naesinCode, csKey, classDays, cs };
}

// 내신 등원 시간 조회: 개별 override → 반 기본 순 (csKey로 class_settings 조회)
function getNaesinTime(enrollment, csKey, dayName, classSettings) {
    return enrollment.naesin_schedule?.[dayName] ||
           classSettings?.[csKey]?.schedule?.[dayName] || '';
}

// ─── Core functions ───────────────────────────────────────────────────────────

export function getNaesinStudents() {
    const { allStudents, selectedDate, selectedBranch } = _state();
    const dayName = getDayName(selectedDate);
    const result = [];

    for (const student of allStudents) {
        if (student.status === '퇴원') continue;

        // 소속 필터
        if (selectedBranch) {
            const branch = window.branchFromStudent?.(student) || '';
            if (branch && branch !== selectedBranch) continue;
        }

        const info = getNaesinInfo(student, selectedDate, dayName);
        if (!info) continue;

        result.push({
            student,
            enrollment: info.enrollment,
            naesinCode: info.naesinCode,  // 표시용 (branch 없음)
            naesinKey:  info.csKey,       // Firestore 키 (branch 포함)
        });
    }

    return result;
}

export function getNaesinClasses(students) {
    if (!students) students = getNaesinStudents();
    const countMap = new Map();

    for (const { naesinKey, naesinCode } of students) {
        if (!naesinKey) continue;
        if (!countMap.has(naesinKey)) countMap.set(naesinKey, { displayCode: naesinCode, count: 0 });
        countMap.get(naesinKey).count++;
    }

    return [...countMap.entries()]
        .map(([key, { displayCode, count }]) => ({ code: key, displayCode, count }))
        .sort((a, b) => b.count - a.count);
}

// ─── 리스트 패널 렌더링 ───────────────────────────────────────────────────────

/**
 * renderNaesinList()
 *
 * attendance > 내신 L2 선택 시 list-panel에 렌더링:
 *   - L3 반 칩 (코드 + 학생 수), 클릭 시 해당 반 필터 토글
 *   - 학생 목록: 이름, 등원예정 시간, 출결 토글 버튼
 */
export function renderNaesinList() {
    const container = document.getElementById('list-items');
    const countEl = document.getElementById('list-count');
    if (!container) return;

    if (window.renderFilterChips) window.renderFilterChips();

    const { selectedDate, classSettings, dailyRecords } = _state();
    const dayName = getDayName(selectedDate);

    const allItems = getNaesinStudents();
    const classes = getNaesinClasses(allItems);

    // 선택된 반으로 필터 (naesinKey = Firestore 키로 비교)
    const selectedClass = window._selectedNaesinClass || null;
    const items = selectedClass
        ? allItems.filter(({ naesinKey }) => naesinKey === selectedClass)
        : allItems;

    // 카운트 표시
    countEl.textContent = `${items.length}명`;

    // ── L3 반 칩 (code=Firestore키, displayCode=표시용) ──
    const chipHtml = classes.map(({ code, displayCode, count }) => {
        const isActive = code === selectedClass ? 'active' : '';
        return `<button class="nav-l2 ${isActive}" onclick="window.setNaesinClass('${_escAttr(code)}')">${_esc(displayCode)}<span class="nav-l2-count">${count}</span></button>`;
    }).join('');

    // ── 학생 목록 ──
    let listHtml;
    if (items.length === 0) {
        listHtml = `<div class="empty-state">
            <span class="material-symbols-outlined">school</span>
            <p>내신 학생이 없습니다</p>
        </div>`;
    } else {
        listHtml = items.map(({ student, enrollment, naesinCode, naesinKey }) => {
            const sid = student.docId;
            const rec = dailyRecords?.[sid];
            const attStatus = rec?.attendance?.status || '미확인';
            const { display: attDisplay, cls: attCls } = window._attToggleClass
                ? window._attToggleClass(attStatus)
                : { display: attStatus, cls: '' };

            const startTime = getNaesinTime(enrollment, naesinKey, dayName, classSettings);
            const timeText = startTime && window._formatTime12h
                ? window._formatTime12h(startTime)
                : startTime;

            const teacherEmail = classSettings?.[naesinKey]?.teacher || '';
            const teacherName = teacherEmail ? teacherEmail.split('@')[0] : '';
            const subLine = [naesinCode, teacherName].filter(Boolean).join(' · ');

            const isSelected = sid === window.selectedStudentId ? 'active' : '';
            const timeHtml = timeText
                ? `<span class="item-time">${_esc(timeText)}</span>`
                : '';

            return `<div class="list-item ${isSelected}" data-id="${_escAttr(sid)}"
                onclick="window.selectedStudentId='${_escAttr(sid)}'; window.renderStudentDetail?.('${_escAttr(sid)}'); document.querySelectorAll('.list-item').forEach(el=>el.classList.remove('active')); this.classList.add('active');"
                style="cursor:pointer;">
                <div style="display:flex;flex-direction:column;flex:1;min-width:0;">
                    <span class="student-name">${_esc(student.name)}</span>
                    <span style="font-size:11px;color:var(--text-sec);">${_esc(subLine)}</span>
                </div>
                ${timeHtml}
                <button class="toggle-btn ${attCls}" style="min-width:48px;"
                    onclick="event.stopPropagation(); window.toggleAttendance?.('${_escAttr(sid)}', '${_escAttr(attStatus)}')"
                >${_esc(attDisplay)}</button>
            </div>`;
        }).join('');
    }

    container.innerHTML = (chipHtml
        ? `<div class="naesin-class-chips" style="display:flex;flex-wrap:wrap;gap:6px;padding:8px 12px 4px;">${chipHtml}</div>`
        : '') + listHtml;
}

// ─── 반 선택 토글 ─────────────────────────────────────────────────────────────

// daily-ops.js에서 window로 노출된 이스케이프 헬퍼
const _esc = (str) => window._esc(str);
const _escAttr = (str) => window._escAttr(str);

// 내신/특강 공용: 반에서 제거 버튼 카드
function _renderRemoveFromClassCard(studentId, key, displayLabel, handlerName) {
    return `
        <div class="detail-card">
            <button class="btn btn-secondary" style="width:100%;color:var(--danger);border-color:var(--danger);"
                onclick="window.${handlerName}('${_escAttr(studentId)}', '${_escAttr(key)}')">
                <span class="material-symbols-outlined" style="font-size:16px;">person_remove</span>
                ${_esc(displayLabel)} 반에서 제거
            </button>
        </div>`;
}

// ─── 상세패널 렌더링 ──────────────────────────────────────────────────────────

/**
 * renderNaesinDetail(studentId)
 *
 * 내신 모드에서 학생 클릭 시 호출. detail-panel을 내신 전용 UI로 채운다.
 * Sections: 1) 학생 헤더  2) 출결  3) 등원요일·시간  4) 메모  5) 클리닉
 */
export function renderNaesinDetail(studentId) {
    const { allStudents, selectedDate, classSettings, dailyRecords, currentUser } = _state();

    const student = allStudents.find(s => s.docId === studentId);
    if (!student) return;

    const dayName = getDayName(selectedDate);
    const info = getNaesinInfo(student, selectedDate);
    const enrollment = info?.enrollment || {};
    const code   = info?.naesinCode || '';                                      // 표시용
    const csKey  = info?.csKey || (window.branchFromStudent?.(student) || '') + code;  // Firestore 키
    const cs = info?.cs || classSettings?.[csKey] || {};
    const days = Object.keys(cs.schedule || {});
    const rec = dailyRecords[studentId] || {};

    // ── 패널 표시 ──
    document.getElementById('detail-empty').style.display = 'none';
    document.getElementById('detail-content').style.display = '';
    document.getElementById('detail-panel').classList.add('mobile-visible');

    // ── 프로필 헤더 (기존 요소 재활용) ──
    const avatarEl = document.getElementById('profile-avatar');
    const nameEl   = document.getElementById('detail-name');
    const phonesEl = document.getElementById('profile-phones');
    const tagsEl   = document.getElementById('profile-tags');
    if (avatarEl) avatarEl.textContent = (student.name || '?')[0];
    if (nameEl)   nameEl.textContent = student.name || '';
    if (phonesEl) {
        phonesEl.innerHTML =
            `<div class="profile-phone"><span class="phone-label">학생</span>${_esc(student.student_phone || '')}</div>` +
            `<div class="profile-phone"><span class="phone-label">학부모</span>${_esc(student.parent_phone_1 || '')}</div>`;
    }
    if (tagsEl) {
        const teacherEmail = cs.teacher || '';
        const teacherName  = teacherEmail ? teacherEmail.split('@')[0] : '';
        const branch       = window.branchFromStudent?.(student) || '';
        const schoolGrade  = studentShortLabel(student);
        tagsEl.innerHTML =
            `<span class="tag-naesin">내신</span>` +
            (code ? `<span class="tag-class">${_esc(code)}</span>` : '') +
            (schoolGrade ? `<span class="tag">${_esc(schoolGrade)}</span>` : '') +
            (branch     ? `<span class="tag">${_esc(branch)}</span>` : '') +
            (teacherName ? `<span class="tag">담당: ${_esc(teacherName)}</span>` : '');
    }

    // ── Section 2: 출결 ──
    const attStatus = rec?.attendance?.status || '미확인';
    const attClassMap = { '미확인': 'att-active', '출석': 'att-present', '지각': 'att-late', '결석': 'att-absent' };
    const attButtons = [
        { label: '등원전', value: '미확인' },
        { label: '출석',   value: '출석' },
        { label: '지각',   value: '지각' },
        { label: '결석',   value: '결석' },
    ].map(({ label, value }) => {
        const cls = attStatus === value ? attClassMap[value] : '';
        return `<button class="naesin-att-btn ${cls}"
            onclick="window.toggleAttendance('${_escAttr(studentId)}', '${_escAttr(value)}')">${_esc(label)}</button>`;
    }).join('');

    const attHtml = `
        <div class="detail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined">how_to_reg</span>
                출결
            </div>
            <div class="naesin-att-row">${attButtons}</div>
        </div>`;

    // ── Section 3: 등원요일·시간 ──
    const allDays = ['월', '화', '수', '목', '금', '토', '일'];
    const classSched = cs.schedule || {};
    // 학생 개별 내신 요일: naesin_days가 있으면 그것, 없으면 반 전체 요일
    const studentNaesinDays = enrollment.naesin_days?.length > 0 ? enrollment.naesin_days : days;

    // 요일 배지 (반 스케줄에 있는 요일만 표시, 학생 naesin_days 기준 토글)
    const dayTogglesHtml = allDays.map(day => {
        if (!days.includes(day)) return ''; // 반 스케줄에 없는 요일은 표시 안 함
        const isEnrolled = studentNaesinDays.includes(day);
        const isToday  = day === dayName;
        const cls = isToday && isEnrolled ? 'naesin-day-today'
                  : isEnrolled            ? 'naesin-day-active'
                  :                         'naesin-day-inactive';
        return `<div class="naesin-day-badge naesin-day-toggle ${cls}"
            onclick="window.toggleNaesinDay('${_escAttr(studentId)}', '${_escAttr(day)}')"
            title="클릭하여 ${isEnrolled ? '제거' : '추가'}">${_esc(day)}</div>`;
    }).join('');

    // 학생 내신 등록 요일별 시간 목록
    const enrolledDays = days.filter(d => studentNaesinDays.includes(d));
    const timeRowsHtml = enrolledDays.length > 0 ? enrolledDays.map(day => {
        const studentOverride = enrollment.naesin_schedule?.[day];
        const classDefault    = classSched[day];
        let timeText, isOverride, timeLabel;
        if (studentOverride) {
            timeText = studentOverride; isOverride = true;  timeLabel = '(개별)';
        } else if (classDefault) {
            timeText = classDefault;   isOverride = false; timeLabel = '(반 기본)';
        } else {
            timeText = '';             isOverride = false; timeLabel = '';
        }
        const formatted = timeText && window._formatTime12h ? window._formatTime12h(timeText) : (timeText || '—');
        const dayCls    = day === dayName ? 'naesin-day-today' : 'naesin-day-active';
        return `<div class="naesin-schedule-row">
            <div class="naesin-day-badge ${dayCls}">${_esc(day)}</div>
            <span class="naesin-time${isOverride ? ' naesin-time-override' : ''}">${_esc(formatted)}</span>
            <span class="naesin-time-label${isOverride ? ' naesin-time-override' : ''}">${timeLabel}</span>
            <span class="naesin-edit-btn" onclick="window.editNaesinTime('${_escAttr(studentId)}', '${_escAttr(day)}')">수정</span>
        </div>`;
    }).join('') : '<div class="detail-card-empty">등원 요일을 선택하세요</div>';

    // 반 기본 스케줄 요약
    const schedSummary = Object.entries(classSched)
        .map(([d, t]) => `${d} ${window._formatTime12h ? window._formatTime12h(t) : t}`)
        .join(' · ');

    const schedHtml = `
        <div class="detail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined">calendar_today</span>
                등원요일·시간
            </div>
            <div class="naesin-day-chips">${dayTogglesHtml}</div>
            ${timeRowsHtml}
            ${schedSummary ? `<div class="naesin-schedule-footer">반 기본: ${_esc(schedSummary)}</div>` : ''}
        </div>`;

    // ── Section 4: 메모 ──
    const memo    = rec?.naesin_memo || '';
    const memoBy  = rec?.naesin_memo_by || '';
    const memoAt  = rec?.naesin_memo_at || '';
    const memoAtStr = memoAt
        ? (memoAt.toDate ? memoAt.toDate().toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : String(memoAt))
        : '';

    const memoDisplayHtml = memo
        ? `<div class="naesin-memo-item">${_esc(memo)}</div>
           <div class="naesin-memo-meta">${_esc(memoBy ? memoBy.split('@')[0] : '')} ${_esc(memoAtStr)}</div>`
        : `<div class="naesin-memo-empty">메모 없음</div>`;

    const memoHtml = `
        <div class="detail-card">
            <div class="detail-card-title detail-card-title-row">
                <span style="display:flex;align-items:center;gap:6px;">
                    <span class="material-symbols-outlined">sticky_note_2</span>
                    메모
                </span>
                <div class="card-add-btn" onclick="window.toggleNaesinMemoInput('${_escAttr(studentId)}')">+</div>
            </div>
            ${memoDisplayHtml}
            <div id="naesin-memo-input-area-${_escAttr(studentId)}" style="display:none;margin-top:8px;">
                <textarea id="naesin-memo-textarea-${_escAttr(studentId)}" class="naesin-memo-input"
                    placeholder="메모를 입력하세요...">${_esc(memo)}</textarea>
                <button class="naesin-memo-submit" onclick="window.saveNaesinMemo('${_escAttr(studentId)}')">저장</button>
            </div>
        </div>`;

    // ── Section 5: 클리닉 ──
    const extraVisit = rec?.extra_visit;
    const isPendingClinic = window.state?._pendingClinicStudentId === studentId;
    const hasData = !!extraVisit?.date;
    const hasClinic = hasData || isPendingClinic;
    let clinicBodyHtml = '';
    if (hasClinic) {
        if (hasData) {
            const cvDate = extraVisit.date || '';
            const cvTime = extraVisit.time || '';
            const cvReason = extraVisit.reason || '';
            const isDone = extraVisit.status === '완료';
            clinicBodyHtml = `
                <div class="naesin-clinic-item">
                    <span class="naesin-clinic-status ${isDone ? 'clinic-done' : 'clinic-pending'}">${isDone ? '완료' : '예정'}</span>
                    <span>${_esc(cvDate)} ${_esc(cvTime)}</span>
                    ${cvReason ? `<span class="naesin-time-label">· ${_esc(cvReason)}</span>` : ''}
                </div>`;
        } else {
            clinicBodyHtml = window.renderClinicInputs?.(studentId, null, false) || '';
        }
    }

    const clinicHtml = `
        <div class="detail-card">
            <div class="detail-card-title detail-card-title-row">
                <span style="display:flex;align-items:center;gap:6px;">
                    <span class="material-symbols-outlined">schedule</span>
                    클리닉
                </span>
                <div class="card-add-btn" onclick="window.openNaesinClinic('${_escAttr(studentId)}')">+</div>
            </div>
            ${clinicBodyHtml || '<div class="detail-card-empty">클리닉 예정 없음</div>'}
        </div>`;

    // ── 반에서 제거 카드 (내신 활성 학생일 때만) ──
    const removeHtml = csKey ? _renderRemoveFromClassCard(studentId, csKey, code, 'removeFromNaesin') : '';

    // ── 조립 ──
    document.getElementById('detail-cards').innerHTML =
        attHtml + schedHtml + memoHtml + clinicHtml + removeHtml;

    // 탭 상태 (일일현황 탭만 표시)
    const tabsEl = document.getElementById('detail-tabs');
    if (tabsEl) tabsEl.style.display = 'none';
    const reportEl = document.getElementById('report-tab');
    if (reportEl) reportEl.style.display = 'none';
}

// ─── 메모 입력 토글 ──────────────────────────────────────────────────────────
window.toggleNaesinMemoInput = function(studentId) {
    const area = document.getElementById(`naesin-memo-input-area-${studentId}`);
    if (!area) return;
    area.style.display = area.style.display === 'none' ? '' : 'none';
};

// ─── 메모 저장 ───────────────────────────────────────────────────────────────
window.saveNaesinMemo = function(studentId) {
    const ta = document.getElementById(`naesin-memo-textarea-${studentId}`);
    if (!ta) return;
    const { currentUser } = _state();
    const memoText = ta.value.trim();
    window.saveDailyRecord(studentId, {
        naesin_memo:    memoText,
        naesin_memo_by: currentUser?.email || '',
        naesin_memo_at: new Date(),
    });
    // 재렌더
    if (window.renderNaesinDetail) window.renderNaesinDetail(studentId);
};

// ─── 클리닉 추가 ─────────────────────────────────────────────────────────────
// + 버튼: 저장 없이 빈 input 노출 (사용자가 날짜 선택 후 저장)
window.openNaesinClinic = function(studentId) {
    if (window.state) window.state._pendingClinicStudentId = studentId;
    if (window._classMgmtMode === 'teukang' && window.renderTeukangDetail) {
        window.renderTeukangDetail(studentId);
    } else if (window.renderNaesinDetail) {
        window.renderNaesinDetail(studentId);
    }
};

// ─── 등원시간 수정 ────────────────────────────────────────────────────────────
window.editNaesinTime = async function(studentId, day) {
    const { allStudents, selectedDate, classSettings } = _state();

    const student = allStudents?.find(s => s.docId === studentId);
    if (!student) return;

    const info = getNaesinInfo(student, selectedDate);
    if (!info) return;

    const { enrollment, naesinCode, csKey } = info;
    const enrollments = (student.enrollments || []).slice();
    const enrollIdx = enrollments.indexOf(enrollment);
    if (enrollIdx === -1) return;

    // 현재 시간 결정 (개별 우선, 반 기본 fallback)
    const currentTime = getNaesinTime(enrollment, csKey, day, classSettings);

    const newTime = window.prompt(
        `${day}요일 등원시간 수정 (예: 14:00)\n현재: ${currentTime || '없음'}`,
        currentTime
    );
    if (newTime === null) return; // 취소

    const trimmed = newTime.trim();
    const classDefault = classSettings?.[csKey]?.schedule?.[day] || '';

    // naesin_schedule 업데이트 (반 기본과 같으면 개별 override 삭제)
    const naesinSchedule = { ...(enrollments[enrollIdx].naesin_schedule || {}) };
    if (!trimmed || trimmed === classDefault) {
        delete naesinSchedule[day];
    } else {
        naesinSchedule[day] = trimmed;
    }

    const updatedEnrollment = { ...enrollments[enrollIdx] };
    if (Object.keys(naesinSchedule).length > 0) {
        updatedEnrollment.naesin_schedule = naesinSchedule;
    } else {
        delete updatedEnrollment.naesin_schedule;
    }
    enrollments[enrollIdx] = updatedEnrollment;

    window.showSaveIndicator?.('saving');
    try {
        await auditUpdate(doc(db, 'students', studentId), { enrollments });
        student.enrollments = enrollments;
        window.showSaveIndicator?.('saved');
    } catch (err) {
        console.error('[editNaesinTime] Firestore 저장 실패:', err);
        window.showSaveIndicator?.('error');
        return;
    }

    if (window.renderNaesinDetail) window.renderNaesinDetail(studentId);
};

// ─── 내신 등원요일 토글 ──────────────────────────────────────────────────────
window.toggleNaesinDay = async function(studentId, day) {
    const { allStudents, selectedDate, classSettings } = _state();

    const student = allStudents?.find(s => s.docId === studentId);
    if (!student) return;

    const info = getNaesinInfo(student, selectedDate);
    if (!info) return;

    const { enrollment, classDays } = info;
    const enrollments = (student.enrollments || []).slice();
    const enrollIdx = enrollments.indexOf(enrollment);
    if (enrollIdx === -1) return;

    // naesin_days: 설정된 값이 없으면 반 전체 요일에서 시작
    const currentDays = [...(enrollments[enrollIdx].naesin_days?.length > 0
        ? enrollments[enrollIdx].naesin_days
        : classDays)];
    const idx = currentDays.indexOf(day);

    if (idx >= 0) {
        if (currentDays.length <= 1) {
            alert('최소 1개 요일은 필요합니다.');
            return;
        }
        currentDays.splice(idx, 1);
    } else {
        currentDays.push(day);
    }

    enrollments[enrollIdx] = { ...enrollments[enrollIdx], naesin_days: currentDays };

    window.showSaveIndicator?.('saving');
    try {
        await auditUpdate(doc(db, 'students', studentId), { enrollments });
        student.enrollments = enrollments;
        window.showSaveIndicator?.('saved');
    } catch (err) {
        console.error('[toggleNaesinDay] Firestore 저장 실패:', err);
        window.showSaveIndicator?.('error');
        return;
    }

    if (window.renderNaesinDetail) window.renderNaesinDetail(studentId);
    if (window.renderListPanel) window.renderListPanel();
};

// ─── 내신 반에서 학생 제거 ───────────────────────────────────────────────────
window.removeFromNaesin = async function(studentId, csKey) {
    const { allStudents } = _state();
    const student = allStudents?.find(s => s.docId === studentId);
    if (!student) return;

    const displayCode = window.displayCodeFromCsKey?.(csKey, window.branchFromStudent?.(student)) || csKey;

    if (!confirm(`${student.name} 학생을 ${displayCode} 반에서 제거합니다. 계속할까요?`)) return;

    const enrollments = (student.enrollments || []).slice();
    const idx = enrollments.findIndex(e => e.class_type !== '내신' && e.class_number);
    if (idx === -1) {
        alert('정규 enrollment을 찾을 수 없어 제거할 수 없습니다.');
        return;
    }

    // 재추가 시 새 반 기준으로 초기화되도록 naesin_days/schedule도 함께 제거
    const updated = { ...enrollments[idx], naesin_class_override: NAESIN_OVERRIDE_EXCLUDE };
    delete updated.naesin_days;
    delete updated.naesin_schedule;
    enrollments[idx] = updated;

    window.showSaveIndicator?.('saving');
    try {
        await auditUpdate(doc(db, 'students', studentId), { enrollments });
        student.enrollments = enrollments;
        window.showSaveIndicator?.('saved');
    } catch (err) {
        console.error('[removeFromNaesin] 저장 실패:', err);
        window.showSaveIndicator?.('error');
        alert('학생 제거에 실패했습니다: ' + err.message);
        return;
    }

    // 학생 선택 해제 후 반 상세로 복귀
    window.selectedStudentId = null;
    if (window.renderClassDetail) window.renderClassDetail(csKey);
    if (window.renderListPanel) window.renderListPanel();
};

// ─── 특강 학생 상세 패널 ─────────────────────────────────────────────────────
// 반설정 > 특강 L2 > 학생 클릭 시 호출. 간소화된 전용 패널.

function _findTeukangEnrollment(student, classCode) {
    return (student.enrollments || []).find(e =>
        e.class_type === '특강' && window.enrollmentCode?.(e) === classCode
    );
}

export function renderTeukangDetail(studentId) {
    const { allStudents, selectedDate, classSettings, dailyRecords } = _state();
    const student = allStudents?.find(s => s.docId === studentId);
    if (!student) return;

    const classCode = window.selectedClassCode;
    if (!classCode) return;

    const enrollment = _findTeukangEnrollment(student, classCode);
    if (!enrollment) {
        // 이 반 소속이 아닌 학생이면 일반 상세로 폴백
        if (window._renderStudentDetailStandard) window._renderStudentDetailStandard(studentId);
        return;
    }

    const cs = classSettings?.[classCode] || {};
    const classSchedule = cs.schedule || {};
    const dayName = getDayName(selectedDate);
    const rec = dailyRecords?.[studentId] || {};

    // ── 패널 표시 ──
    document.getElementById('detail-empty').style.display = 'none';
    document.getElementById('detail-content').style.display = '';
    document.getElementById('detail-panel').classList.add('mobile-visible');

    // ── 헤더 ──
    const avatarEl = document.getElementById('profile-avatar');
    const nameEl = document.getElementById('detail-name');
    const phonesEl = document.getElementById('profile-phones');
    const tagsEl = document.getElementById('profile-tags');
    if (avatarEl) avatarEl.textContent = (student.name || '?')[0];
    if (nameEl) nameEl.textContent = student.name || '';
    if (phonesEl) {
        phonesEl.innerHTML =
            `<div class="profile-phone"><span class="phone-label">학생</span>${_esc(student.student_phone || '')}</div>` +
            `<div class="profile-phone"><span class="phone-label">학부모</span>${_esc(student.parent_phone_1 || '')}</div>`;
    }
    if (tagsEl) {
        const teacherEmail = cs.teacher || '';
        const teacherName = teacherEmail ? teacherEmail.split('@')[0] : '';
        const branch = window.branchFromStudent?.(student) || '';
        const schoolGrade = studentShortLabel(student);
        tagsEl.innerHTML =
            `<span class="tag-naesin" style="background:var(--info);">특강</span>` +
            `<span class="tag-class">${_esc(classCode)}</span>` +
            (schoolGrade ? `<span class="tag">${_esc(schoolGrade)}</span>` : '') +
            (branch ? `<span class="tag">${_esc(branch)}</span>` : '') +
            (teacherName ? `<span class="tag">담당: ${_esc(teacherName)}</span>` : '');
    }
    const stayStatsEl = document.getElementById('profile-stay-stats');
    if (stayStatsEl) stayStatsEl.innerHTML = '';

    // ── 출결 카드 ──
    const attStatus = rec?.attendance?.status || '미확인';
    const attClassMap = { '미확인': 'att-active', '출석': 'att-present', '지각': 'att-late', '결석': 'att-absent' };
    const attButtons = [
        { label: '등원전', value: '미확인' },
        { label: '출석', value: '출석' },
        { label: '지각', value: '지각' },
        { label: '결석', value: '결석' },
    ].map(({ label, value }) => {
        const cls = attStatus === value ? attClassMap[value] : '';
        return `<button class="naesin-att-btn ${cls}"
            onclick="window.toggleAttendance('${_escAttr(studentId)}', '${_escAttr(value)}')">${_esc(label)}</button>`;
    }).join('');
    const attHtml = `
        <div class="detail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined">how_to_reg</span>
                출결
            </div>
            <div class="naesin-att-row">${attButtons}</div>
        </div>`;

    // ── 등원요일·시간 카드 ──
    const allDays = ['월', '화', '수', '목', '금', '토', '일'];
    const classDays = Object.keys(classSchedule);
    const studentDays = enrollment.day || [];

    // 요일 토글 (반 스케줄에 있는 요일만)
    const dayTogglesHtml = allDays.map(day => {
        if (!classDays.includes(day)) return '';
        const isEnrolled = studentDays.includes(day);
        const isToday = day === dayName;
        const cls = isToday && isEnrolled ? 'naesin-day-today'
                  : isEnrolled ? 'naesin-day-active'
                  : 'naesin-day-inactive';
        return `<div class="naesin-day-badge naesin-day-toggle ${cls}"
            onclick="window.toggleTeukangDay('${_escAttr(studentId)}', '${_escAttr(classCode)}', '${_escAttr(day)}')"
            title="클릭하여 ${isEnrolled ? '제거' : '추가'}">${_esc(day)}</div>`;
    }).join('');

    // 개별 시간 vs 반 기본 시간
    const individualTime = enrollment.start_time || '';
    const firstClassDay = classDays[0];
    const classDefaultTime = classSchedule[firstClassDay] || '';
    const effectiveTime = individualTime || classDefaultTime;
    const isOverride = !!individualTime && individualTime !== classDefaultTime;
    const formatted = effectiveTime && window._formatTime12h
        ? window._formatTime12h(effectiveTime) : (effectiveTime || '—');
    const timeLabel = isOverride ? '(개별)' : (classDefaultTime ? '(반 기본)' : '');

    const schedHtml = `
        <div class="detail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined">calendar_today</span>
                등원요일 · 시간
            </div>
            <div class="naesin-day-chips">${dayTogglesHtml || '<div class="detail-card-empty">반 스케줄 없음</div>'}</div>
            <div class="naesin-schedule-row" style="margin-top:8px;">
                <span class="naesin-time${isOverride ? ' naesin-time-override' : ''}">${_esc(formatted)}</span>
                <span class="naesin-time-label${isOverride ? ' naesin-time-override' : ''}">${timeLabel}</span>
                <span class="naesin-edit-btn" onclick="window.editTeukangTime('${_escAttr(studentId)}', '${_escAttr(classCode)}')">수정</span>
            </div>
        </div>`;

    // ── 반에서 제거 카드 ──
    const removeHtml = _renderRemoveFromClassCard(studentId, classCode, classCode, 'removeFromTeukang');

    // ── 메모 카드 ──
    const memo = rec?.naesin_memo || '';
    const memoBy = rec?.naesin_memo_by || '';
    const memoAt = rec?.naesin_memo_at || '';
    const memoAtStr = memoAt
        ? (memoAt.toDate ? memoAt.toDate().toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : String(memoAt))
        : '';
    const memoDisplayHtml = memo
        ? `<div class="naesin-memo-item">${_esc(memo)}</div>
           <div class="naesin-memo-meta">${_esc(memoBy ? memoBy.split('@')[0] : '')} ${_esc(memoAtStr)}</div>`
        : `<div class="naesin-memo-empty">메모 없음</div>`;
    const memoHtml = `
        <div class="detail-card">
            <div class="detail-card-title detail-card-title-row">
                <span style="display:flex;align-items:center;gap:6px;">
                    <span class="material-symbols-outlined">sticky_note_2</span>
                    메모
                </span>
                <div class="card-add-btn" onclick="window.toggleNaesinMemoInput('${_escAttr(studentId)}')">+</div>
            </div>
            ${memoDisplayHtml}
            <div id="naesin-memo-input-area-${_escAttr(studentId)}" style="display:none;margin-top:8px;">
                <textarea id="naesin-memo-textarea-${_escAttr(studentId)}" class="naesin-memo-input"
                    placeholder="메모를 입력하세요...">${_esc(memo)}</textarea>
                <button class="naesin-memo-submit" onclick="window.saveNaesinMemo('${_escAttr(studentId)}')">저장</button>
            </div>
        </div>`;

    // ── 클리닉 카드 ──
    const extraVisit = rec?.extra_visit;
    const isPending = window.state?._pendingClinicStudentId === studentId;
    const hasClinic = (!!extraVisit && (extraVisit.date === selectedDate || !extraVisit.date)) || isPending;
    let clinicBodyHtml = '';
    if (hasClinic) {
        const cvDate = extraVisit?.date || '';
        const cvTime = extraVisit?.time || '';
        const cvReason = extraVisit?.reason || '';
        const isDone = extraVisit?.status === '완료';
        const hasData = !!cvDate;
        clinicBodyHtml = hasData ? `
            <div class="naesin-clinic-item">
                <span class="naesin-clinic-status ${isDone ? 'clinic-done' : 'clinic-pending'}">${isDone ? '완료' : '예정'}</span>
                <span>${_esc(cvDate)} ${_esc(cvTime)}</span>
                ${cvReason ? `<span class="naesin-time-label">· ${_esc(cvReason)}</span>` : ''}
            </div>` : (window.renderClinicInputs?.(studentId, null, false) || '');
    }
    const clinicHtml = `
        <div class="detail-card">
            <div class="detail-card-title detail-card-title-row">
                <span style="display:flex;align-items:center;gap:6px;">
                    <span class="material-symbols-outlined">schedule</span>
                    클리닉
                </span>
                <div class="card-add-btn" onclick="window.openNaesinClinic('${_escAttr(studentId)}')">+</div>
            </div>
            ${clinicBodyHtml || '<div class="detail-card-empty">클리닉 예정 없음</div>'}
        </div>`;

    // ── 조립 ──
    document.getElementById('detail-cards').innerHTML =
        attHtml + schedHtml + removeHtml + memoHtml + clinicHtml;

    // 탭 숨기기
    const tabsEl = document.getElementById('detail-tabs');
    if (tabsEl) tabsEl.style.display = 'none';
    const reportEl = document.getElementById('report-tab');
    if (reportEl) reportEl.style.display = 'none';
}

// ─── 특강 등원요일 토글 ──────────────────────────────────────────────────────
window.toggleTeukangDay = async function(studentId, classCode, day) {
    const { allStudents } = _state();
    const student = allStudents?.find(s => s.docId === studentId);
    if (!student) return;

    const enrollments = (student.enrollments || []).slice();
    const idx = enrollments.findIndex(e =>
        e.class_type === '특강' && window.enrollmentCode?.(e) === classCode
    );
    if (idx === -1) return;

    const currentDays = [...(enrollments[idx].day || [])];
    const dayIdx = currentDays.indexOf(day);
    if (dayIdx >= 0) {
        if (currentDays.length <= 1) {
            alert('최소 1개 요일은 필요합니다.');
            return;
        }
        currentDays.splice(dayIdx, 1);
    } else {
        currentDays.push(day);
    }

    enrollments[idx] = { ...enrollments[idx], day: currentDays };

    window.showSaveIndicator?.('saving');
    try {
        await auditUpdate(doc(db, 'students', studentId), { enrollments });
        student.enrollments = enrollments;
        window.showSaveIndicator?.('saved');
    } catch (err) {
        console.error('[toggleTeukangDay] 저장 실패:', err);
        window.showSaveIndicator?.('error');
        return;
    }

    if (window.renderTeukangDetail) window.renderTeukangDetail(studentId);
    if (window.renderListPanel) window.renderListPanel();
};

// ─── 특강 등원시간 수정 ──────────────────────────────────────────────────────
window.editTeukangTime = async function(studentId, classCode) {
    const { allStudents, classSettings } = _state();
    const student = allStudents?.find(s => s.docId === studentId);
    if (!student) return;

    const enrollments = (student.enrollments || []).slice();
    const idx = enrollments.findIndex(e =>
        e.class_type === '특강' && window.enrollmentCode?.(e) === classCode
    );
    if (idx === -1) return;

    const cs = classSettings?.[classCode] || {};
    const classSchedule = cs.schedule || {};
    const firstDay = Object.keys(classSchedule)[0];
    const classDefault = classSchedule[firstDay] || '';
    const currentTime = enrollments[idx].start_time || classDefault;

    const newTime = window.prompt(
        `${classCode} 등원시간 수정 (예: 16:00)\n현재: ${currentTime || '없음'}\n반 기본: ${classDefault || '없음'}`,
        currentTime
    );
    if (newTime === null) return;

    const trimmed = newTime.trim();
    const updated = { ...enrollments[idx] };
    if (!trimmed || trimmed === classDefault) {
        delete updated.start_time;
    } else {
        updated.start_time = trimmed;
    }
    enrollments[idx] = updated;

    window.showSaveIndicator?.('saving');
    try {
        await auditUpdate(doc(db, 'students', studentId), { enrollments });
        student.enrollments = enrollments;
        window.showSaveIndicator?.('saved');
    } catch (err) {
        console.error('[editTeukangTime] 저장 실패:', err);
        window.showSaveIndicator?.('error');
        return;
    }

    if (window.renderTeukangDetail) window.renderTeukangDetail(studentId);
};

// ─── 특강 반에서 학생 제거 ──────────────────────────────────────────────────
window.removeFromTeukang = async function(studentId, classCode) {
    const { allStudents } = _state();
    const student = allStudents?.find(s => s.docId === studentId);
    if (!student) return;

    if (!confirm(`${student.name} 학생을 ${classCode} 반에서 제거합니다. 계속할까요?`)) return;

    // 단일 패스로 제거 + 다른 특강 존재 여부 판정
    let hasOtherTeukang = false;
    const enrollments = (student.enrollments || []).filter(e => {
        const isTarget = e.class_type === '특강' && window.enrollmentCode?.(e) === classCode;
        if (!isTarget && e.class_type === '특강') hasOtherTeukang = true;
        return !isTarget;
    });
    const updateData = { enrollments };
    if (!hasOtherTeukang && student.status2 === '특강') {
        updateData.status2 = '';
    }

    window.showSaveIndicator?.('saving');
    try {
        await auditUpdate(doc(db, 'students', studentId), updateData);
        student.enrollments = enrollments;
        if (!hasOtherTeukang && student.status2 === '특강') student.status2 = '';
        window.showSaveIndicator?.('saved');
    } catch (err) {
        console.error('[removeFromTeukang] 저장 실패:', err);
        window.showSaveIndicator?.('error');
        return;
    }

    // 학생 선택 해제 후 반 상세로 복귀
    window.selectedStudentId = null;
    if (window.renderClassDetail) window.renderClassDetail(classCode);
    if (window.renderListPanel) window.renderListPanel();
};

// ─── 반 관리 상세패널 (내신 반 설정) ──────────────────────────────────────────

function renderNaesinClassDetail(csKey) {
    const { allStudents, selectedDate, classSettings } = _state();

    document.getElementById('detail-empty').style.display = 'none';
    document.getElementById('detail-content').style.display = '';
    window.selectedStudentId = null;

    const cs = classSettings?.[csKey] || {};
    const dayName = getDayName(selectedDate);

    // 이 반의 학생 수 (유도된 코드 기준)
    const students = window.getNaesinStudentsByDerivedCode ? window.getNaesinStudentsByDerivedCode(csKey) : [];

    // 표시용 반코드: 소속 접두사(branch) 제거
    const branch = students[0]?.student?.branch || '';
    const displayCode = window.displayCodeFromCsKey?.(csKey, branch) || csKey;

    // 프로필 헤더
    document.getElementById('profile-avatar').textContent = displayCode[0] || '?';
    document.getElementById('detail-name').textContent = displayCode;
    document.getElementById('profile-phones').innerHTML = '';
    const stayStats = document.getElementById('profile-stay-stats');
    if (stayStats) stayStats.innerHTML = '';
    document.getElementById('profile-tags').innerHTML = `
        <span class="tag-naesin">내신</span>
        <span style="font-size:11px;color:var(--text-sec);padding:2px 6px;">${students.length}명</span>
    `;

    // 담당
    const teachersList = window.teachersList || [];
    const currentTeacher = cs.teacher || '';
    const teacherOptions = teachersList.map(t => {
        const name = t.email.split('@')[0];
        return `<option value="${_escAttr(t.email)}" ${t.email === currentTeacher ? 'selected' : ''}>${_esc(name)}</option>`;
    }).join('');

    // 기간
    const naesinStart = cs.naesin_start || '';
    const naesinEnd = cs.naesin_end || '';

    // 요일별 시간
    const schedule = cs.schedule || {};
    const allDays = ['월', '화', '수', '목', '금', '토', '일'];
    const activeDays = Object.keys(schedule);
    const scheduleRows = allDays.map(day => {
        const time = schedule[day] || '';
        const isActive = !!time;
        const isToday = day === dayName;
        const badgeCls = isToday ? 'naesin-day-today' : isActive ? 'naesin-day-active' : '';
        const badgeInactive = !isActive && !isToday ? 'style="background:var(--bg-sec);color:var(--text-sec);"' : '';
        return `<div class="naesin-schedule-row">
            <div class="naesin-day-badge ${badgeCls}" ${badgeInactive}>${_esc(day)}</div>
            <input type="time" class="field-input" value="${_escAttr(time)}" style="width:120px;"
                onchange="window.saveNaesinClassSchedule('${_escAttr(csKey)}', '${_escAttr(day)}', this.value)">
            ${time ? `<button style="font-size:11px;color:var(--danger);cursor:pointer;border:none;background:none;" onclick="window.saveNaesinClassSchedule('${_escAttr(csKey)}', '${_escAttr(day)}', '')">삭제</button>` : ''}
        </div>`;
    }).join('');

    const cardsContainer = document.getElementById('detail-cards');
    cardsContainer.innerHTML = `
        <div class="detail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined" style="color:var(--primary);font-size:18px;">person</span>
                담당 배정
            </div>
            <select class="field-input" style="width:100%;" onchange="window.saveNaesinClassTeacher('${_escAttr(csKey)}', this.value)">
                <option value="">미지정</option>
                ${teacherOptions}
            </select>
        </div>

        <div class="detail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined" style="color:var(--primary);font-size:18px;">date_range</span>
                내신 기간
            </div>
            <div style="display:flex;gap:8px;align-items:center;">
                <input type="date" class="field-input" value="${_escAttr(naesinStart)}" style="flex:1;"
                    onchange="window.saveNaesinClassPeriod('${_escAttr(csKey)}', 'naesin_start', this.value)">
                <span style="color:var(--text-sec);">~</span>
                <input type="date" class="field-input" value="${_escAttr(naesinEnd)}" style="flex:1;"
                    onchange="window.saveNaesinClassPeriod('${_escAttr(csKey)}', 'naesin_end', this.value)">
            </div>
        </div>

        <div class="detail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined" style="color:var(--primary);font-size:18px;">schedule</span>
                등원요일 · 시간
            </div>
            <div style="font-size:11px;color:var(--text-sec);margin-bottom:8px;">시간을 입력하면 해당 요일이 활성화됩니다</div>
            ${scheduleRows}
        </div>

        ${_renderNaesinAddStudentCard(csKey)}
    `;

    // 탭 숨기기
    const tabsEl = document.getElementById('detail-tabs');
    if (tabsEl) tabsEl.style.display = 'none';
    const reportEl = document.getElementById('report-tab');
    if (reportEl) reportEl.style.display = 'none';

    if (window.innerWidth <= 768) {
        document.getElementById('detail-panel').classList.add('mobile-visible');
    }
}

// 내신 반 설정 저장 핸들러
window.saveNaesinClassTeacher = async function(csKey, teacher) {
    window.showSaveIndicator?.('saving');
    try {
        await auditSet(doc(db, 'class_settings', csKey), { teacher }, { merge: true });
        const { classSettings } = _state();
        if (!classSettings[csKey]) classSettings[csKey] = {};
        classSettings[csKey].teacher = teacher;
        window.showSaveIndicator?.('saved');
    } catch (err) {
        console.error('담당 저장 실패:', err);
        window.showSaveIndicator?.('error');
    }
};

window.saveNaesinClassPeriod = async function(csKey, field, value) {
    window.showSaveIndicator?.('saving');
    try {
        await auditSet(doc(db, 'class_settings', csKey), { [field]: value }, { merge: true });
        const { classSettings } = _state();
        if (!classSettings[csKey]) classSettings[csKey] = {};
        classSettings[csKey][field] = value;
        window.showSaveIndicator?.('saved');
    } catch (err) {
        console.error('기간 저장 실패:', err);
        window.showSaveIndicator?.('error');
    }
};

window.saveNaesinClassSchedule = async function(csKey, day, time) {
    const { classSettings } = _state();
    const cs = classSettings[csKey] || {};
    const schedule = { ...(cs.schedule || {}) };
    if (time) {
        schedule[day] = time;
    } else {
        delete schedule[day];
    }
    window.showSaveIndicator?.('saving');
    try {
        await auditSet(doc(db, 'class_settings', csKey), { schedule }, { merge: true });
        if (!classSettings[csKey]) classSettings[csKey] = {};
        classSettings[csKey].schedule = schedule;
        window.showSaveIndicator?.('saved');
        renderNaesinClassDetail(csKey);
    } catch (err) {
        console.error('스케줄 저장 실패:', err);
        window.showSaveIndicator?.('error');
    }
};

// ─── 내신반 학생 추가 카드 (반설정 상세패널) ─────────────────────────────────
function _renderNaesinAddStudentCard(csKey) {
    return renderAddStudentCard({
        key: csKey,
        idPrefix: 'naesin-add',
        searchHandlerName: 'searchNaesinAddStudent',
        footerText: '정규 반에 등록된 학생만 추가 가능. 자동 유도되지 않는 학생을 수동 매핑합니다.',
    });
}

const _naesinSearcher = createStudentSearcher({
    idPrefix: 'naesin-add',
    addHandlerName: 'addStudentToNaesin',
    getEnrolledIds: (csKey) => new Set(
        (window.getNaesinStudentsByDerivedCode?.(csKey) || [])
            .map(({ student }) => student.docId)
    ),
    getAllStudents: () => _state().allStudents,
});

window.searchNaesinAddStudent = function(csKey, q) {
    _naesinSearcher(csKey, q);
};

window.addStudentToNaesin = async function(csKey, studentId) {
    const { allStudents, classSettings } = _state();

    // 로컬 캐시 우선, 없으면 Firestore에서 조회 (퇴원/종강 학생 지원)
    let student = allStudents?.find(s => s.docId === studentId);
    let isFromRemote = false;
    if (!student) {
        try {
            const snap = await getDoc(doc(db, 'students', studentId));
            if (!snap.exists()) { alert('학생을 찾을 수 없습니다.'); return; }
            student = { docId: snap.id, ...snap.data() };
            isFromRemote = true;
        } catch (err) {
            alert('학생 조회 실패: ' + err.message);
            return;
        }
    }

    const enrollments = (student.enrollments || []).slice();
    const idx = enrollments.findIndex(e => e.class_type !== '내신' && e.class_number);
    if (idx === -1) {
        alert('정규 반에 먼저 등록된 학생만 추가할 수 있습니다.');
        return;
    }

    // 이미 같은 반이면 skip (resolveNaesinCsKey는 override === '' 일 때 null 반환)
    if (window.resolveNaesinCsKey?.(student, enrollments[idx]) === csKey) {
        alert(`${student.name} 학생은 이미 ${csKey} 반에 등록되어 있습니다.`);
        return;
    }

    // 내신 기간 미설정 경고 (진행은 허용)
    const cs = classSettings?.[csKey];
    if (!cs?.naesin_start || !cs?.naesin_end) {
        if (!confirm(`${csKey} 반에 내신 기간이 설정되어 있지 않아 리스트에 바로 노출되지 않을 수 있습니다. 그래도 추가할까요?`)) return;
    }

    const updated = { ...enrollments[idx], naesin_class_override: csKey };
    // 이전 반의 학생별 요일/시간 override는 새 반 기준으로 초기화
    delete updated.naesin_days;
    delete updated.naesin_schedule;
    enrollments[idx] = updated;

    window.showSaveIndicator?.('saving');
    try {
        await auditUpdate(doc(db, 'students', studentId), { enrollments });
        student.enrollments = enrollments;
        if (isFromRemote && Array.isArray(allStudents)) {
            allStudents.push(student);
            allStudents.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ko'));
        }
        window.showSaveIndicator?.('saved');
    } catch (err) {
        console.error('[addStudentToNaesin] 저장 실패:', err);
        window.showSaveIndicator?.('error');
        alert('학생 추가에 실패했습니다: ' + err.message);
        return;
    }

    renderNaesinClassDetail(csKey);
    if (window.renderListPanel) window.renderListPanel();
};

// ─── 외부 모듈/onclick 핸들러용 window 노출 ──────────────────────────────────
window._getNaesinStudents = getNaesinStudents;
window._getNaesinClasses = getNaesinClasses;
window.renderNaesinList = renderNaesinList;
window.renderNaesinDetail = renderNaesinDetail;
window.renderNaesinClassDetail = renderNaesinClassDetail;
window.renderTeukangDetail = renderTeukangDetail;
window.setNaesinClass = function(code) {
    window._selectedNaesinClass = (window._selectedNaesinClass === code) ? null : code;
    renderNaesinList();
};
