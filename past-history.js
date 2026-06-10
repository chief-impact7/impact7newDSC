// past-history.js — 과거이력(이전 학원생활) 뷰
//
// 학생 상태가 활성('재원','등원예정','실휴원','가휴원')이 아닐 때
// 우측 패널 전체를 이 뷰로 교체한다.
//
// 데이터 출처:
//   • 과거 수업/반 이력 → student.enrollments[] + history_logs ("종강 처리: code (정규)" 텍스트 파싱)
//   • 휴원/퇴원 사이클 → leave_requests (사이클 단위로 묶음)
//   • 담당 선생 → class_settings[code].teacher → 이메일 @ 앞부분
//
// AGENTS.md 규칙 1·3 준수: 새 기능은 별도 모듈, 공유 상태는 state.js 통해.

import { collection, query, where, orderBy, getDocs } from 'firebase/firestore';
import { db } from './firebase-config.js';
import { state } from './state.js';
import { esc } from './ui-utils.js';
import { enrollmentCode, findStudent } from './student-helpers.js';
import { currentSchool, studentGrade, studentLevel, todayStr } from './src/shared/firestore-helpers.js';
import { staffLabel } from '@impact7/shared/staff-label';
import { ENROLLABLE_STATUSES } from '@impact7/shared/enrollment-status';
import { formatDateKST } from '@impact7/shared/datetime';

export function isPastViewStudent(student) {
    if (!student) return false;
    const status = student.status || '';
    return !ENROLLABLE_STATUSES.has(status);
}

// ─── 담당 선생 lookup ──────────────────────────────────────────────────────
function _teacherDisplayName(email) {
    return staffLabel(email);
}

function _enrollmentTeacher(code) {
    if (!code) return '';
    const cs = state.classSettings?.[code];
    if (!cs?.teacher) return '';
    return _teacherDisplayName(cs.teacher);
}

// ─── 날짜 비교 유틸 ────────────────────────────────────────────────────────
const _isValidDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d);

const _toMs = (d) => {
    if (!d) return 0;
    if (typeof d?.toMillis === 'function') return d.toMillis();
    if (d instanceof Date) return d.getTime();
    if (typeof d === 'string') return new Date(d).getTime() || 0;
    return 0;
};

// ─── history_logs 종강 텍스트 파싱 ─────────────────────────────────────────
// after 텍스트 예: "종강 처리: HA101 (정규) → 퇴원 (다른 수업 없음)"
// 정규는 종강 시 enrollments에서 제거되므로 history_logs로 복원해야 한다.
// 내신/특강은 종강 후에도 enrollments에 남아 있으므로 별도 복원 불필요 → "정규"만 매칭.
// code 패턴은 보수적으로 영문 대문자 + 숫자(예: HA101, HB202)만 허용.
const _CLOSING_RE = /종강 처리:\s*([A-Z]+\d+)\s*\(정규\)/g;

function _parseClosingLogs(logs) {
    // returns: [{ code, class_type, end_date, semester }]
    const restored = [];
    for (const log of logs || []) {
        const after = typeof log?.after === 'string' ? log.after : '';
        if (!after) continue;
        const endDate = _tsToDateStr(log?.timestamp);
        for (const m of after.matchAll(_CLOSING_RE)) {
            restored.push({
                code: m[1],
                class_type: '정규',
                end_date: endDate,
                semester: log?.semester || '',
                _fromLog: true,
            });
        }
    }
    return restored;
}

// ─── 섹션 A: 과거 수업/반 이력 ─────────────────────────────────────────────
// 시기순 정렬 키: end_date 우선, 없으면 start_date
function _buildPastEnrollments(student, closingLogs) {
    const today = todayStr();
    const enrolls = student.enrollments || [];
    const items = [];

    // 1) end_date < today 인 enrollment + 정규 외 만료 enrollment
    //    (요구사항: "end_date < today 인 항목 + class_type !== '정규'인 모든 만료 enrollment")
    //    실질적으로는 "유효한 end_date가 있고 그 값이 오늘보다 이전" 인 항목들.
    for (const e of enrolls) {
        const code = enrollmentCode(e);
        if (!_isValidDate(e.end_date)) continue;
        if (e.end_date >= today) continue; // 미래 만료(아직 활성)은 제외
        items.push({
            code,
            class_type: e.class_type || '',
            start_date: e.start_date || '',
            end_date: e.end_date || '',
            semester: e.semester || '',
            level_symbol: e.level_symbol || '',
            class_number: e.class_number || '',
            _fromLog: false,
        });
    }

    // 2) history_logs로 복원한 정규 종강 (현재 enrollments에는 없음)
    //    중복 제거: 같은 code + end_date 가 이미 enrollments에 있으면 skip
    //    (history 복원 항목은 start_date가 비어 있으므로 end_date 기준이 정확)
    const existingKeys = new Set(items.map(x => `${x.code}|${x.end_date || ''}`));
    for (const r of closingLogs) {
        const k = `${r.code}|${r.end_date || ''}`;
        if (existingKeys.has(k)) continue;
        items.push({
            code: r.code,
            class_type: r.class_type || '',
            start_date: '',
            end_date: r.end_date || '',
            semester: r.semester || '',
            level_symbol: '',
            class_number: '',
            _fromLog: true,
        });
    }

    // 최신이 위로 정렬 (DB와 동일 — 최근 종강이 먼저 보임)
    const sortKey = (x) => x.end_date || x.start_date || '';
    items.sort((a, b) => sortKey(b).localeCompare(sortKey(a)));

    return items;
}

function _renderEnrollmentCard(item) {
    const teacher = _enrollmentTeacher(item.code);
    const period = (item.start_date || item.end_date)
        ? `${esc(item.start_date || '?')} ~ ${esc(item.end_date || '?')}`
        : '—';
    const semester = item.semester ? `<span class="ph-meta">${esc(item.semester)}</span>` : '';
    const ctype = item.class_type ? `<span class="ph-chip ph-chip-type">${esc(item.class_type)}</span>` : '';
    const fromLogTag = item._fromLog
        ? `<span class="ph-meta" style="opacity:0.65;" title="history_logs 텍스트 파싱으로 복원">log</span>`
        : '';
    const teacherHtml = `<span class="ph-meta">담당 ${esc(teacher || '—')}</span>`;
    return `
        <div class="ph-card">
            <div class="ph-card-head">
                <span class="ph-code">${esc(item.code || '—')}</span>
                ${ctype}
                ${semester}
                ${fromLogTag}
            </div>
            <div class="ph-card-body">
                <span class="ph-meta">${period}</span>
                ${teacherHtml}
            </div>
        </div>
    `;
}

// ─── 섹션 B: 휴원/퇴원 사이클 묶음 ─────────────────────────────────────────
// state.leaveRequests에서 해당 학생의 row를 시간 정렬 후 사이클 단위로 묶는다.
//
// 규칙 (간단판):
//   • '휴원요청' / '퇴원→휴원' → 새 휴원 사이클 시작
//   • '휴원연장' → 직전 휴원 사이클에 합류 (leave_end_date 갱신)
//   • '복귀요청' → 직전 휴원 사이클 종료 (return_date)
//   • '휴원→퇴원' → 직전 휴원 사이클을 퇴원으로 전환 (withdrawal_date)
//   • '퇴원요청' → 독립 퇴원 사이클
//   • '재등원요청' → 독립 재등원 항목

function _lrSortKey(r) {
    // created_at → leave_start_date → withdrawal_date 순으로 우선
    const c = _toMs(r.created_at);
    if (c) return c;
    const ls = _toMs(r.leave_start_date);
    if (ls) return ls;
    const w = _toMs(r.withdrawal_date);
    if (w) return w;
    return 0;
}

function _cycleTypeLabel(type) {
    const map = {
        leave: { label: '휴원', color: '#2563eb' },
        leave_to_withdraw: { label: '휴원→퇴원', color: '#dc2626' },
        withdraw: { label: '퇴원', color: '#dc2626' },
        reenroll: { label: '재등원', color: '#16a34a' },
    };
    return map[type] || { label: type, color: '#666' };
}

function _buildLeaveCycles(studentId) {
    const records = (state.leaveRequests || [])
        .filter(r => r.student_id === studentId && r.status !== 'cancelled' && r.status !== 'rejected')
        .slice()
        .sort((a, b) => _lrSortKey(a) - _lrSortKey(b));

    const cycles = [];
    let openLeave = null; // 현재 열린 휴원 사이클

    for (const r of records) {
        const t = r.request_type;
        if (t === '휴원요청' || t === '퇴원→휴원') {
            // 새 휴원 사이클 시작 (기존 열린 사이클은 그대로 종료된 상태로 push)
            if (openLeave) cycles.push(openLeave);
            openLeave = {
                kind: 'leave',
                start: r.leave_start_date || '',
                end: r.leave_end_date || '',
                returnDate: '',
                withdrawalDate: '',
                note: r.consultation_note || '',
                sub: r.leave_sub_type || '',
                events: [r],
            };
        } else if (t === '휴원연장') {
            if (!openLeave) {
                // 직전 사이클이 없으면 새로 시작
                openLeave = {
                    kind: 'leave',
                    start: r.leave_start_date || '',
                    end: r.leave_end_date || '',
                    returnDate: '',
                    withdrawalDate: '',
                    note: r.consultation_note || '',
                    sub: r.leave_sub_type || '',
                    events: [r],
                };
            } else {
                if (r.leave_end_date) openLeave.end = r.leave_end_date;
                if (r.consultation_note) {
                    openLeave.note = openLeave.note
                        ? `${openLeave.note}\n[연장] ${r.consultation_note}`
                        : `[연장] ${r.consultation_note}`;
                }
                openLeave.events.push(r);
            }
        } else if (t === '복귀요청' || t === '재등원요청') {
            if (openLeave) {
                openLeave.returnDate = r.return_date || '';
                if (r.consultation_note) {
                    openLeave.note = openLeave.note
                        ? `${openLeave.note}\n[복귀] ${r.consultation_note}`
                        : `[복귀] ${r.consultation_note}`;
                }
                openLeave.events.push(r);
                cycles.push(openLeave);
                openLeave = null;
            } else {
                // 독립 재등원 항목 (휴원 기록이 없을 때)
                cycles.push({
                    kind: 'reenroll',
                    start: r.return_date || '',
                    end: '',
                    returnDate: r.return_date || '',
                    withdrawalDate: '',
                    note: r.consultation_note || '',
                    sub: '',
                    events: [r],
                });
            }
        } else if (t === '휴원→퇴원') {
            if (openLeave) {
                openLeave.kind = 'leave_to_withdraw';
                openLeave.withdrawalDate = r.withdrawal_date || '';
                if (r.consultation_note) {
                    openLeave.note = openLeave.note
                        ? `${openLeave.note}\n[퇴원전환] ${r.consultation_note}`
                        : `[퇴원전환] ${r.consultation_note}`;
                }
                openLeave.events.push(r);
                cycles.push(openLeave);
                openLeave = null;
            } else {
                cycles.push({
                    kind: 'leave_to_withdraw',
                    start: '',
                    end: '',
                    returnDate: '',
                    withdrawalDate: r.withdrawal_date || '',
                    note: r.consultation_note || '',
                    sub: '',
                    events: [r],
                });
            }
        } else if (t === '퇴원요청') {
            // 진행 중 휴원 사이클이 있으면 휴→퇴로 닫음 (DB와 동일 정책).
            // 사용자 관점에서 휴원 중 퇴원요청은 1개 사건(같은 사이클의 종료)이므로 묶는다.
            if (openLeave) {
                openLeave.kind = 'leave_to_withdraw';
                openLeave.withdrawalDate = r.withdrawal_date || '';
                if (r.consultation_note) {
                    openLeave.note = openLeave.note
                        ? `${openLeave.note}\n[퇴원전환] ${r.consultation_note}`
                        : `[퇴원전환] ${r.consultation_note}`;
                }
                openLeave.events.push(r);
                cycles.push(openLeave);
                openLeave = null;
            } else {
                cycles.push({
                    kind: 'withdraw',
                    start: '',
                    end: '',
                    returnDate: '',
                    withdrawalDate: r.withdrawal_date || '',
                    note: r.consultation_note || '',
                    sub: '',
                    events: [r],
                });
            }
        }
        // 그 외 타입은 무시 (안전)
    }

    if (openLeave) cycles.push(openLeave); // 닫히지 않은 사이클도 포함

    // 최신이 위로 (DB와 동일)
    return cycles.slice().reverse();
}

function _renderCycleCard(c) {
    const t = _cycleTypeLabel(c.kind);
    const badge = `<span class="ph-badge" style="background:${t.color}">${esc(t.label)}</span>`;
    const sub = c.sub ? `<span class="ph-meta">${esc(c.sub)}</span>` : '';

    let periodHtml = '';
    if (c.kind === 'leave') {
        const ret = c.returnDate ? `복귀 ${esc(c.returnDate)}` : '복귀 미확정';
        periodHtml = `<span class="ph-meta">${esc(c.start || '?')} ~ ${esc(c.end || '?')} · ${ret}</span>`;
    } else if (c.kind === 'leave_to_withdraw') {
        periodHtml = `<span class="ph-meta">${esc(c.start || '?')} ~ ${esc(c.end || '?')} · 퇴원 ${esc(c.withdrawalDate || '?')}</span>`;
    } else if (c.kind === 'withdraw') {
        periodHtml = `<span class="ph-meta">퇴원일 ${esc(c.withdrawalDate || '?')}</span>`;
    } else if (c.kind === 'reenroll') {
        periodHtml = `<span class="ph-meta">재등원 ${esc(c.returnDate || c.start || '?')}</span>`;
    }

    const noteHtml = c.note
        ? `<div class="ph-card-note">${esc(c.note).replace(/\n/g, '<br>')}</div>`
        : '';

    return `
        <div class="ph-card">
            <div class="ph-card-head">
                ${badge}
                ${sub}
            </div>
            <div class="ph-card-body">
                ${periodHtml}
            </div>
            ${noteHtml}
        </div>
    `;
}

// ─── 섹션 C: 헤더 (첫 등록일·마지막 활동일) ───────────────────────────────
function _firstEnrollmentDate(student) {
    // DB와 통일: student.first_registered 우선, 없으면 enrollments 최소 start_date.
    if (_isValidDate(student?.first_registered)) return student.first_registered;
    const dates = (student?.enrollments || [])
        .map(e => e.start_date)
        .filter(_isValidDate);
    if (!dates.length) return '';
    return dates.sort()[0];
}

const _tsToDateStr = (ts) => formatDateKST(ts);

function _lastActivityDate(student, logs, leaveRequests) {
    // DB와 통일된 공식:
    // max(status_changed_at, 가장 최신 history_log.timestamp,
    //     enrollments 모든 end_date, leave_requests 모든 일자)
    const candidates = [];

    // 1) student.status_changed_at
    const sc = _tsToDateStr(student?.status_changed_at);
    if (_isValidDate(sc)) candidates.push(sc);

    // 2) 가장 최신 history_log.timestamp (logs는 ASC 정렬됨 → 마지막 원소가 최신)
    if (logs && logs.length) {
        const latestTs = logs[logs.length - 1]?.timestamp;
        const d = _tsToDateStr(latestTs);
        if (_isValidDate(d)) candidates.push(d);
    }

    // 3) enrollments[].end_date
    for (const e of student?.enrollments || []) {
        if (_isValidDate(e.end_date)) candidates.push(e.end_date);
    }

    // 4) leave_requests의 모든 일자
    for (const r of leaveRequests || []) {
        if (_isValidDate(r.leave_start_date)) candidates.push(r.leave_start_date);
        if (_isValidDate(r.leave_end_date)) candidates.push(r.leave_end_date);
        if (_isValidDate(r.return_date)) candidates.push(r.return_date);
        if (_isValidDate(r.withdrawal_date)) candidates.push(r.withdrawal_date);
    }

    if (!candidates.length) return '';
    return candidates.sort().slice(-1)[0];
}

// ─── 종합 렌더 ─────────────────────────────────────────────────────────────
async function _fetchHistoryLogs(studentId) {
    try {
        const q = query(
            collection(db, 'history_logs'),
            where('doc_id', '==', studentId),
            orderBy('timestamp', 'asc')
        );
        const snap = await getDocs(q);
        const logs = [];
        snap.forEach(d => logs.push(d.data()));
        return logs;
    } catch (err) {
        console.warn('[past-history] history_logs 조회 실패:', err);
        return [];
    }
}

export async function renderPastHistory(studentId) {
    const student = findStudent(studentId);
    if (!student) return;

    const detailCardsEl = document.getElementById('detail-cards');
    const reportTabEl = document.getElementById('report-tab');
    const scoreTabEl = document.getElementById('score-tab');
    const tabsEl = document.getElementById('detail-tabs');

    // 탭 바 숨김 (활성 학생일 때만 표시)
    if (tabsEl) tabsEl.style.display = 'none';
    if (reportTabEl) reportTabEl.style.display = 'none';
    if (scoreTabEl) scoreTabEl.style.display = 'none';
    if (!detailCardsEl) return;
    detailCardsEl.style.display = '';

    // 헤더 (이름/학교/학년/상태)는 student-detail.js의 기존 프로필 헤더를 그대로 재사용한다.
    // detail-cards 영역에 과거이력 본문을 그린다.

    detailCardsEl.innerHTML = `
        <div class="past-history" id="past-history-root">
            <div class="ph-loading" style="padding:24px;text-align:center;color:var(--text-sec);">
                과거이력 불러오는 중...
            </div>
        </div>
    `;

    // history_logs 페치 (실패해도 enrollments만으로 진행)
    const logs = await _fetchHistoryLogs(studentId);

    // 다른 학생으로 전환되었으면 무시
    if (state.selectedStudentId !== studentId) return;

    const closingLogs = _parseClosingLogs(logs);
    const pastEnrolls = _buildPastEnrollments(student, closingLogs);
    const cycles = _buildLeaveCycles(studentId);

    // 마지막 활동일 산출용 leave_requests (취소/반려 제외해 사이클 빌드에 쓰인 것과 정합)
    const leaveReqsForStudent = (state.leaveRequests || [])
        .filter(r => r.student_id === studentId && r.status !== 'cancelled' && r.status !== 'rejected');

    const firstDate = _firstEnrollmentDate(student);
    const lastDate = _lastActivityDate(student, logs, leaveReqsForStudent);

    const headerMeta = `
        <div class="ph-header">
            <div class="ph-header-line">
                <span class="ph-meta">${esc(currentSchool(student) || '—')} · ${esc(studentLevel(student))}${esc(studentGrade(student))}</span>
                <span class="ph-meta">상태 <b>${esc(student.status || '—')}</b></span>
            </div>
            <div class="ph-header-line">
                <span class="ph-meta">첫 등록 ${esc(firstDate || '—')}</span>
                <span class="ph-meta">마지막 활동 ${esc(lastDate || '—')}</span>
            </div>
        </div>
    `;

    const enrollHtml = pastEnrolls.length
        ? pastEnrolls.map(_renderEnrollmentCard).join('')
        : `<div class="ph-empty">과거 수업 이력이 없습니다.</div>`;

    const cycleHtml = cycles.length
        ? cycles.map(_renderCycleCard).join('')
        : `<div class="ph-empty">휴원·퇴원 기록이 없습니다.</div>`;

    const root = document.getElementById('past-history-root');
    if (!root) return;
    root.innerHTML = `
        ${headerMeta}
        <section class="ph-section">
            <h3 class="ph-section-title">과거 수업·반 이력</h3>
            <div class="ph-section-body">${enrollHtml}</div>
        </section>
        <section class="ph-section">
            <h3 class="ph-section-title">휴원·퇴원 사이클</h3>
            <div class="ph-section-body">${cycleHtml}</div>
        </section>
    `;
}

// ─── window 등록 ───────────────────────────────────────────────────────────
if (typeof window !== 'undefined') {
    window.renderPastHistory = renderPastHistory;
}
