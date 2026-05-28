// ─── Student Helpers ───────────────────────────────────────────────────────
// daily-ops.js에서 추출한 학생 관련 유틸리티 함수들

import { todayStr, parseDateKST } from './src/shared/firestore-helpers.js';
import { state, LEVEL_SHORT, LEAVE_STATUSES } from './state.js';
import { applyNaesinFreeDerivation } from '@impact7/shared/enrollment-derivation';

// 학생이 특정 날짜에 휴원 중인지 판정.
// status ∈ LEAVE_STATUSES 이면 휴원으로 간주하고, pause 기간이 명시되어 있으면
// dateStr이 그 기간 내일 때만 true. pause 날짜가 누락된 휴원 상태는
// 데이터 정합성 위반이지만 안전 쪽(휴원 중 간주)으로 처리해 출결/편성에서 숨긴다.
// scheduled_leave_status: 시작일이 미래인 휴원 요청 승인 시 예약용 (status는 '재원' 유지).
// 단, status가 비휴원 active 상태(재원/등원예정/상담)면 scheduled_leave_status 잔존을 무시해
// status를 단일 진실로 신뢰한다 (전은민 silent override 패턴 차단).
const NON_LEAVE_ACTIVE = new Set(['재원', '등원예정', '상담']);

export function isOnLeaveAt(s, dateStr) {
    if (LEAVE_STATUSES.includes(s.status)) {
        if (s.pause_start_date && s.pause_end_date) {
            return dateStr >= s.pause_start_date && dateStr <= s.pause_end_date;
        }
        return true;
    }
    // status가 명시적 비휴원이면 scheduled_leave_status 잔재 무시
    if (NON_LEAVE_ACTIVE.has(s.status)) return false;
    // 그 외(status 누락 등)는 예약 필드로 fallback
    if (LEAVE_STATUSES.includes(s.scheduled_leave_status)) {
        if (s.pause_start_date && s.pause_end_date) {
            return dateStr >= s.pause_start_date && dateStr <= s.pause_end_date;
        }
        return true;
    }
    return false;
}

// 휴원 기간 만료 판정 (실제 오늘 KST 기준).
// status가 휴원(가휴원/실휴원)인데 pause_end_date가 지났으면 true.
// → 자동 복귀는 위험하므로 status를 바꾸지 않고, 출결 화면에서 경고만 띄워
//   담당자가 직접 복귀(상태 변경) 처리하도록 유도한다.
// dateStr 인자는 사용하지 않는다 — 휴원 만료는 "현재" 상태 속성이므로
// state.selectedDate가 아니라 항상 실제 오늘(todayStr) 기준으로 판정한다.
export function isPauseExpired(s) {
    if (!s || !LEAVE_STATUSES.includes(s.status)) return false;
    if (!s.pause_end_date) return false;
    return s.pause_end_date < todayStr();
}

// 휴원 만료일로부터 경과 일수 (≥1). 만료 아니면 0.
export function pauseExpiredDays(s) {
    if (!isPauseExpired(s)) return 0;
    const end = parseDateKST(s.pause_end_date);
    const today = parseDateKST(todayStr());
    return Math.max(1, Math.round((today - end) / 86400000));
}

// 학생이 특정 날짜에 퇴원 상태인지 판정.
// status='퇴원'이면 우선. status가 명시적 active(재원/등원예정/실휴원/가휴원/상담)이면
// withdrawal_date 잔재가 있어도 퇴원으로 간주하지 않음 — status가 단일 진실.
// status 누락 + withdrawal_date 도래 케이스만 fallback 퇴원 판정.
const STATUS_IMPLIES_NOT_WITHDRAWN = new Set(['재원', '등원예정', '실휴원', '가휴원', '상담']);

export function isWithdrawnAt(s, dateStr) {
    if (s.status === '퇴원') return true;
    if (STATUS_IMPLIES_NOT_WITHDRAWN.has(s.status)) return false;
    if (s.withdrawal_date) return s.withdrawal_date <= (dateStr || todayStr());
    return false;
}

// ─── 기본 유틸 ─────────────────────────────────────────────────────────────
export function normalizeDays(day) {
    if (!day) return [];
    if (Array.isArray(day)) return day.map(d => d.replace('요일', '').trim());
    return day.split(/[,·\s]+/).map(d => d.replace('요일', '').trim()).filter(Boolean);
}

export function branchFromStudent(s) {
    if (s.branch) return s.branch;
    const cn = s.enrollments?.[0]?.class_number || '';
    const first = cn.trim()[0];
    if (first === '1') return '2단지';
    if (first === '2') return '10단지';
    return '';
}

export function matchesBranchFilter(s) {
    if (state.selectedBranch && branchFromStudent(s) !== state.selectedBranch) return false;
    if (state.selectedBranch && state.selectedBranchLevel && (s.level || '') !== state.selectedBranchLevel) return false;
    return true;
}

// ─── Enrollment Helpers ────────────────────────────────────────────────────
export function enrollmentCode(e) {
    if (!e) return '';
    return `${e.level_symbol || ''}${e.class_number || ''}`;
}

export const allClassCodes = (s) => (s.enrollments || []).map(e => enrollmentCode(e)).filter(Boolean);
export const activeClassCodes = (s, date) => [...new Set(getActiveEnrollments(s, date).map(e => enrollmentCode(e)).filter(Boolean))];
export const _enrollCodeList = (enrolls) => {
    const codes = enrolls.flatMap(e => e.class_type === '내신' ? [enrollmentCode(e), '내신'] : [enrollmentCode(e)]);
    return [...new Set(codes)].join(', ');
};

// 내신 csKey 빌더 — 마법사·자동 유도가 모두 이 함수를 거쳐 형식이 silent drift 하지 않도록 단일 정의.
export function buildNaesinCsKey({ branch, school, level, grade, group }) {
    return `${branch || ''}${school || ''}${level || ''}${grade || ''}${group || ''}`;
}

// 내신 반코드 유도: 학생의 school + level + grade + A/B
// A/B 판별: 정규반 class_number 끝자리 홀수=A, 짝수=B
export function deriveNaesinCode(student, enrollment) {
    const school = student.school || '';
    const levelShort = LEVEL_SHORT[student.level] || '';
    const grade = student.grade || '';
    if (!school || !grade) return '';

    // 내신 enrollment의 class_number에서 A/B 판별
    const cn = enrollment.class_number || '';
    const lastChar = cn.slice(-1).toUpperCase();

    let group = '';
    if (lastChar === 'A' || lastChar === 'B') {
        // 이미 새 형식 (고1A, 중2B)
        group = lastChar;
    } else {
        // 옛 형식: 정규 반번호(103, 202 등)의 끝자리로 판별
        const lastDigit = parseInt(lastChar);
        if (!isNaN(lastDigit)) group = lastDigit % 2 === 1 ? 'A' : 'B';
    }

    // A/B를 알 수 없으면 정규 enrollment에서 추론
    if (!group) {
        const regularEnroll = (student.enrollments || []).find(e => (e.class_type === '정규' || e.class_type === '자유학기') && e.class_number);
        if (regularEnroll) {
            const regLast = parseInt((regularEnroll.class_number || '').slice(-1));
            if (!isNaN(regLast)) group = regLast % 2 === 1 ? 'A' : 'B';
        }
    }

    return buildNaesinCsKey({ school, level: levelShort, grade, group });
}

// 내신 반 수동 배제 센티넬 (naesin_class_override에 저장).
// string 이면 override, undefined/null 이면 자동 유도.
export const NAESIN_OVERRIDE_EXCLUDE = '';

// 내신 반 매칭 resolver:
//   - override === NAESIN_OVERRIDE_EXCLUDE (== '') → null (명시적 배제)
//   - override (non-empty string) → 해당 csKey (수동 강제 매핑)
//   - override가 string 아님 (undefined/null) → 자동 유도 (branchFromStudent + deriveNaesinCode)
// null 반환 = 내신 대상 아님.
export function resolveNaesinCsKey(student, regularEnroll) {
    if (!regularEnroll) return null;
    const override = regularEnroll.naesin_class_override;
    if (typeof override === 'string') {
        return override === NAESIN_OVERRIDE_EXCLUDE ? null : override;
    }
    const nCode = deriveNaesinCode(student, regularEnroll);
    if (!nCode) return null;
    return branchFromStudent(student) + nCode;
}

// csKey에서 branch 접두사 제거 (표시용)
export function displayCodeFromCsKey(csKey, branch) {
    if (!csKey) return '';
    return branch && csKey.startsWith(branch) ? csKey.slice(branch.length) : csKey;
}

// 활성 enrollment만 반환.
// - start_date가 미래인 enrollment 제외 (등원예정 학생의 미래 등원일 회로 차단)
// - end_date가 지난 enrollment(내신/특강)은 제외
// - 내신이 활성 기간이면 정규를 숨김 (내신 종료 후 정규 복귀)
export function getActiveEnrollments(s, dateStr) {
    const enrollments = s.enrollments || [];
    if (enrollments.length === 0) return [];
    const today = dateStr || todayStr();
    const validDate = (d) => d && /^\d{4}-/.test(d);

    // 1) start_date가 미래 또는 end_date가 과거인 enrollment 제외
    //    - 정규는 end_date 없으면 유지
    //    - start_date 없는 옛 데이터는 유지 (호환성)
    const current = enrollments.filter(e => {
        if (validDate(e.start_date) && e.start_date > today) return false; // 아직 시작 안 함
        if (validDate(e.end_date) && e.end_date < today) return false;     // 이미 종료
        return true;
    });

    // 2) 내신/자유학기 기간 파생 (공유 모듈 @impact7/shared/enrollment-derivation).
    //    내신(기간 활성) > 자유학기(기간 활성) > 정규 그대로. 활성 시 정규를 숨긴다.
    return applyNaesinFreeDerivation(current, {
        classSettings: state.classSettings,
        dateStr: today,
        resolveNaesinCsKey: (re) => resolveNaesinCsKey(s, re),
        enrollmentCode,
    });
}

// 학생의 "현재 수업 모드" 판정용 predicate.
// enrollment.class_type 뿐 아니라 class_settings의 naesin/free 윈도우도 확인 —
// 옛 자유학기 enrollment가 남아있어도 naesin 윈도우가 우선 잡혀야 라벨이 정확해짐.
export function isNaesinActiveToday(s, dateStr) {
    const today = dateStr || todayStr();
    const validDate = (d) => d && /^\d{4}-/.test(d);
    const enrollments = s.enrollments || [];
    const current = enrollments.filter(e => !validDate(e.end_date) || e.end_date >= today);
    // 1) explicit 내신 enrollment (start_date 도달)
    if (current.some(e =>
        e.class_type === '내신' && validDate(e.start_date) && e.start_date <= today
    )) return true;
    // 2) auto or manual override: 정규 enrollment에서 resolve한 csKey의 naesin 윈도우
    const regularEnroll = current.find(e => (e.class_type === '정규' || e.class_type === '자유학기') && e.class_number);
    if (!regularEnroll) return false;
    const csKey = resolveNaesinCsKey(s, regularEnroll);
    if (!csKey) return false;
    const cs = state.classSettings[csKey];
    if (!cs?.naesin_start || !cs?.naesin_end) return false;
    return cs.naesin_start <= today && cs.naesin_end >= today;
}

export function isFreeSemesterActiveToday(s, dateStr) {
    const today = dateStr || todayStr();
    const validDate = (d) => d && /^\d{4}-/.test(d);
    const enrollments = s.enrollments || [];
    const current = enrollments.filter(e => !validDate(e.end_date) || e.end_date >= today);
    return current.some(e => {
        if (e.class_type === '자유학기' && validDate(e.start_date) && e.start_date <= today) return true;
        const cs = state.classSettings[enrollmentCode(e)];
        if (cs?.free_start && cs?.free_end && cs.free_start <= today && cs.free_end >= today) return true;
        return false;
    });
}

// 학생 등원시간: 개별 시간 → 반 기본 시간 fallback (내신/자유학기: 요일별 schedule 지원)
export function getStudentStartTime(enrollment, dayName) {
    if (!enrollment) return '';
    if (dayName) {
        const studentTime = enrollment.schedule?.[dayName];
        if (studentTime) return studentTime;
        // 자유학기: free_schedule 조회
        if (enrollment.class_type === '자유학기') {
            const freeSchedule = state.classSettings[enrollmentCode(enrollment)]?.free_schedule;
            if (freeSchedule?.[dayName]) return freeSchedule[dayName];
        }
        const classSchedule = state.classSettings[enrollmentCode(enrollment)]?.schedule;
        if (classSchedule?.[dayName]) return classSchedule[dayName];
    }
    return enrollment.start_time || enrollment.time || state.classSettings[enrollmentCode(enrollment)]?.default_time || '';
}

// ─── ID & 검색 ─────────────────────────────────────────────────────────────
export function makeDailyRecordId(studentDocId, date) {
    return `${studentDocId}_${date}`;
}

export function findStudent(studentId) {
    return state.allStudents.find(s => s.docId === studentId)
        || state.withdrawnStudents.find(s => s.docId === studentId);
}

// ─── 형제 맵 빌드 ──────────────────────────────────────────────────────────
export function buildSiblingMap() {
    state.siblingMap = {};
    const idToStudent = new Map(state.allStudents.map(s => [s.docId, s]));
    const phoneToIds = {};
    state.allStudents.forEach(s => {
        const phones = [...new Set([s.parent_phone_1, s.parent_phone_2]
            .map(p => (p || '').replace(/\D/g, '')).filter(p => p.length >= 9))];
        phones.forEach(p => {
            if (!phoneToIds[p]) phoneToIds[p] = [];
            phoneToIds[p].push(s.docId);
        });
    });
    Object.values(phoneToIds).forEach(ids => {
        const uniqueIds = [...new Set(ids)];
        if (uniqueIds.length < 2) return;
        uniqueIds.forEach(id => {
            const student = idToStudent.get(id);
            if (!student) return;
            const siblings = uniqueIds.filter(sid => {
                if (sid === id) return false;
                const other = idToStudent.get(sid);
                return other && other.name !== student.name;
            });
            if (siblings.length > 0) {
                if (!state.siblingMap[id]) state.siblingMap[id] = new Set();
                siblings.forEach(sid => state.siblingMap[id].add(sid));
            }
        });
    });
}
