// ─── Attendance Module ──────────────────────────────────────────────────────
// daily-ops.js에서 추출한 출결 관리 관련 함수
// Phase 4-5

import { collection, getDocs, doc, getDoc, query, where, serverTimestamp, deleteField, writeBatch } from 'firebase/firestore';
import { db } from './firebase-config.js';
import { auditUpdate, auditSet, auditDelete, batchUpdate, normalizeImpact7Email } from './audit.js';
import { getDayName, todayStr, toDateStrKST } from './src/shared/firestore-helpers.js';
import { state, NEW_STUDENT_DAYS } from './state.js';
import { showSaveIndicator, nowTimeStr } from './ui-utils.js';
import { branchFromStudent, getStudentClassContextsForDate, isPauseExpired, pauseExpiredDays, findStudent, enrollmentCode } from './student-helpers.js';
import { isCurrentNewTenure, isPotentialNewStudent } from './student-core.js';
import { saveImmediately, saveDailyRecord, reloadForDate, loadStudentTenures, loadRecentlyAttendedStudentIds } from './data-layer.js';

// 토글 UI의 "기본" 라벨 집합 — 이 라벨들을 클릭하면 attendance.status는 '미확인'으로 리셋.
// 오늘 수업 유형/비정규 여부에 따라 첫 버튼 라벨이 동적으로 바뀌지만, 의미는 모두 동일("아직 미확인").
export const DEFAULT_ATTENDANCE_LABELS = new Set(['정규', '특강', '내신', '자유', '비정규']);

// ─── 휴원 만료 경고 (status 자동 전환 금지, 경고만) ──────────────────────────
// 휴원(가휴원/실휴원)인데 pause_end_date가 지난 학생을 출결 마킹/선택할 때 confirm을 띄워
// 담당자가 직접 복귀 처리(상태 변경)를 하도록 유도한다. 매번 뜨면 거슬리므로
// 세션 내 학생당 1회만 노출(확인하면 그 학생은 스킵).
const _pauseExpiredConfirmed = new Set();
const _newStudentStatus = new Map();
const _newStudentPending = new Map();
const _newStudentSaving = new Map();
const _newStudentGeneration = new Map();

// 만료 휴원 학생이면 confirm을 띄우고, 사용자가 취소하면 false(작업 중단) 반환.
// 만료가 아니거나 이미 세션 내 확인했으면 true(진행).
export function confirmPauseExpiredOrAbort(studentId) {
    if (_pauseExpiredConfirmed.has(studentId)) return true;
    const s = findStudent(studentId);
    if (!s || !isPauseExpired(s)) return true;
    const days = pauseExpiredDays(s);
    const ok = window.confirm(
        `${s.name} 학생은 휴원 기간(${s.pause_end_date})이 만료됐습니다 (${days}일 경과).\n` +
        `복귀 처리(상태 변경)를 먼저 해주세요.\n` +
        `그대로 진행하시겠습니까?`
    );
    if (ok) _pauseExpiredConfirmed.add(studentId);
    return ok;
}

// ─── deps injection ─────────────────────────────────────────────────────────
let renderSubFilters, renderListPanel, renderStudentDetail, openBulkModal;

export function initAttendanceDeps(deps) {
    renderSubFilters = deps.renderSubFilters;
    renderListPanel = deps.renderListPanel;
    renderStudentDetail = deps.renderStudentDetail;
    openBulkModal = deps.openBulkModal;
}

// ─── Toggle handlers (immediate save) ──────────────────────────────────────

export async function cycleTempArrival(docId) {
    const ta = state.tempAttendances.find(t => t.docId === docId);
    if (!ta) return;
    const cycle = ['', '등원', '미등원'];
    const current = ta.temp_arrival || '';
    const nextIdx = (cycle.indexOf(current) + 1) % cycle.length;
    const next = cycle[nextIdx];
    showSaveIndicator('saving');
    try {
        const visitStatus = next === '등원' ? '완료' : 'pending';
        const update = next
            ? { temp_arrival: next, visit_status: visitStatus }
            : { temp_arrival: deleteField(), visit_status: 'pending' };
        await auditUpdate(doc(db, 'temp_attendance', docId), update);
        ta.temp_arrival = next || undefined;
        ta.visit_status = visitStatus;
        state._scheduledVisitsCache = null;
        renderSubFilters();
        renderListPanel();
        showSaveIndicator('saved');
    } catch (err) {
        console.error('진단평가 등원 상태 변경 실패:', err);
        showSaveIndicator('error');
    }
}

export function cycleVisitAttendance(studentId) {
    if (!confirmPauseExpiredOrAbort(studentId)) return;
    const cycle = ['등원전', '출석', '지각', '결석'];
    const rec = state.dailyRecords[studentId] || {};
    const attStatus = rec?.attendance?.status || '미확인';
    const currentDisplay = attStatus === '미확인' ? '등원전' : attStatus;
    const nextIdx = (cycle.indexOf(currentDisplay) + 1) % cycle.length;
    const nextDisplay = cycle[nextIdx];
    const nextVal = nextDisplay === '등원전' ? '정규' : nextDisplay;
    applyAttendance(studentId, nextVal, true);
    renderListPanel();
}

export function toggleAttendance(studentId, displayStatus) {
    if (state.bulkMode && state.selectedStudentIds.size >= 2 && state.selectedStudentIds.has(studentId)) {
        openBulkModal('attendance');
        return;
    }
    if (!confirmPauseExpiredOrAbort(studentId)) return;
    applyAttendance(studentId, displayStatus);
}

// 이전에 처리 완료(closed)된 결석을 다시 결석대장에 노출시키기 위해 status='open' + daily_records.absence_closed=false로 atomic batch update.
// resolution/makeup_* 같은 다른 필드는 그대로 보존하여 기존 처리 이력을 잃지 않는다.
async function reopenAbsenceRecord(studentId, absDocId, currentData, date) {
    try {
        const batch = writeBatch(db);
        batchUpdate(batch, doc(db, 'absence_records', absDocId), { status: 'open' });
        batchUpdate(batch, doc(db, 'daily_records', `${studentId}_${date}`), { absence_closed: false });
        await batch.commit();

        if (state.dailyRecords[studentId]) {
            state.dailyRecords[studentId].absence_closed = false;
        }
        const idx = state.absenceRecords.findIndex(r => r.docId === absDocId);
        if (idx >= 0) {
            state.absenceRecords[idx].status = 'open';
        } else {
            state.absenceRecords.push({ docId: absDocId, ...currentData, status: 'open' });
        }
    } catch (err) {
        console.error('결석대장 reopen 실패:', err);
    }
}

export async function autoCreateAbsenceRecord(studentId, overrides, date = state.selectedDate) {
    // 결정적 문서 ID — 동일 학생+날짜 조합은 항상 같은 ID → race condition 방지
    const absDocId = `${studentId}_${date}`;

    if (!overrides && state.dailyRecords[studentId]?.attendance?.status !== '결석') return;

    // 메모리에 이미 open으로 캐시되어 있으면 추가 작업 없음. 단, absence_closed 마커가
    // stale로 남아있으면 함께 해제해야 결석대장 노출/UI 동기화가 일치한다.
    const memHit = state.absenceRecords.find(r => r.student_id === studentId && r.absence_date === date);
    if (memHit) {
        if (state.dailyRecords[studentId]?.absence_closed && memHit.status === 'closed') {
            await reopenAbsenceRecord(studentId, memHit.docId, memHit, date);
        }
        return;
    }

    // Firestore 서버 측 중복 체크
    try {
        // 1) 결정적 ID 문서 확인 (빠름)
        const existDoc = await getDoc(doc(db, 'absence_records', absDocId));
        if (existDoc.exists()) {
            const data = existDoc.data();
            if (data.status === 'open' || data.status === 'done') {
                if (!state.absenceRecords.some(r => r.docId === absDocId)) {
                    state.absenceRecords.push({ docId: absDocId, ...data });
                }
                if (state.dailyRecords[studentId]?.absence_closed && data.status === 'open') {
                    await reopenAbsenceRecord(studentId, absDocId, data, date);
                }
                return;
            }
            if (data.status === 'closed') {
                // 핵심 정책: 이미 closed된 결석이라도 사용자가 다시 결석을 체크하거나 사유를
                // 수정하면 마지막 입력을 우선해 reopen한다. 다른 필드는 보존.
                await reopenAbsenceRecord(studentId, absDocId, data, date);
                return;
            }
        }
        // 2) 기존 auto-ID 레코드 호환: 필드 기반 쿼리 폴백 (2026-03 배포, 2026-05 이후 제거 가능)
        const existQ = query(collection(db, 'absence_records'),
            where('student_id', '==', studentId),
            where('absence_date', '==', date),
            where('status', 'in', ['open', 'done', 'closed']));
        const existSnap = await getDocs(existQ);
        if (!existSnap.empty) {
            for (const d of existSnap.docs) {
                const data = d.data();
                if ((data.status === 'open' || data.status === 'done') && !state.absenceRecords.some(r => r.docId === d.id)) {
                    state.absenceRecords.push({ docId: d.id, ...data });
                }
                if (data.status === 'closed') {
                    await reopenAbsenceRecord(studentId, d.id, data, date);
                }
            }
            return;
        }
    } catch (err) {
        console.warn('결석대장 중복 체크 실패:', err);
        // 체크 실패 시에도 setDoc은 멱등성이 보장되므로 진행
    }

    const student = state.allStudents.find(s => s.docId === studentId);

    let name, branch, classCode, reason;
    if (student) {
        const classCodes = getStudentClassContextsForDate(student, date)
            .map(context => context.displayCode);
        name = student.name || '';
        branch = branchFromStudent(student);
        classCode = [...new Set(classCodes)].join(', ');
        reason = '';
    } else if (overrides) {
        name = overrides.student_name || studentId.replace(/_\d+$/, '');
        branch = overrides.branch || '';
        classCode = overrides.class_code || '';
        reason = overrides.reason || '';
    } else {
        return;
    }

    try {
        const record = {
            student_id: studentId,
            student_name: name,
            branch,
            class_code: classCode,
            absence_date: date,
            consultation_done: false,
            consultation_note: '',
            reason,
            reason_valid: '',
            resolution: 'pending',
            settlement_memo: '',
            makeup_date: '',
            makeup_time: '',
            makeup_status: 'pending',
            makeup_completed_by: '',
            makeup_completed_at: '',
            reschedule_history: [],
            status: 'open',
            // 결석을 체크한 사람/시간 (daily_records 기준, syncAbsenceRecords 실행자가 아닌 실제 체크자)
            marked_absent_by: state.dailyRecords[studentId]?.updated_by || normalizeImpact7Email(state.currentUser?.email || ''),
            marked_absent_at: state.dailyRecords[studentId]?.updated_at || '',
            created_by: normalizeImpact7Email(state.currentUser?.email || '')
        };
        if (!overrides && state.dailyRecords[studentId]?.attendance?.status !== '결석') return;

        await auditSet(doc(db, 'absence_records', absDocId), {
            ...record,
            created_at: serverTimestamp()
        });
        if (!state.absenceRecords.some(r => r.docId === absDocId)) {
            state.absenceRecords.push({
                ...record,
                docId: absDocId,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            });
        }
        if (!overrides && state.dailyRecords[studentId]?.attendance?.status !== '결석') {
            await autoRemoveAbsenceRecord(studentId, date);
        }
    } catch (err) {
        console.error('결석대장 자동 생성 실패:', err);
    }
}

export async function autoRemoveAbsenceRecord(studentId, date = state.selectedDate) {
    const idx = state.absenceRecords.findIndex(r => r.student_id === studentId && r.absence_date === date);
    if (idx === -1) return;
    const record = state.absenceRecords[idx];
    // 보충/정산 처리가 진행된 결석대장은 출석 토글로 삭제하지 않음
    if (record.resolution && record.resolution !== 'pending') {
        console.warn(`결석대장 삭제 차단: ${record.student_name} — resolution=${record.resolution}, makeup_date=${record.makeup_date}`);
        return;
    }
    try {
        await auditDelete(doc(db, 'absence_records', record.docId));
        state.absenceRecords.splice(idx, 1);
        renderSubFilters();
    } catch (err) {
        console.error('결석대장 자동 삭제 실패:', err);
    }
}

// Self-healing: dailyRecords에서 결석인데 absence_records에 없는 건 자동 보충
export async function syncAbsenceRecords() {
    const absentEntries = Object.entries(state.dailyRecords)
        .filter(([, v]) => v?.attendance?.status === '결석' && v?.date === state.selectedDate && !v?.absence_closed);

    const tasks = absentEntries
        .filter(([studentId]) =>
            state.allStudents.some(s => s.docId === studentId) &&
            !state.absenceRecords.some(r => r.student_id === studentId && r.absence_date === state.selectedDate)
        )
        .map(([studentId]) => autoCreateAbsenceRecord(studentId, null, state.selectedDate));

    await Promise.all(tasks);
}

export function applyAttendance(studentId, displayStatus, force = false, silent = false) {
    // 기본 라벨(정규/특강/내신/자유/비정규) → 미확인으로 매핑
    const firestoreStatus = DEFAULT_ATTENDANCE_LABELS.has(displayStatus) ? '미확인' : displayStatus;

    const rec = state.dailyRecords[studentId] || {};
    const currentStatus = rec?.attendance?.status || '미확인';

    // force=true 시 강제 설정, 아니면 같은 상태 클릭 → 미확인으로 토글
    const newStatus = force ? firestoreStatus : (currentStatus === firestoreStatus ? '미확인' : firestoreStatus);

    const attendance = { ...(rec.attendance || {}), status: newStatus };

    const updates = { attendance };
    if (newStatus === '출석' || newStatus === '지각') {
        if (!rec?.arrival_time) {
            updates.arrival_time = nowTimeStr();
        }
    } else if (newStatus === '미확인') {
        updates.arrival_time = '';
    }

    const saveVersion = (_newStudentGeneration.get(studentId) || 0) + 1;
    _newStudentGeneration.set(studentId, saveVersion);
    _newStudentSaving.set(studentId, saveVersion);
    const savePromise = saveImmediately(studentId, updates)
        .then(() => {
            if (_newStudentSaving.get(studentId) === saveVersion) {
                _newStudentSaving.delete(studentId);
                _newStudentStatus.delete(studentId);
                if (!silent) renderListPanel();
            }
            return true;
        })
        .catch((err) => {
            if (_newStudentSaving.get(studentId) === saveVersion) _newStudentSaving.delete(studentId);
            // 저장 실패 시 optimistic 캐시·DOM·결석대장 부수효과를 서버 기준으로 재동기화. F-04.
            // bulk(silent) 경로는 학생마다 전체 reload가 폭발하므로 생략 — 서버 onSnapshot이 교정한다.
            console.error('출결 저장 실패:', err);
            if (!silent) reloadForDate();
            return false;
        });

    if (!state.dailyRecords[studentId]) {
        state.dailyRecords[studentId] = { student_id: studentId, date: state.selectedDate };
    }
    Object.assign(state.dailyRecords[studentId], updates);

    // 결석 시 결석대장 자동 생성, 결석 아닌 상태로 변경 시 자동 삭제
    if (newStatus === '결석') {
        autoCreateAbsenceRecord(studentId, null, state.selectedDate);
    } else if (currentStatus === '결석' && newStatus !== '결석') {
        autoRemoveAbsenceRecord(studentId, state.selectedDate);
    }

    if (silent) return savePromise;

    const row = document.querySelector(`.list-item[data-id="${CSS.escape(studentId)}"]`);
    if (row) {
        const newDisplay = newStatus === '미확인' ? '정규' : newStatus;
        row.querySelectorAll('.toggle-btn').forEach(btn => {
            btn.classList.remove('active-present', 'active-late', 'active-absent', 'active-other');
            if (btn.textContent.trim() === newDisplay) {
                if (newDisplay === '출석') btn.classList.add('active-present');
                else if (newDisplay === '지각') btn.classList.add('active-late');
                else if (newDisplay === '결석') btn.classList.add('active-absent');
                else btn.classList.add('active-other');
            }
        });
    }

    renderSubFilters();

    if (state.currentCategory === 'attendance' && state.currentSubFilter.size > 0 && row) {
        const matchesFilter = doesStatusMatchFilter(newStatus, state.currentSubFilter);
        if (!matchesFilter) {
            row.classList.add('fade-out');
            row.addEventListener('transitionend', () => {
                renderListPanel();
            }, { once: true });
            setTimeout(() => {
                if (row.classList.contains('fade-out')) renderListPanel();
            }, 500);
        } else {
            renderListPanel();
        }
    } else {
        renderListPanel();
    }

    if (state.selectedStudentId === studentId) renderStudentDetail(studentId);
    return savePromise;
}


// 학생의 출결 상태가 현재 L2 필터에 매칭되는지 판별
export function doesStatusMatchFilter(firestoreStatus, filterSet) {
    for (const f of filterSet) {
        if (f === 'pre_arrival' && (!firestoreStatus || firestoreStatus === '미확인')) return true;
        if (f === 'present' && firestoreStatus === '출석') return true;
        if (f === 'late' && firestoreStatus === '지각') return true;
        if (f === 'absent' && firestoreStatus === '결석') return true;
        if (f === 'other' && firestoreStatus && !['미확인', '출석', '지각', '결석'].includes(firestoreStatus)) return true;
    }
    return false;
}

export function isNewStudent(student, todayDate) {
    const signature = _newStudentSignature(student, todayDate);
    const cached = _newStudentStatus.get(student.docId);
    return cached?.signature === signature && cached.value === true;
}

function _newStudentSignature(student, todayDate) {
    const todayAttendance = state.dailyRecords[student.docId]?.attendance?.status || '';
    return `${todayDate.getTime()}|${student.status}|${todayAttendance}|${(student.enrollments || []).map(e => e.start_date || '').sort().join(',')}`;
}

export async function ensureNewStudentStatuses(students, todayDate) {
    const pending = students.filter(student => {
        const signature = _newStudentSignature(student, todayDate);
        return _newStudentStatus.get(student.docId)?.signature !== signature
            && !_newStudentPending.has(student.docId)
            && !_newStudentSaving.has(student.docId);
    });
    if (pending.length === 0) return false;
    const signatures = new Map(pending.map(student => [student.docId, _newStudentSignature(student, todayDate)]));
    const generations = new Map(pending.map(student => [student.docId, _newStudentGeneration.get(student.docId) || 0]));
    let loaded = true;
    const cutoffDate = new Date(todayDate);
    cutoffDate.setDate(cutoffDate.getDate() - NEW_STUDENT_DAYS);
    const promise = loadRecentlyAttendedStudentIds(pending, toDateStrKST(cutoffDate), toDateStrKST(todayDate))
        .then(async recentlyAttendedIds => {
            const candidates = pending.filter(student => isPotentialNewStudent(
                student.enrollments,
                todayDate,
                NEW_STUDENT_DAYS,
                recentlyAttendedIds.has(student.docId)
            ));
            return { candidates, tenures: await loadStudentTenures(candidates) };
        })
        .then(({ candidates, tenures }) => {
            const candidateIds = new Set(candidates.map(student => student.docId));
            for (const student of pending) {
                if (_newStudentSaving.has(student.docId)
                    || (_newStudentGeneration.get(student.docId) || 0) !== generations.get(student.docId)
                    || _newStudentSignature(student, todayDate) !== signatures.get(student.docId)) continue;
                const tenure = candidateIds.has(student.docId) ? tenures.get(student.docId) : null;
                _newStudentStatus.set(student.docId, {
                    signature: signatures.get(student.docId),
                    value: isCurrentNewTenure(tenure, student.status, todayDate, NEW_STUDENT_DAYS),
                });
            }
        })
        .catch(err => {
            loaded = false;
            console.warn('[NEW STUDENT] 재원시작일 조회 실패:', err.code || err.message);
        })
        .finally(() => pending.forEach(student => _newStudentPending.delete(student.docId)));
    pending.forEach(student => {
        _newStudentPending.set(student.docId, promise);
    });
    await promise;
    return loaded;
}

export function isAttendedStatus(status) {
    return status === '출석' || status === '지각' || status === '조퇴';
}

export function checkCanEditGrading(studentId) {
    const rec = state.dailyRecords[studentId] || {};
    if (isAttendedStatus(rec?.attendance?.status)) return true;
    alert('등원(출석, 지각, 조퇴) 상태인 학생만 입력할 수 있습니다.');
    return false;
}

export function _isVisitAttended(source, docId, studentId) {
    if (source === 'temp') {
        const ta = state.tempAttendances.find(t => t.docId === docId);
        return isAttendedStatus(ta?.temp_arrival);
    }
    if (studentId) {
        return isAttendedStatus(state.dailyRecords[studentId]?.attendance?.status);
    }
    return false;
}

export function handleAttendanceChange(studentId, field, value) {
    const rec = state.dailyRecords[studentId] || {};
    const attendance = { ...(rec.attendance || {}), [field]: value };
    saveDailyRecord(studentId, { attendance });

    // 로컬 캐시 즉시 업데이트 (UI 반영)
    if (!state.dailyRecords[studentId]) {
        state.dailyRecords[studentId] = { student_id: studentId, date: state.selectedDate };
    }
    state.dailyRecords[studentId].attendance = attendance;

    // 목록 태그 즉시 업데이트
    if (field === 'status') {
        renderListPanel();
    }

    // 결석 상태에서 사유를 다시 입력하면 closed 결석이라도 reopen하여 결석대장에 다시 노출.
    // autoCreateAbsenceRecord가 status === 'closed'를 감지하면 자동으로 reopen 흐름을 탄다.
    if (field === 'reason' && attendance.status === '결석') {
        autoCreateAbsenceRecord(studentId, null, state.selectedDate);
    }
}
