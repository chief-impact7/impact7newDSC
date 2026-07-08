// ─── Modals ─────────────────────────────────────────────────────────────────
// daily-ops.js에서 분리한 모달 로직 (클러스터 5: 일정/숙제/테스트/수강/타반)
// 모달 전용 상태(_scheduleTargetIds, editingEnrollment)는 이 모듈에 캡슐화.

import { msIcon } from './ms-icon.js';
import { state } from './state.js';
import { doc } from 'firebase/firestore';
import { db } from './firebase-config.js';
import { auditUpdate } from './audit.js';
import { esc, escAttr, showSaveIndicator } from './ui-utils.js';
import { saveDailyRecord, saveRetakeSchedule, getStudentDomains } from './data-layer.js';
import { toDateStrKST, parseDateKST, getDayName } from './src/shared/firestore-helpers.js';
import { isEnrollableStatus } from '@impact7/shared/enrollment-status';
import { enrollmentCode, findStudent } from './student-helpers.js';
import { checkCanEditGrading } from './attendance.js';
import { renderStudentDetail } from './student-detail.js';
import { getClassCodesForDate, hasActiveCodedEnrollment } from './class-resolver.js';

// 잔류 모듈(클러스터 1·4) 함수 주입
let renderSubFilters, renderListPanel;
export function initModalsDeps(deps) {
    ({ renderSubFilters, renderListPanel } = deps);
}

export function openTempClassOverrideModal(studentId) {
    const student = state.allStudents.find(s => s.docId === studentId);
    if (!student) return;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', '타반수업 추가');
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    overlay.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h3>타반수업 추가 — ${esc(student.name)}</h3>
                <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">
                    ${msIcon('close')}
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
}

export async function submitTempClassOverrideFromModal(studentId) {
    const targetClass = document.getElementById('ovr-target-class')?.value;
    const dateVal = document.getElementById('ovr-date')?.value;
    const reason = document.getElementById('ovr-reason')?.value || '';
    if (!targetClass || !dateVal) { alert('대상 반과 날짜를 선택해주세요.'); return; }
    document.querySelector('.modal-overlay')?.remove();
    await window.createTempClassOverride(studentId, targetClass, [dateVal], reason);
}

// ─── Modal helpers ──────────────────────────────────────────────────────────

export function closeModal(id, event) {
    if (!event || event.target === event.currentTarget) {
        document.getElementById(id).style.display = 'none';
    }
}

let _scheduleTargetIds = [];

export function openScheduleModal(studentIds) {
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

export function openHomeworkModal(studentId) {
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

export function openTestModal(studentId) {
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

export async function saveScheduleFromModal() {
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

export async function saveHomeworkFromModal() {
    const title = document.getElementById('hw-title').value.trim();
    const subject = document.getElementById('hw-subject').value;
    const status = document.getElementById('hw-status').value;

    if (!title) { alert('숙제 제목을 입력하세요.'); return; }
    if (!state.selectedStudentId) return;

    const rec = state.dailyRecords[state.selectedStudentId] || {};
    const homework = [...(rec.homework || []), { title, subject, status, note: '' }];

    saveDailyRecord(state.selectedStudentId, { homework });

    state.dailyRecords[state.selectedStudentId] ??= { student_id: state.selectedStudentId, date: state.selectedDate };
    state.dailyRecords[state.selectedStudentId].homework = homework;

    document.getElementById('homework-modal').style.display = 'none';
    renderStudentDetail(state.selectedStudentId);
}

export async function saveTestFromModal() {
    const title = document.getElementById('test-title').value.trim();
    const subject = document.getElementById('test-subject').value;
    const type = document.getElementById('test-type').value;
    const scoreRaw = document.getElementById('test-score').value;
    const passScoreRaw = document.getElementById('test-pass-score').value;
    const score = scoreRaw ? Number(scoreRaw) : null;
    const passScore = passScoreRaw ? Number(passScoreRaw) : null;

    if (!title) { alert('테스트명을 입력하세요.'); return; }
    if (!state.selectedStudentId) return;

    let result = '미완료';
    if (score != null && passScore != null) {
        result = score >= passScore ? '통과' : '재시필요';
    }

    const rec = state.dailyRecords[state.selectedStudentId] || {};
    const tests = [...(rec.tests || []), { title, subject, type, score, pass_score: passScore, result, note: '' }];

    saveDailyRecord(state.selectedStudentId, { tests });

    state.dailyRecords[state.selectedStudentId] ??= { student_id: state.selectedStudentId, date: state.selectedDate };
    state.dailyRecords[state.selectedStudentId].tests = tests;

    document.getElementById('test-modal').style.display = 'none';
    renderStudentDetail(state.selectedStudentId);
}

// ─── 등원예정시간 (학생 상세 패널에서 사용, students 컬렉션에 영구 저장) ──────

export async function saveStudentScheduledTime(studentId, classCode, time) {
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
        if (state.selectedStudentId === studentId) renderStudentDetail(studentId);
    } catch (err) {
        console.error('등원예정시간 저장 실패:', err);
        showSaveIndicator('error');
    }
}

// ─── Enrollment 편집 ─────────────────────────────────────────────────────────
let editingEnrollment = { studentId: null, enrollIdx: 0 };

// input[type=time]은 zero-padded "HH:MM"만 인식하고 그 외("4:00", "16:0" 같은 레거시 값)는
// 조용히 빈 칸으로 무시한다. 구 <select>(renderTime12hOptions)는 비표준 값도 옵션에 끼워 넣어
// 그대로 보존했으므로, 동일 시각으로 zero-pad해 그 보존 동작을 유지한다.
function _normalizeTimeValue(v) {
    const m = /^(\d{1,2}):(\d{1,2})/.exec(v || '');
    if (!m) return '';
    const h = String(Math.min(23, parseInt(m[1], 10))).padStart(2, '0');
    const mm = String(Math.min(59, parseInt(m[2], 10))).padStart(2, '0');
    return `${h}:${mm}`;
}

export function openEnrollmentModal(studentId, enrollIdx) {
    const student = findStudent(studentId);
    if (!student) return;

    const enroll = student.enrollments[enrollIdx] || {};

    // 가드: 이 모달은 정규/특강만 편집 가능 (select 옵션이 둘뿐).
    // 내신/자유학기 enrollment를 열면 class_type이 '정규'로 silent 변경되는 회로가 있어 차단.
    // 반생성마법사를 사용하도록 안내.
    if (enroll.class_type === '내신' || enroll.class_type === '자유학기') {
        alert(`${enroll.class_type} enrollment는 이 모달로 편집할 수 없습니다.\n반생성마법사에서 편집하세요. (정규/특강만 이 모달로 편집 가능)`);
        return;
    }

    editingEnrollment = { studentId, enrollIdx };

    document.getElementById('enroll-student-name').textContent = student.name || '';
    document.getElementById('enroll-level').value = enroll.level_symbol || '';
    document.getElementById('enroll-class-num').value = enroll.class_number || '';
    document.getElementById('enroll-class-type').value = enroll.class_type || '정규';
    const enrollTimeEl = document.getElementById('enroll-time');
    if (enrollTimeEl) enrollTimeEl.value = _normalizeTimeValue(enroll.start_time || enroll.time) || '16:00';
    document.getElementById('enroll-start-date').value = enroll.start_date || '';
    document.getElementById('enroll-end-date').value = enroll.end_date || '';

    // 정규는 종료일 입력 불가 — 정규 종료는 status(퇴원/종강)로만. 특강만 종료일 활성.
    const typeEl = document.getElementById('enroll-class-type');
    const endEl = document.getElementById('enroll-end-date');
    const syncEndDisabled = () => {
        const isRegular = typeEl.value === '정규';
        endEl.disabled = isRegular;
        if (isRegular) endEl.value = '';
    };
    typeEl.onchange = syncEndDisabled;
    syncEndDisabled();

    // 요일 버튼 초기화
    const days = enroll.day || [];
    document.querySelectorAll('#enroll-days .day-btn').forEach(btn => {
        btn.classList.toggle('active', days.includes(btn.dataset.day));
    });

    document.getElementById('enrollment-modal').style.display = 'flex';
}

export async function saveEnrollment() {
    const { studentId, enrollIdx } = editingEnrollment;
    const student = findStudent(studentId);
    if (!student) return;

    // 재원생만 반배정 가능 — 상담/퇴원/종강은 차단 (enrollment-status 정합성)
    if (!isEnrollableStatus(student.status)) {
        alert('재원생만 반을 추가/편집할 수 있습니다.\n상담·퇴원·종강 학생은 먼저 재원 상태로 전환하세요.');
        return;
    }

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

    // 정합성 가드: 반생성마법사(class-setup.js) 규칙과 동일.
    // 잘못 저장하면 getActiveEnrollments가 분류 못해 내신 override 등이 깨짐(96건 사고 재발 방지).
    if (classType === '내신') {
        alert('내신 enrollment는 이 모달로 직접 추가/편집할 수 없습니다.\n반생성마법사를 사용하세요. 내신은 정규의 일시 override 형태로 csKey 별도 관리됩니다.');
        return;
    }
    if ((classType === '정규' || classType === '자유학기') && (!levelSymbol || !classNumber)) {
        alert(`${classType}는 레벨기호와 반넘버를 모두 입력해야 합니다. (예: HA101)`);
        return;
    }
    if (classType === '특강' && !classNumber) {
        alert('특강은 반넘버(반 이름)를 입력해야 합니다.');
        return;
    }
    if (selectedDays.length === 0) { alert('수업 요일을 1개 이상 선택하세요.'); return; }
    // input[type=time]은 사용자가 지우면 빈 문자열을 반환한다(구 select는 항상 값이 있어 불가능했던 상태).
    // 가드 없이 저장하면 start_time:''로 개별 등원시간이 조용히 유실된다.
    if (!startTime) { alert('수업 시작 시간을 입력하세요.'); return; }
    if (!startDate) { alert('시작일을 입력하세요.'); return; }

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
    // 정규는 end_date를 박지 않는다 — 정규 종료는 status(퇴원/종강)로만. (자유학기·특강은 기간제라 유지)
    if (endDate && classType !== '정규') updated.end_date = endDate;
    else delete updated.end_date;

    enrollments[enrollIdx] = updated;
    if (['재원', '등원예정'].includes(student.status) && !hasActiveCodedEnrollment(enrollments)) {
        alert('재원/등원예정 학생은 활성 반이 최소 1개 필요합니다. 퇴원 처리나 휴퇴원요청서 없이 모든 반을 종료할 수 없습니다.');
        return;
    }

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
