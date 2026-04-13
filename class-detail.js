// ─── Class Detail Module ───────────────────────────────────────────────────
// daily-ops.js에서 추출한 반 관리 상세 + 타반수업 관련 함수
// Phase 3-3

import { doc, getDoc, getDocFromServer, writeBatch, arrayUnion } from 'firebase/firestore';
import { db } from './firebase-config.js';
import { getDayName } from './src/shared/firestore-helpers.js';
import { auditUpdate, batchUpdate } from './audit.js';
import { state, DAY_ORDER } from './state.js';
import { esc, escAttr, showSaveIndicator } from './ui-utils.js';
import { matchesBranchFilter, enrollmentCode, getActiveEnrollments } from './student-helpers.js';

// ─── deps injection ─────────────────────────────────────────────────────────
let getOverrideStudentsForClass, getOverridingOutFromClass, getClassDomains, getClassTestSections;
let getTeacherName, saveClassSettings, isInTeukangClass, getTeukangClassStudents;
let renderStudentDetail, renderListPanel, _isNaesinClassCode;

export function initClassDetailDeps(deps) {
    getOverrideStudentsForClass = deps.getOverrideStudentsForClass;
    getOverridingOutFromClass = deps.getOverridingOutFromClass;
    getClassDomains = deps.getClassDomains;
    getClassTestSections = deps.getClassTestSections;
    getTeacherName = deps.getTeacherName;
    saveClassSettings = deps.saveClassSettings;
    isInTeukangClass = deps.isInTeukangClass;
    getTeukangClassStudents = deps.getTeukangClassStudents;
    renderStudentDetail = deps.renderStudentDetail;
    renderListPanel = deps.renderListPanel;
    _isNaesinClassCode = deps._isNaesinClassCode;
}

export function renderClassTempOverrideSection(classCode) {
    const overrideIn = getOverrideStudentsForClass(classCode, state.selectedDate);
    const overrideOut = getOverridingOutFromClass(classCode, state.selectedDate);

    if (overrideIn.length === 0 && overrideOut.length === 0) {
        return `
            <div class="detail-card">
                <div class="detail-card-title">
                    <span class="material-symbols-outlined" style="color:var(--warning);font-size:18px;">swap_horiz</span>
                    임시 수업 학생
                </div>
                <div style="font-size:12px;color:var(--text-sec);padding:4px 0;">오늘 타반수업 학생 없음</div>
                <button class="btn btn-secondary btn-sm" style="margin-top:8px;" onclick="openClassTempOverrideModal('${escAttr(classCode)}')">
                    <span class="material-symbols-outlined" style="font-size:14px;">add</span> 타반 학생 추가
                </button>
            </div>
        `;
    }

    const inHtml = overrideIn.map(o => `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;padding:6px 8px;background:#e3f2fd;border-radius:6px;">
            <span class="material-symbols-outlined" style="font-size:16px;color:#1565c0;">arrow_forward</span>
            <span style="font-size:13px;font-weight:600;">${esc(o.student_name)}</span>
            <span style="font-size:12px;color:var(--text-sec);">← ${esc(o.original_class_code)}</span>
            ${o.reason ? `<span style="font-size:11px;color:var(--text-third);">(${esc(o.reason)})</span>` : ''}
            <button class="btn btn-sm" style="margin-left:auto;color:var(--danger);padding:2px 6px;" onclick="cancelTempClassOverride('${escAttr(o.docId)}', '${escAttr(o.student_id)}')">취소</button>
        </div>
    `).join('');

    const outHtml = overrideOut.map(o => `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;padding:6px 8px;background:#fff3e0;border-radius:6px;">
            <span class="material-symbols-outlined" style="font-size:16px;color:#e65100;">arrow_back</span>
            <span style="font-size:13px;font-weight:600;">${esc(o.student_name)}</span>
            <span style="font-size:12px;color:var(--text-sec);">→ ${esc(o.target_class_code)}</span>
        </div>
    `).join('');

    return `
        <div class="detail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined" style="color:var(--warning);font-size:18px;">swap_horiz</span>
                임시 수업 학생
            </div>
            ${overrideIn.length > 0 ? `<div style="font-size:11px;font-weight:600;color:#1565c0;margin-bottom:4px;">들어오는 학생 (${overrideIn.length}명)</div>${inHtml}` : ''}
            ${overrideOut.length > 0 ? `<div style="font-size:11px;font-weight:600;color:#e65100;margin-bottom:4px;${overrideIn.length > 0 ? 'margin-top:8px;' : ''}">나가는 학생 (${overrideOut.length}명)</div>${outHtml}` : ''}
            <button class="btn btn-secondary btn-sm" style="margin-top:8px;" onclick="openClassTempOverrideModal('${escAttr(classCode)}')">
                <span class="material-symbols-outlined" style="font-size:14px;">add</span> 타반 학생 추가
            </button>
        </div>
    `;
}

export function openClassTempOverrideModal(classCode) {
    // 반에 등록되지 않은 학생 검색 가능한 모달
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    overlay.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h3>타반 학생 추가 — ${esc(classCode)}</h3>
                <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">
                    <span class="material-symbols-outlined">close</span>
                </button>
            </div>
            <div class="modal-body">
                <div class="form-field">
                    <label class="field-label">학생 검색</label>
                    <input type="text" class="field-input" id="ovr-class-student-search" placeholder="학생 이름 검색" oninput="filterClassOverrideStudents()">
                </div>
                <div id="ovr-class-student-list" style="max-height:200px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;padding:4px;"></div>
                <div class="form-field" style="margin-top:12px;">
                    <label class="field-label">날짜</label>
                    <input type="date" class="field-input" id="ovr-class-date" value="${state.selectedDate}">
                </div>
                <div class="form-field">
                    <label class="field-label">사유 (선택)</label>
                    <input type="text" class="field-input" id="ovr-class-reason" placeholder="사유 입력">
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">취소</button>
                <button class="btn btn-primary" onclick="submitClassTempOverrideFromModal('${escAttr(classCode)}')">등록</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    // 초기 목록 표시
    filterClassOverrideStudents();
}

export function filterClassOverrideStudents() {
    const searchVal = (document.getElementById('ovr-class-student-search')?.value || '').trim().toLowerCase();
    const listEl = document.getElementById('ovr-class-student-list');
    if (!listEl) return;

    const filtered = state.allStudents.filter(s =>
        s.status !== '퇴원' && s.name?.toLowerCase().includes(searchVal)
    ).slice(0, 20);

    listEl.innerHTML = filtered.length === 0
        ? '<div style="padding:8px;color:var(--text-sec);font-size:12px;">검색 결과 없음</div>'
        : filtered.map(s => {
            const codes = getActiveEnrollments(s, state.selectedDate).map(e => enrollmentCode(e)).filter(Boolean).join(', ');
            return `<div class="ovr-student-option" data-id="${escAttr(s.docId)}" onclick="selectClassOverrideStudent(this)" style="padding:6px 8px;cursor:pointer;border-radius:4px;display:flex;align-items:center;gap:8px;">
                <span style="font-weight:500;">${esc(s.name)}</span>
                <span style="font-size:11px;color:var(--text-sec);">${esc(codes)}</span>
            </div>`;
        }).join('');
}

export function selectClassOverrideStudent(el) {
    document.querySelectorAll('.ovr-student-option').forEach(opt => {
        if (opt === el) {
            opt.style.background = 'var(--primary-light)';
            opt.dataset.selected = 'true';
        } else {
            opt.style.background = '';
            delete opt.dataset.selected;
        }
    });
}

export async function submitClassTempOverrideFromModal(classCode) {
    const selectedEl = document.querySelector('.ovr-student-option[data-selected="true"]');
    if (!selectedEl) { alert('학생을 선택해주세요.'); return; }
    const studentId = selectedEl.dataset.id;
    const dateVal = document.getElementById('ovr-class-date')?.value;
    const reason = document.getElementById('ovr-class-reason')?.value || '';
    if (!dateVal) { alert('날짜를 선택해주세요.'); return; }
    document.querySelector('.modal-overlay')?.remove();
    await window.createTempClassOverride(studentId, classCode, [dateVal], reason);
}

export function renderClassDetail(classCode) {
    if (!classCode) {
        document.getElementById('detail-empty').style.display = '';
        document.getElementById('detail-content').style.display = 'none';
        return;
    }

    // 특강 반: naesin보다 먼저 체크 (반 이름에 한글 포함되므로 _isNaesinClassCode가 true 반환할 수 있음)
    const isTeukangClass = state.classSettings[classCode]?.class_type === '특강';

    // 내신 반: naesin.js로 위임
    if (!isTeukangClass && window.renderNaesinClassDetail && _isNaesinClassCode(classCode)) {
        window.renderNaesinClassDetail(classCode);
        return;
    }

    state.selectedStudentId = null; // 학생 선택 해제

    document.getElementById('detail-empty').style.display = 'none';
    document.getElementById('detail-content').style.display = '';

    const dayName = getDayName(state.selectedDate);
    let classStudents = isTeukangClass
        ? getTeukangClassStudents(classCode)
        : state.allStudents.filter(s =>
            s.status !== '퇴원' &&
            getActiveEnrollments(s, state.selectedDate).some(e => e.day.includes(dayName) && enrollmentCode(e) === classCode)
          ).filter(s => matchesBranchFilter(s));
    const domains = getClassDomains(classCode);
    const testSections = getClassTestSections(classCode);

    // 프로필 헤더를 반 정보로 교체 (학생 상세에서 남은 데이터 클리어)
    document.getElementById('profile-avatar').textContent = classCode[0] || '?';
    document.getElementById('detail-name').textContent = classCode;
    document.getElementById('profile-phones').innerHTML = '';
    document.getElementById('profile-stay-stats').innerHTML = '';
    document.getElementById('profile-tags').innerHTML = `
        <span class="tag">${classStudents.length}명</span>
    `;

    const cardsContainer = document.getElementById('detail-cards');

    // ① 등원예정시간 — 반 기본 시간만 설정 (학생별 개별시간은 학생 상세패널에서)
    const defaultTime = state.classSettings[classCode]?.default_time || '';
    const timeUpdatedBy = state.classSettings[classCode]?.default_time_updated_by || '';
    const timeUpdatedAt = state.classSettings[classCode]?.default_time_updated_at || '';
    const timeUpdatedLabel = timeUpdatedBy
        ? `${getTeacherName(timeUpdatedBy)} · ${timeUpdatedAt ? new Date(timeUpdatedAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}`
        : '';

    // ② 영역숙제관리
    const domainChips = domains.map((d, i) => `
        <span class="domain-chip">
            ${esc(d)}
            <button class="domain-chip-remove" onclick="event.stopPropagation(); removeClassDomain('${escAttr(classCode)}', ${i})" title="삭제">&times;</button>
        </span>
    `).join('');

    // ③ 테스트관리 — 섹션별 구성
    const sectionNames = Object.keys(testSections);
    const testSectionsHtml = sectionNames.map(secName => {
        const tests = testSections[secName] || [];
        const testChips = tests.map((t, i) => `
            <span class="domain-chip">
                ${esc(t)}
                <button class="domain-chip-remove" onclick="event.stopPropagation(); removeTestFromSection('${escAttr(classCode)}', '${escAttr(secName)}', ${i})" title="삭제">&times;</button>
            </span>
        `).join('');
        return `
            <div class="test-section">
                <div class="test-section-header">
                    <span class="test-section-name">${esc(secName)}</span>
                    <button class="domain-chip-remove" onclick="event.stopPropagation(); removeTestSection('${escAttr(classCode)}', '${escAttr(secName)}')" title="섹션 삭제">&times;</button>
                </div>
                <div class="domain-chips-container">${testChips || '<span style="font-size:12px;color:var(--text-sec);">테스트 없음</span>'}</div>
                <div class="domain-add-row">
                    <input type="text" class="field-input" data-test-section="${escAttr(secName)}" placeholder="테스트 이름" style="flex:1;"
                        onkeydown="if(event.key==='Enter') addTestToSection('${escAttr(classCode)}', '${escAttr(secName)}')">
                    <button class="btn btn-primary btn-sm" onclick="addTestToSection('${escAttr(classCode)}', '${escAttr(secName)}')">추가</button>
                </div>
                <button class="btn btn-secondary btn-sm" style="margin-top:6px;" onclick="resetTestSection('${escAttr(classCode)}', '${escAttr(secName)}')">기본값 복원</button>
            </div>
        `;
    }).join('');

    // ④ 담당/부담당 배정
    const currentTeacher = state.classSettings[classCode]?.teacher || '';
    const currentSubTeacher = state.classSettings[classCode]?.sub_teacher || '';
    const teacherOptions = state.teachersList.map(t => {
        const name = getTeacherName(t.email);
        return `<option value="${escAttr(t.email)}" ${t.email === currentTeacher ? 'selected' : ''}>${esc(name)}</option>`;
    }).join('');
    const subTeacherOptions = state.teachersList.map(t => {
        const name = getTeacherName(t.email);
        return `<option value="${escAttr(t.email)}" ${t.email === currentSubTeacher ? 'selected' : ''}>${esc(name)}</option>`;
    }).join('');

    const teacherCard = `
        <div class="detail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined">person</span>
                담당 배정
            </div>
            <div class="teacher-assign-grid">
                <div class="teacher-assign-row">
                    <label class="teacher-assign-label">담당</label>
                    <select class="field-input teacher-assign-select" id="teacher-select" onchange="saveTeacherAssign('${escAttr(classCode)}')">
                        <option value="">미지정</option>
                        ${teacherOptions}
                    </select>
                </div>
                <div class="teacher-assign-row">
                    <label class="teacher-assign-label">부담당</label>
                    <select class="field-input teacher-assign-select" id="sub-teacher-select" onchange="saveTeacherAssign('${escAttr(classCode)}')">
                        <option value="">미지정</option>
                        ${subTeacherOptions}
                    </select>
                </div>
            </div>
        </div>`;

    // 특강반: 담당 + 특강기간 + 요일/시간 + 학생 추가 카드만 노출 (편성 과정에서 설정된 나머지는 숨김)
    if (isTeukangClass) {
        cardsContainer.innerHTML = `
            ${teacherCard}
            ${renderTeukangPeriodCard(classCode)}
            ${renderClassScheduleCard(classCode)}
            ${renderTeukangAddStudentCard(classCode)}
        `;
        if (window.innerWidth <= 768) {
            document.getElementById('detail-panel').classList.add('mobile-visible');
        }
        return;
    }

    cardsContainer.innerHTML = `
        ${teacherCard}

        ${renderRegularClassDayCard(classCode)}

        ${renderClassScheduleCard(classCode)}

        <div class="detail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined">schedule</span>
                등원예정시간
            </div>
            <div class="arrival-bulk-row">
                <input type="time" class="arrival-time-input" value="${defaultTime}"
                    onchange="saveClassDefaultTime('${escAttr(classCode)}', this.value)">
            </div>
            <div style="font-size:11px;color:var(--text-sec);margin-top:4px;">변경 시 자동 저장${timeUpdatedLabel ? ` · 최근: ${esc(timeUpdatedLabel)}` : ''}</div>
        </div>

        <div class="detail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined">category</span>
                영역숙제관리
            </div>
            <div class="domain-chips-container">${domainChips || '<span class="detail-card-empty">영역 없음</span>'}</div>
            <div class="domain-add-row">
                <input type="text" id="domain-add-input" class="field-input" placeholder="새 영역 이름" style="flex:1;"
                    onkeydown="if(event.key==='Enter') addClassDomain('${escAttr(classCode)}')">
                <button class="btn btn-primary btn-sm" onclick="addClassDomain('${escAttr(classCode)}')">추가</button>
            </div>
            <button class="btn btn-secondary btn-sm" style="margin-top:8px;" onclick="resetClassDomains('${escAttr(classCode)}')">기본값 복원</button>
        </div>

        <div class="detail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined">quiz</span>
                테스트관리
            </div>
            ${testSectionsHtml}
            <div class="domain-add-row" style="margin-top:12px;border-top:1px solid var(--border);padding-top:12px;">
                <input type="text" id="test-section-add-input" class="field-input" placeholder="새 섹션 이름" style="flex:1;"
                    onkeydown="if(event.key==='Enter') addTestSection('${escAttr(classCode)}')">
                <button class="btn btn-secondary btn-sm" onclick="addTestSection('${escAttr(classCode)}')">섹션 추가</button>
            </div>
            <button class="btn btn-secondary btn-sm" style="margin-top:8px;" onclick="resetTestSections('${escAttr(classCode)}')">기본값 복원</button>
        </div>

        ${renderClassTempOverrideSection(classCode)}

    `;

    // 모바일에서 디테일 패널 표시
    if (window.innerWidth <= 768) {
        document.getElementById('detail-panel').classList.add('mobile-visible');
    }
}

// ─── 정규반 등원 요일 카드 ──────────────────────────────────────────────────

function _getRegularClassDays(classCode) {
    const cs = state.classSettings[classCode];
    if (cs?.default_days?.length > 0) return cs.default_days;
    // class_settings에 없으면 재원 학생 enrollment에서 합집합으로 도출
    const daySet = new Set();
    state.allStudents.forEach(s => {
        if (s.status === '퇴원') return;
        (s.enrollments || []).forEach(e => {
            if (enrollmentCode(e) === classCode && (e.class_type || '정규') === '정규') {
                (e.day || []).forEach(d => daySet.add(d));
            }
        });
    });
    return DAY_ORDER.filter(d => daySet.has(d));
}

function renderRegularClassDayCard(classCode) {
    const cs = state.classSettings[classCode];
    if (cs?.class_type === '특강' || cs?.free_schedule !== undefined) return '';
    const activeDays = _getRegularClassDays(classCode);
    const dayBtns = DAY_ORDER.map(d => {
        const isActive = activeDays.includes(d);
        return `<button class="btn ${isActive ? 'btn-primary' : 'btn-secondary'} btn-sm"
            style="min-width:36px;padding:3px 8px;"
            onclick="toggleRegularClassDay('${escAttr(classCode)}', '${d}', ${!isActive})">${d}</button>`;
    }).join('');
    return `
        <div class="detail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined">date_range</span>
                등원 요일
            </div>
            <div style="display:flex;gap:4px;flex-wrap:wrap;">${dayBtns}</div>
            <div style="font-size:11px;color:var(--text-sec);margin-top:6px;">변경 시 재원 학생 전체에 적용됩니다</div>
        </div>
    `;
}

export async function toggleRegularClassDay(classCode, day, isAdd) {
    const currentDays = _getRegularClassDays(classCode);
    const newDays = isAdd
        ? DAY_ORDER.filter(d => currentDays.includes(d) || d === day)
        : currentDays.filter(d => d !== day);

    showSaveIndicator('saving');
    try {
        const batch = writeBatch(db);
        let hasOps = false;
        for (const student of state.allStudents) {
            if (student.status === '퇴원') continue;
            let changed = false;
            const updated = (student.enrollments || []).map(e => {
                if (enrollmentCode(e) === classCode && (e.class_type || '정규') === '정규') {
                    changed = true;
                    return { ...e, day: newDays };
                }
                return e;
            });
            if (!changed) continue;
            batchUpdate(batch, doc(db, 'students', student.docId), { enrollments: updated });
            student.enrollments = updated;
            hasOps = true;
        }
        await Promise.all([
            saveClassSettings(classCode, { default_days: newDays }),
            hasOps ? batch.commit() : Promise.resolve(),
        ]);
        showSaveIndicator('saved');
        renderClassDetail(classCode);
    } catch (err) {
        console.error('요일 수정 실패:', err);
        showSaveIndicator('error');
    }
}

// ─── 자유학기/특강 요일 카드 ────────────────────────────────────────────────

function _classScheduleKey(cs) {
    return cs?.free_schedule !== undefined ? 'free_schedule' : 'schedule';
}

function renderClassScheduleCard(classCode) {
    const cs = state.classSettings[classCode];
    const isFree = cs?.free_schedule !== undefined;
    if (!isFree && cs?.class_type !== '특강') return '';

    const scheduleKey = _classScheduleKey(cs);
    const schedule = cs?.[scheduleKey] || {};
    const activeDays = Object.keys(schedule).sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b));
    const label = isFree ? '자유학기 요일/시간' : '특강 요일/시간';

    const rows = activeDays.map(day => `
        <div style="display:flex;align-items:center;gap:8px;padding:4px 0;">
            <span class="naesin-day-badge naesin-day-active" style="flex-shrink:0;">${esc(day)}</span>
            <input type="time" class="arrival-time-input" style="flex:1;"
                value="${esc(schedule[day] || '16:00')}"
                onchange="saveClassDayTime('${escAttr(classCode)}', '${escAttr(day)}', this.value)">
            <button class="icon-btn" style="width:28px;height:28px;"
                onclick="toggleClassDay('${escAttr(classCode)}', '${escAttr(day)}', false)"
                title="${esc(day)} 삭제">
                <span class="material-symbols-outlined" style="font-size:16px;">close</span>
            </button>
        </div>
    `).join('');

    const addBtns = DAY_ORDER
        .filter(d => !activeDays.includes(d))
        .map(d => `<button class="btn btn-secondary btn-sm" style="min-width:32px;padding:2px 6px;"
            onclick="toggleClassDay('${escAttr(classCode)}', '${escAttr(d)}', true)">${esc(d)}</button>`)
        .join('');

    return `
        <div class="detail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined">date_range</span>
                ${esc(label)}
            </div>
            <div>
                ${rows || '<div class="detail-card-empty">요일 없음</div>'}
            </div>
            ${addBtns ? `
            <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:4px;align-items:center;">
                <span style="font-size:11px;color:var(--text-sec);">요일 추가:</span>
                ${addBtns}
            </div>` : ''}
        </div>
    `;
}

export async function toggleClassDay(classCode, day, isAdd) {
    const cs = state.classSettings[classCode] || {};
    const scheduleKey = _classScheduleKey(cs);
    const classType = cs.free_schedule !== undefined ? '자유학기' : (cs.class_type || '특강');
    const schedule = { ...(cs[scheduleKey] || {}) };

    if (isAdd) {
        if (schedule[day] !== undefined) return;
        schedule[day] = '16:00';
    } else {
        delete schedule[day];
    }

    try {
        showSaveIndicator('saving');
        await saveClassSettings(classCode, { [scheduleKey]: schedule });

        const newDays = Object.keys(schedule).sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b));
        const batch = writeBatch(db);
        let hasOps = false;
        for (const student of state.allStudents) {
            if (student.status === '퇴원') continue;
            let changed = false;
            const updated = (student.enrollments || []).map(e => {
                if (enrollmentCode(e) === classCode && e.class_type === classType) {
                    changed = true;
                    return { ...e, day: newDays };
                }
                return e;
            });
            if (!changed) continue;
            batchUpdate(batch, doc(db, 'students', student.docId), { enrollments: updated });
            student.enrollments = updated;
            hasOps = true;
        }
        if (hasOps) await batch.commit();
        showSaveIndicator('saved');
        renderClassDetail(classCode);
    } catch (err) {
        console.error('요일 수정 실패:', err);
        showSaveIndicator('error');
    }
}

export async function saveClassDayTime(classCode, day, time) {
    const cs = state.classSettings[classCode] || {};
    const scheduleKey = _classScheduleKey(cs);
    const schedule = { ...(cs[scheduleKey] || {}), [day]: time };
    try {
        showSaveIndicator('saving');
        await saveClassSettings(classCode, { [scheduleKey]: schedule });
        showSaveIndicator('saved');
    } catch (err) {
        console.error('시간 저장 실패:', err);
        showSaveIndicator('error');
    }
}

// ─── 특강반 기간 카드 ───────────────────────────────────────────────────────

function renderTeukangPeriodCard(classCode) {
    const cs = state.classSettings[classCode] || {};
    const start = cs.special_start || '';
    const end = cs.special_end || '';
    return `
        <div class="detail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined">date_range</span>
                특강 기간
            </div>
            <div style="display:flex;gap:8px;align-items:center;">
                <input type="date" class="field-input" value="${escAttr(start)}" style="flex:1;"
                    onchange="saveTeukangPeriod('${escAttr(classCode)}', 'special_start', this.value)">
                <span style="color:var(--text-sec);">~</span>
                <input type="date" class="field-input" value="${escAttr(end)}" style="flex:1;"
                    onchange="saveTeukangPeriod('${escAttr(classCode)}', 'special_end', this.value)">
            </div>
        </div>
    `;
}

export async function saveTeukangPeriod(classCode, field, value) {
    showSaveIndicator('saving');
    try {
        await saveClassSettings(classCode, { [field]: value });
        showSaveIndicator('saved');
    } catch (err) {
        console.error('특강 기간 저장 실패:', err);
        showSaveIndicator('error');
    }
}

// ─── 특강반 학생 추가 카드 ──────────────────────────────────────────────────

function renderTeukangAddStudentCard(classCode) {
    return `
        <div class="detail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined">person_add</span>
                학생 추가
            </div>
            <div class="domain-add-row">
                <input type="text" id="teukang-add-search" class="field-input"
                    placeholder="이름 또는 학교 검색" style="flex:1;"
                    oninput="searchTeukangAddStudent('${escAttr(classCode)}', this.value)">
            </div>
            <div id="teukang-add-results" class="search-results-list" style="margin-top:8px;"></div>
            <div style="font-size:11px;color:var(--text-sec);margin-top:6px;">
                재원/등원예정/실휴원/가휴원/상담 학생 검색 (퇴원 제외).
                새 학생은 첫데이터입력으로 먼저 등록해 주세요.
            </div>
        </div>
    `;
}

let _teukangAddSearchTimer = null;
let _teukangAddSearchId = 0;
export function searchTeukangAddStudent(classCode, q) {
    clearTimeout(_teukangAddSearchTimer);
    _teukangAddSearchTimer = setTimeout(() => _doSearchTeukangAddStudent(classCode, q), 200);
}

function _renderTeukangSearchItem(classCode, s) {
    // 로컬 학생은 docId, 리모트(_searchContactsDSC) 결과는 id 필드 사용
    const docId = s.docId || s.id;
    const meta = [studentShortLabel(s), s.status].filter(Boolean).join(' · ');
    return `<div class="search-result-item" style="display:flex;justify-content:space-between;align-items:center;padding:8px;border-bottom:1px solid var(--border);cursor:pointer;"
                 onclick="addStudentToTeukang('${escAttr(classCode)}', '${escAttr(docId)}')">
                <div>
                    <div style="font-weight:600;">${esc(s.name)}</div>
                    <div style="font-size:11px;color:var(--text-sec);">${esc(meta)}</div>
                </div>
                <span class="material-symbols-outlined" style="font-size:18px;color:var(--primary);">add</span>
            </div>`;
}

async function _doSearchTeukangAddStudent(classCode, q) {
    const results = document.getElementById('teukang-add-results');
    if (!results) return;
    q = (q || '').trim().toLowerCase();
    if (!q) { results.innerHTML = ''; return; }

    // stale result 방지를 위한 요청 ID
    const reqId = ++_teukangAddSearchId;

    // 이미 이 특강반에 등록된 학생 제외
    const enrolledIds = new Set(getTeukangClassStudents(classCode).map(s => s.docId));

    // 1) 로컬: 활성 학생(재원/등원예정/실휴원/가휴원/상담) 필터
    const localItems = state.allStudents
        .filter(s => {
            if (!ACTIVE_STUDENT_STATUSES.has(s.status)) return false;
            if (enrolledIds.has(s.docId)) return false;
            const name = (s.name || '').toLowerCase();
            const school = (s.school || '').toLowerCase();
            return name.includes(q) || school.includes(q);
        });

    const renderCombined = (localList, pastList) => {
        const items = [...localList, ...pastList].slice(0, 30)
            .map(s => _renderTeukangSearchItem(classCode, s));
        results.innerHTML = items.length === 0
            ? '<div style="font-size:12px;color:var(--text-sec);padding:8px;">검색 결과 없음</div>'
            : items.join('');
    };

    renderCombined(localItems.slice(0, 20), []);

    // 리모트: 퇴원/종강 학생 prefix 쿼리 (_searchContactsDSC 재사용)
    try {
        const remote = await _searchContactsDSC(q);
        if (reqId !== _teukangAddSearchId) return; // stale 무시
        const pastItems = remote.filter(r => !enrolledIds.has(r.id)).slice(0, 10);
        renderCombined(localItems.slice(0, 20), pastItems);
    } catch (err) {
        console.debug('[teukang remote search]', err?.message || err);
    }
}

function _findTeukangEnrollment(student, classCode) {
    return (student.enrollments || []).find(e =>
        e.class_type === '특강' && enrollmentCode(e) === classCode
    );
}

// 새 enrollment 빌드: class_settings.special_start/end 우선,
// 없으면 같은 반 기존 enrollment, 그것도 없으면 today.
function _buildTeukangEnrollment(classCode) {
    const cs = state.classSettings[classCode] || {};
    const days = Object.keys(cs.schedule || {})
        .sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b));

    let startDate = cs.special_start || '';
    let endDate = cs.special_end || '';

    if (!startDate || !endDate) {
        for (const s of state.allStudents) {
            const e = _findTeukangEnrollment(s, classCode);
            if (e) {
                if (!startDate && e.start_date) startDate = e.start_date;
                if (!endDate && e.end_date) endDate = e.end_date;
                break;
            }
        }
    }

    const enrollment = {
        class_type: '특강',
        level_symbol: '',
        class_number: classCode,
        day: days,
        start_date: startDate || todayStr(),
    };
    if (endDate) enrollment.end_date = endDate;
    return enrollment;
}

export async function addStudentToTeukang(classCode, studentId) {
    // 로컬 캐시 우선, 없으면 Firestore에서 가져옴 (퇴원/종강 학생 처리)
    let student = state.allStudents.find(s => s.docId === studentId);
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

    if (_findTeukangEnrollment(student, classCode)) {
        alert(`${student.name} 학생은 이미 ${classCode} 반에 등록되어 있습니다.`);
        return;
    }

    const newEnrollment = _buildTeukangEnrollment(classCode);

    showSaveIndicator('saving');
    try {
        await auditUpdate(doc(db, 'students', studentId), {
            enrollments: arrayUnion(newEnrollment),
            status2: '특강',
        });
        // 로컬 캐시 업데이트
        student.enrollments = [...(student.enrollments || []), newEnrollment];
        student.status2 = '특강';
        // 리모트에서 가져온 학생은 allStudents에 추가 (status2='특강' 쿼리에 매칭)
        if (isFromRemote) {
            state.allStudents.push(student);
            state.allStudents.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ko'));
        }
        showSaveIndicator('saved');
        renderClassDetail(classCode);
        renderListPanel?.();
    } catch (err) {
        console.error('특강 학생 추가 실패:', err);
        showSaveIndicator('error');
        alert('학생 추가에 실패했습니다: ' + err.message);
    }
}

// ─── Class Detail 핸들러 ────────────────────────────────────────────────────

export async function saveTeacherAssign(classCode) {
    const teacher = document.getElementById('teacher-select')?.value || '';
    const subTeacher = document.getElementById('sub-teacher-select')?.value || '';
    try {
        showSaveIndicator('saving');
        await saveClassSettings(classCode, { teacher, sub_teacher: subTeacher });
        showSaveIndicator('saved');
    } catch (err) {
        console.error('담당 저장 실패:', err);
        showSaveIndicator('error');
    }
}

export async function addClassDomain(classCode) {
    const input = document.getElementById('domain-add-input');
    const name = input?.value.trim();
    if (!name) return;
    try {
        const domains = getClassDomains(classCode);
        if (domains.includes(name)) { alert('이미 존재하는 영역입니다.'); return; }
        domains.push(name);
        // 리뷰테스트에도 동기화 추가
        const sections = getClassTestSections(classCode);
        if (sections['리뷰테스트'] && !sections['리뷰테스트'].includes(name)) {
            sections['리뷰테스트'].push(name);
        }
        await saveClassSettings(classCode, { domains, test_sections: sections });
        input.value = '';
        renderClassDetail(classCode);
    } catch (e) {
        console.error('영역 추가 실패:', e);
        alert('영역 추가에 실패했습니다: ' + e.message);
    }
}

export async function removeClassDomain(classCode, index) {
    try {
        const domains = getClassDomains(classCode);
        if (domains.length <= 1) { alert('최소 1개의 영역이 필요합니다.'); return; }
        const removed = domains.splice(index, 1)[0];
        // 리뷰테스트에서도 동기화 삭제
        const sections = getClassTestSections(classCode);
        if (sections['리뷰테스트']) {
            const ri = sections['리뷰테스트'].indexOf(removed);
            if (ri !== -1) sections['리뷰테스트'].splice(ri, 1);
        }
        await saveClassSettings(classCode, { domains, test_sections: sections });
        renderClassDetail(classCode);
    } catch (e) {
        console.error('영역 삭제 실패:', e);
        alert('영역 삭제에 실패했습니다: ' + e.message);
    }
}

export async function resetClassDomains(classCode) {
    try {
        // 리뷰테스트도 기본 영역으로 초기화
        const sections = getClassTestSections(classCode);
        sections['리뷰테스트'] = [...DEFAULT_DOMAINS];
        await saveClassSettings(classCode, { domains: [...DEFAULT_DOMAINS], test_sections: sections });
        renderClassDetail(classCode);
    } catch (e) {
        console.error('기본값 복원 실패:', e);
        alert('기본값 복원에 실패했습니다: ' + e.message);
    }
}

export async function addTestToSection(classCode, sectionName) {
    const input = document.querySelector(`input[data-test-section="${CSS.escape(sectionName)}"]`);
    const name = input?.value.trim();
    if (!name) return;
    const sections = getClassTestSections(classCode);
    if (!sections[sectionName]) sections[sectionName] = [];
    if (sections[sectionName].includes(name)) { alert('이미 존재하는 테스트입니다.'); return; }
    sections[sectionName].push(name);
    await saveClassSettings(classCode, { test_sections: sections });
    renderClassDetail(classCode);
}

export async function removeTestFromSection(classCode, sectionName, index) {
    const sections = getClassTestSections(classCode);
    if (!sections[sectionName]) return;
    sections[sectionName].splice(index, 1);
    await saveClassSettings(classCode, { test_sections: sections });
    renderClassDetail(classCode);
}

export async function addTestSection(classCode) {
    const input = document.getElementById('test-section-add-input');
    const name = input?.value.trim();
    if (!name) return;
    const sections = getClassTestSections(classCode);
    if (sections[name] !== undefined) { alert('이미 존재하는 섹션입니다.'); return; }
    sections[name] = [];
    await saveClassSettings(classCode, { test_sections: sections });
    renderClassDetail(classCode);
}

export async function removeTestSection(classCode, sectionName) {
    const sections = getClassTestSections(classCode);
    if (Object.keys(sections).length <= 1) { alert('최소 1개의 섹션이 필요합니다.'); return; }
    delete sections[sectionName];
    await saveClassSettings(classCode, { test_sections: sections });
    renderClassDetail(classCode);
}

export async function resetTestSections(classCode) {
    await saveClassSettings(classCode, { test_sections: JSON.parse(JSON.stringify(DEFAULT_TEST_SECTIONS)) });
    renderClassDetail(classCode);
}

export async function resetTestSection(classCode, sectionName) {
    try {
        const sections = getClassTestSections(classCode);
        // 리뷰테스트는 영역숙제관리 기반, 기반학습테스트는 Vo/Id/ISC, 나머지는 빈 배열
        if (sectionName === '리뷰테스트') {
            sections[sectionName] = [...getClassDomains(classCode)];
        } else {
            sections[sectionName] = [...(DEFAULT_TEST_SECTIONS[sectionName] || [])];
        }
        await saveClassSettings(classCode, { test_sections: sections });
        renderClassDetail(classCode);
    } catch (e) {
        console.error('섹션 기본값 복원 실패:', e);
        alert('기본값 복원에 실패했습니다: ' + e.message);
    }
}

export async function saveClassDefaultTime(classCode, time) {
    if (!time) return;
    showSaveIndicator('saving');
    try {
        await saveClassSettings(classCode, {
            default_time: time,
            default_time_updated_by: state.currentUser?.email || '',
            default_time_updated_at: new Date().toISOString(),
        });
        // 서버에 실제 반영되었는지 검증 (오프라인 캐시 false-positive 방지)
        const snap = await getDocFromServer(doc(db, 'class_settings', classCode));
        const serverTime = snap.data()?.default_time;
        if (serverTime !== time) {
            throw new Error(`서버에 반영되지 않았습니다 (서버값: ${serverTime}). 로그아웃 후 다시 로그인해주세요.`);
        }
        showSaveIndicator('saved');
        renderClassDetail(classCode);
        if (state.selectedStudentId) renderStudentDetail(state.selectedStudentId);
    } catch (err) {
        console.error('반 기본 시간 저장 실패:', err);
        showSaveIndicator('error');
        alert('등원예정시간 저장에 실패했습니다: ' + err.message);
    }
}
