/**
 * naesin.js — 내신 반 관리 모듈
 *
 * 의존성:
 *   - daily-ops.js가 먼저 로드되어 window._naesinState를 노출해야 함
 *   - src/shared/firestore-helpers.js의 getDayName
 */

import { getDayName, enrollmentCode, normalizeDays } from './src/shared/firestore-helpers.js';
import { db } from './firebase-config.js';
import { updateDoc, doc } from 'firebase/firestore';

const CLASS_TYPE_NAESIN = '내신';
const validDate = (d) => d && /^\d{4}-/.test(d);

// ─── State 접근자 ─────────────────────────────────────────────────────────────
function _state() {
    return window._naesinState;
}

// 활성 내신 enrollment 찾기 (공통 헬퍼)
function findActiveNaesinEnrollment(student, selectedDate, dayName) {
    const enrollments = (student.enrollments || []).filter(
        e => e.class_type === CLASS_TYPE_NAESIN &&
             validDate(e.start_date) && e.start_date <= selectedDate &&
             validDate(e.end_date) && e.end_date >= selectedDate
    );
    if (dayName) {
        return enrollments.find(e => normalizeDays(e.day).includes(dayName)) || enrollments[0] || null;
    }
    return enrollments[0] || null;
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
            const branch = student.branch || '';
            if (branch && branch !== selectedBranch) continue;
        }

        const enrollments = student.enrollments || [];
        enrollments.forEach((enrollment, idx) => {
            if (enrollment.class_type !== CLASS_TYPE_NAESIN) return;

            // 활성 기간 확인
            if (!validDate(enrollment.start_date) || enrollment.start_date > selectedDate) return;
            if (!validDate(enrollment.end_date) || enrollment.end_date < selectedDate) return;

            // 요일 확인
            const days = normalizeDays(enrollment.day);
            if (!days.includes(dayName)) return;

            result.push({
                student,
                enrollment,
                enrollIdx: idx,
            });
        });
    }

    return result;
}

export function getNaesinClasses(students) {
    if (!students) students = getNaesinStudents();
    const countMap = new Map();

    for (const { enrollment } of students) {
        const code = enrollmentCode(enrollment);
        if (!code) continue;
        countMap.set(code, (countMap.get(code) ?? 0) + 1);
    }

    return [...countMap.entries()]
        .map(([code, count]) => ({ code, count }))
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

    // 선택된 반으로 필터
    const selectedClass = window._selectedNaesinClass || null;
    const items = selectedClass
        ? allItems.filter(({ enrollment }) => enrollmentCode(enrollment) === selectedClass)
        : allItems;

    // 카운트 표시
    countEl.textContent = `${items.length}명`;

    // ── L3 반 칩 ──
    const chipHtml = classes.map(({ code, count }) => {
        const isActive = code === selectedClass ? 'active' : '';
        return `<button class="nav-l2 ${isActive}" onclick="window.setNaesinClass('${_escAttr(code)}')">${_esc(code)}<span class="nav-l2-count">${count}</span></button>`;
    }).join('');

    // ── 학생 목록 ──
    let listHtml;
    if (items.length === 0) {
        listHtml = `<div class="empty-state">
            <span class="material-symbols-outlined">school</span>
            <p>내신 학생이 없습니다</p>
        </div>`;
    } else {
        listHtml = items.map(({ student, enrollment }) => {
            const sid = student.docId;
            const rec = dailyRecords?.[sid];
            const attStatus = rec?.attendance?.status || '미확인';
            const { display: attDisplay, cls: attCls } = window._attToggleClass
                ? window._attToggleClass(attStatus)
                : { display: attStatus, cls: '' };

            const startTime = window.getStudentStartTime
                ? window.getStudentStartTime(enrollment, dayName)
                : (enrollment.start_time || '');
            const timeText = startTime && window._formatTime12h
                ? window._formatTime12h(startTime)
                : startTime;

            const code = enrollmentCode(enrollment);
            const teacherEmail = classSettings?.[code]?.teacher || '';
            const teacherName = teacherEmail ? teacherEmail.split('@')[0] : '';
            const subLine = [code, teacherName].filter(Boolean).join(' · ');

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
    const enrollment = findActiveNaesinEnrollment(student, selectedDate, dayName) || {};
    const rawCode = enrollmentCode(enrollment);
    // 유도된 내신 반코드 (학교+학년+A/B)
    const code = window.deriveNaesinCode ? window.deriveNaesinCode(student, enrollment) : rawCode;
    const days = normalizeDays(enrollment.day);

    const cs = classSettings?.[code] || classSettings?.[rawCode] || {};
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
        const branch       = student.branch || '';
        const schoolGrade  = [student.school, student.grade].filter(Boolean).join(' ');
        tagsEl.innerHTML =
            `<span class="tag-naesin">내신</span>` +
            (code ? `<span class="tag-class">${_esc(code)}</span>` : '') +
            (schoolGrade ? `<span style="font-size:11px;color:var(--text-sec);padding:2px 6px;">${_esc(schoolGrade)}</span>` : '') +
            (branch     ? `<span style="font-size:11px;color:var(--text-sec);padding:2px 6px;">${_esc(branch)}</span>` : '') +
            (teacherName ? `<span style="font-size:11px;color:var(--text-sec);padding:2px 6px;">담당: ${_esc(teacherName)}</span>` : '');
    }

    // ── Section 2: 출결 ──
    const attStatus = rec?.attendance?.status || '미확인';
    const attColors = {
        '미확인': { bg: '#f1f5f9', color: '#334155', border: '#94a3b8' },
        '출석':   { bg: '#dcfce7', color: '#166534', border: '#86efac' },
        '지각':   { bg: '#fef9c3', color: '#854d0e', border: '#fde047' },
        '결석':   { bg: '#fee2e2', color: '#991b1b', border: '#fca5a5' },
    };
    const attButtons = [
        { label: '등원전', value: '미확인' },
        { label: '출석',   value: '출석' },
        { label: '지각',   value: '지각' },
        { label: '결석',   value: '결석' },
    ].map(({ label, value }) => {
        const isActive = attStatus === value;
        const c = isActive ? attColors[value] : { bg: '#fff', color: '#64748b', border: '#d1d5db' };
        return `<div style="flex:1;padding:10px 0;border-radius:8px;text-align:center;font-size:13px;font-weight:${isActive ? '700' : '500'};border:1.5px solid ${c.border};color:${c.color};background:${c.bg};cursor:pointer;"
            onclick="window.toggleAttendance('${_escAttr(studentId)}', '${_escAttr(value)}')">${_esc(label)}</div>`;
    }).join('');

    const attHtml = `
        <div style="border:1px solid #e5e7eb;border-radius:12px;padding:16px;margin-bottom:12px;background:#fff;">
            <div style="font-size:13px;font-weight:600;color:#475569;margin-bottom:10px;display:flex;align-items:center;gap:6px;">
                <span class="material-symbols-outlined" style="color:var(--primary);font-size:18px;">how_to_reg</span>
                출결
            </div>
            <div style="display:flex;gap:6px;">${attButtons}</div>
        </div>`;

    // ── Section 3: 등원요일·시간 ──
    const allDays = ['월', '화', '수', '목', '금', '토', '일'];
    const classSched = cs.schedule || {};

    // 요일 토글 행
    const dayBadgeStyle = (isActive, isToday) => {
        const bg = isToday && isActive ? '#f59e0b' : isActive ? '#2563eb' : '#f1f5f9';
        const color = (isActive || isToday) ? '#fff' : '#94a3b8';
        return `width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;background:${bg};color:${color};cursor:pointer;`;
    };
    const dayTogglesHtml = allDays.map(day => {
        const isActive = days.includes(day);
        const isToday = day === dayName;
        return `<div style="${dayBadgeStyle(isActive, isToday)}"
            onclick="window.toggleNaesinDay('${_escAttr(studentId)}', '${_escAttr(day)}')">${_esc(day)}</div>`;
    }).join('');

    // 활성 요일별 시간 목록
    const timeRowsHtml = days.length > 0 ? days.map(day => {
        const studentOverride = enrollment.schedule?.[day];
        const classDefault = classSched[day];
        let timeText, timeColor, timeLabel;
        if (studentOverride) {
            timeText = studentOverride; timeColor = '#dc2626'; timeLabel = '(개별)';
        } else if (classDefault) {
            timeText = classDefault; timeColor = '#1e293b'; timeLabel = '(반 기본)';
        } else {
            timeText = ''; timeColor = '#1e293b'; timeLabel = '';
        }
        const formatted = timeText && window._formatTime12h ? window._formatTime12h(timeText) : (timeText || '—');
        const isToday = day === dayName;
        const smallBg = isToday ? '#f59e0b' : '#2563eb';

        return `<div style="display:flex;align-items:center;gap:8px;padding:5px 0;font-size:13px;">
            <div style="width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;background:${smallBg};color:#fff;">${_esc(day)}</div>
            <span style="font-size:13px;font-weight:600;color:${timeColor};">${_esc(formatted)}</span>
            <span style="font-size:11px;color:${studentOverride ? '#dc2626' : '#94a3b8'};">${timeLabel}</span>
            <span style="font-size:11px;color:#2563eb;cursor:pointer;text-decoration:underline;margin-left:auto;" onclick="window.editNaesinTime('${_escAttr(studentId)}', '${_escAttr(day)}')">수정</span>
        </div>`;
    }).join('') : '<div style="font-size:13px;color:#94a3b8;padding:6px 0;">등원 요일을 선택하세요</div>';

    // 반 기본 스케줄 요약
    const schedSummary = Object.entries(classSched)
        .map(([d, t]) => `${d} ${window._formatTime12h ? window._formatTime12h(t) : t}`)
        .join(' · ');

    const schedHtml = `
        <div style="border:1px solid #e5e7eb;border-radius:12px;padding:16px;margin-bottom:12px;background:#fff;">
            <div style="font-size:13px;font-weight:600;color:#475569;margin-bottom:10px;display:flex;align-items:center;gap:6px;">
                <span class="material-symbols-outlined" style="color:var(--primary);font-size:18px;">calendar_today</span>
                등원요일·시간
            </div>
            <div style="display:flex;gap:4px;margin-bottom:8px;">${dayTogglesHtml}</div>
            ${timeRowsHtml}
            ${schedSummary ? `<div style="font-size:11px;color:#94a3b8;padding-top:6px;border-top:1px solid #f1f5f9;margin-top:6px;">반 기본: ${_esc(schedSummary)}</div>` : ''}
        </div>`;

    // ── Section 4: 메모 ──
    const memo    = rec?.naesin_memo || '';
    const memoBy  = rec?.naesin_memo_by || '';
    const memoAt  = rec?.naesin_memo_at || '';
    const memoAtStr = memoAt
        ? (memoAt.toDate ? memoAt.toDate().toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : String(memoAt))
        : '';

    const memoDisplayHtml = memo
        ? `<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:10px 12px;font-size:13px;line-height:1.5;white-space:pre-wrap;">${_esc(memo)}</div>
           <div style="font-size:11px;color:#94a3b8;margin-top:4px;">${_esc(memoBy ? memoBy.split('@')[0] : '')} ${_esc(memoAtStr)}</div>`
        : `<div style="font-size:13px;color:#94a3b8;padding:8px 0;">메모 없음</div>`;

    const addBtnStyle = 'width:24px;height:24px;border-radius:6px;border:1.5px solid #d1d5db;background:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:16px;color:#64748b;line-height:1;';

    const memoHtml = `
        <div style="border:1px solid #e5e7eb;border-radius:12px;padding:16px;margin-bottom:12px;background:#fff;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
                <span style="font-size:13px;font-weight:600;color:#475569;display:flex;align-items:center;gap:6px;">
                    <span class="material-symbols-outlined" style="color:var(--primary);font-size:18px;">sticky_note_2</span>
                    메모
                </span>
                <div style="${addBtnStyle}" onclick="window.toggleNaesinMemoInput('${_escAttr(studentId)}')">+</div>
            </div>
            ${memoDisplayHtml}
            <div id="naesin-memo-input-area-${_escAttr(studentId)}" style="display:none;margin-top:8px;">
                <textarea id="naesin-memo-textarea-${_escAttr(studentId)}" style="width:100%;border:1px solid #d1d5db;border-radius:8px;padding:8px 12px;font-size:13px;resize:vertical;min-height:60px;font-family:inherit;"
                    placeholder="메모를 입력하세요...">${_esc(memo)}</textarea>
                <div style="margin-top:6px;padding:6px 14px;background:#2563eb;color:#fff;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;display:inline-block;"
                    onclick="window.saveNaesinMemo('${_escAttr(studentId)}')">저장</div>
            </div>
        </div>`;

    // ── Section 5: 클리닉 ──
    const extraVisit   = rec?.extra_visit;
    const hasClinic    = !!extraVisit && (extraVisit.date === selectedDate || !extraVisit.date);
    let clinicBodyHtml = '';
    if (hasClinic) {
        const cvDate   = extraVisit.date || '';
        const cvTime   = extraVisit.time || '';
        const cvReason = extraVisit.reason || '';
        const isDone   = extraVisit.status === '완료';
        const statusBg = isDone ? '#dcfce7' : '#fef3c7';
        const statusColor = isDone ? '#166534' : '#92400e';
        const statusText = isDone ? '완료' : '예정';
        clinicBodyHtml = `
            <div style="display:flex;align-items:center;gap:8px;padding:6px 0;font-size:13px;">
                <span style="padding:3px 8px;border-radius:6px;font-size:11px;font-weight:600;background:${statusBg};color:${statusColor};">${statusText}</span>
                <span>${_esc(cvDate)} ${_esc(cvTime)}</span>
                ${cvReason ? `<span style="color:#94a3b8;">· ${_esc(cvReason)}</span>` : ''}
            </div>`;
    }

    const clinicHtml = `
        <div style="border:1px solid #e5e7eb;border-radius:12px;padding:16px;margin-bottom:12px;background:#fff;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
                <span style="font-size:13px;font-weight:600;color:#475569;display:flex;align-items:center;gap:6px;">
                    <span class="material-symbols-outlined" style="color:var(--primary);font-size:18px;">schedule</span>
                    클리닉
                </span>
                <div style="${addBtnStyle}" onclick="window.openNaesinClinic('${_escAttr(studentId)}')">+</div>
            </div>
            ${clinicBodyHtml || '<div style="font-size:13px;color:#94a3b8;padding:8px 0;">클리닉 예정 없음</div>'}
        </div>`;

    // ── 조립 ──
    document.getElementById('detail-cards').innerHTML =
        attHtml + schedHtml + memoHtml + clinicHtml;

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
window.openNaesinClinic = async function(studentId) {
    const { selectedDate } = _state();
    // 날짜 초기화 후 detail 리렌더
    if (window.saveExtraVisit) {
        await window.saveExtraVisit(studentId, 'date', selectedDate);
    }
    if (window.renderNaesinDetail) window.renderNaesinDetail(studentId);
};

// ─── 등원요일 토글 ────────────────────────────────────────────────────────────
window.toggleNaesinDay = async function(studentId, day) {
    const { allStudents, selectedDate } = _state();
    const student = allStudents?.find(s => s.docId === studentId);
    if (!student) return;

    const found = findActiveNaesinEnrollment(student, selectedDate);
    if (!found) return;
    const enrollments = (student.enrollments || []).slice();
    const enrollIdx = enrollments.indexOf(found);
    if (enrollIdx === -1) return;

    const currentDays = normalizeDays(enrollments[enrollIdx].day);
    let newDays;
    if (currentDays.includes(day)) {
        newDays = currentDays.filter(d => d !== day);
    } else {
        const order = ['월', '화', '수', '목', '금', '토', '일'];
        newDays = [...currentDays, day].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    }
    enrollments[enrollIdx] = { ...enrollments[enrollIdx], day: newDays };

    window.showSaveIndicator?.('saving');
    try {
        await updateDoc(doc(db, 'students', studentId), { enrollments });
        student.enrollments = enrollments;
        window.showSaveIndicator?.('saved');
    } catch (err) {
        console.error('[toggleNaesinDay] 저장 실패:', err);
        window.showSaveIndicator?.('error');
        return;
    }
    renderNaesinDetail(studentId);
};

// ─── 등원시간 수정 ────────────────────────────────────────────────────────────
window.editNaesinTime = async function(studentId, day) {
    const { allStudents, selectedDate, classSettings } = _state();

    const student = allStudents?.find(s => s.docId === studentId);
    if (!student) return;

    const found = findActiveNaesinEnrollment(student, selectedDate);
    if (!found) return;
    const enrollments = (student.enrollments || []).slice();
    const enrollIdx = enrollments.indexOf(found);
    if (enrollIdx === -1) return;
    const enrollment = { ...enrollments[enrollIdx] };
    const code = enrollmentCode(enrollment);

    // 3. 현재 시간 결정 (개별 우선, 반 기본 fallback)
    const currentTime =
        enrollment.schedule?.[day] ||
        classSettings?.[code]?.schedule?.[day] ||
        (window.getStudentStartTime ? window.getStudentStartTime(enrollment, day) : '') ||
        '';

    // 4. prompt로 새 시간 입력
    const newTime = window.prompt(
        `${day}요일 등원시간 수정 (예: 14:00)\n현재: ${currentTime || '없음'}`,
        currentTime
    );
    if (newTime === null) return; // 취소

    const trimmed = newTime.trim();
    const classDefault = classSettings?.[code]?.schedule?.[day] || '';

    // 5. schedule 업데이트
    const schedule = { ...(enrollment.schedule || {}) };
    if (!trimmed || trimmed === classDefault) {
        // 반 기본과 동일하거나 빈값 → 개별 override 삭제
        delete schedule[day];
    } else {
        schedule[day] = trimmed;
    }

    // schedule이 비었으면 undefined로 정리
    const newSchedule = Object.keys(schedule).length > 0 ? schedule : undefined;

    const updatedEnrollment = { ...enrollment };
    if (newSchedule !== undefined) {
        updatedEnrollment.schedule = newSchedule;
    } else {
        delete updatedEnrollment.schedule;
    }
    enrollments[enrollIdx] = updatedEnrollment;

    // 6. Firestore 업데이트
    window.showSaveIndicator?.('saving');
    try {
        await updateDoc(doc(db, 'students', studentId), { enrollments });
        // 7. 로컬 캐시 갱신
        student.enrollments = enrollments;
        window.showSaveIndicator?.('saved');
    } catch (err) {
        console.error('[editNaesinTime] Firestore 저장 실패:', err);
        window.showSaveIndicator?.('error');
        return;
    }

    // 8. 상세패널 재렌더
    if (window.renderNaesinDetail) window.renderNaesinDetail(studentId);
};

// ─── 반 관리 상세패널 (내신 반 설정) ──────────────────────────────────────────

function renderNaesinClassDetail(classCode) {
    const { allStudents, selectedDate, classSettings } = _state();

    document.getElementById('detail-empty').style.display = 'none';
    document.getElementById('detail-content').style.display = '';
    window.selectedStudentId = null;

    const cs = classSettings?.[classCode] || {};
    const dayName = getDayName(selectedDate);

    // 이 반의 학생 수 (유도된 코드 기준)
    const students = window.getNaesinStudentsByDerivedCode ? window.getNaesinStudentsByDerivedCode(classCode) : [];

    // 프로필 헤더
    document.getElementById('profile-avatar').textContent = classCode[0] || '?';
    document.getElementById('detail-name').textContent = classCode;
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
                onchange="window.saveNaesinClassSchedule('${_escAttr(classCode)}', '${_escAttr(day)}', this.value)">
            ${time ? `<button style="font-size:11px;color:var(--danger);cursor:pointer;border:none;background:none;" onclick="window.saveNaesinClassSchedule('${_escAttr(classCode)}', '${_escAttr(day)}', '')">삭제</button>` : ''}
        </div>`;
    }).join('');

    const cardsContainer = document.getElementById('detail-cards');
    cardsContainer.innerHTML = `
        <div class="detail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined" style="color:var(--primary);font-size:18px;">person</span>
                담당 배정
            </div>
            <select class="field-input" style="width:100%;" onchange="window.saveNaesinClassTeacher('${_escAttr(classCode)}', this.value)">
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
                    onchange="window.saveNaesinClassPeriod('${_escAttr(classCode)}', 'naesin_start', this.value)">
                <span style="color:var(--text-sec);">~</span>
                <input type="date" class="field-input" value="${_escAttr(naesinEnd)}" style="flex:1;"
                    onchange="window.saveNaesinClassPeriod('${_escAttr(classCode)}', 'naesin_end', this.value)">
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
window.saveNaesinClassTeacher = async function(classCode, teacher) {
    window.showSaveIndicator?.('saving');
    try {
        const { setDoc, doc: fbDoc } = await import('firebase/firestore');
        await setDoc(fbDoc(db, 'class_settings', classCode), { teacher }, { merge: true });
        const { classSettings } = _state();
        if (!classSettings[classCode]) classSettings[classCode] = {};
        classSettings[classCode].teacher = teacher;
        window.showSaveIndicator?.('saved');
    } catch (err) {
        console.error('담당 저장 실패:', err);
        window.showSaveIndicator?.('error');
    }
};

window.saveNaesinClassPeriod = async function(classCode, field, value) {
    window.showSaveIndicator?.('saving');
    try {
        const { setDoc, doc: fbDoc } = await import('firebase/firestore');
        await setDoc(fbDoc(db, 'class_settings', classCode), { [field]: value }, { merge: true });
        const { classSettings } = _state();
        if (!classSettings[classCode]) classSettings[classCode] = {};
        classSettings[classCode][field] = value;
        window.showSaveIndicator?.('saved');
    } catch (err) {
        console.error('기간 저장 실패:', err);
        window.showSaveIndicator?.('error');
    }
};

window.saveNaesinClassSchedule = async function(classCode, day, time) {
    const { classSettings } = _state();
    const cs = classSettings[classCode] || {};
    const schedule = { ...(cs.schedule || {}) };
    if (time) {
        schedule[day] = time;
    } else {
        delete schedule[day];
    }
    window.showSaveIndicator?.('saving');
    try {
        const { setDoc, doc: fbDoc } = await import('firebase/firestore');
        await setDoc(fbDoc(db, 'class_settings', classCode), { schedule }, { merge: true });
        if (!classSettings[classCode]) classSettings[classCode] = {};
        classSettings[classCode].schedule = schedule;
        window.showSaveIndicator?.('saved');
        renderNaesinClassDetail(classCode);
    } catch (err) {
        console.error('스케줄 저장 실패:', err);
        window.showSaveIndicator?.('error');
    }
};

// ─── 외부 모듈/onclick 핸들러용 window 노출 ──────────────────────────────────
window._getNaesinStudents = getNaesinStudents;
window._getNaesinClasses = getNaesinClasses;
window.renderNaesinList = renderNaesinList;
window.renderNaesinDetail = renderNaesinDetail;
window.renderNaesinClassDetail = renderNaesinClassDetail;
window.setNaesinClass = function(code) {
    window._selectedNaesinClass = (window._selectedNaesinClass === code) ? null : code;
    renderNaesinList();
};
