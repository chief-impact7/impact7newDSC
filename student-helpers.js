// ─── Student Helpers ───────────────────────────────────────────────────────
// daily-ops.js에서 추출한 학생 관련 유틸리티 함수들

import { todayStr, parseDateKST, getDayName } from './src/shared/firestore-helpers.js';
import { state, LEVEL_SHORT, LEAVE_STATUSES } from './state.js';
import { applyNaesinFreeDerivation, isNaesinActiveAt } from '@impact7/shared/enrollment-derivation';
import { currentSchool, normalizeRealLevelGrade } from '@impact7/shared/student-label';
import {
    normalizeDays, enrollmentCode, branchFromStudent, allClassCodes,
    makeDailyRecordId, buildNaesinCsKey, NAESIN_OVERRIDE_EXCLUDE,
    resolveNaesinCsKey, displayCodeFromCsKey, isWithdrawnAt, isOnLeaveAt,
    isValidDateStr,
} from './student-core.js';

export {
    normalizeDays, enrollmentCode, branchFromStudent, allClassCodes,
    makeDailyRecordId, buildNaesinCsKey, NAESIN_OVERRIDE_EXCLUDE,
    resolveNaesinCsKey, displayCodeFromCsKey, isWithdrawnAt, isOnLeaveAt,
    isValidDateStr,
};

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

// ─── 기본 유틸 ─────────────────────────────────────────────────────────────

export function matchesBranchFilter(s) {
    if (state.selectedBranch && branchFromStudent(s) !== state.selectedBranch) return false;
    if (state.selectedBranch && state.selectedBranchLevel && normalizeRealLevelGrade(s || {}).level !== state.selectedBranchLevel) return false;
    return true;
}

// ─── Enrollment Helpers ────────────────────────────────────────────────────
export const activeClassCodes = (s, date) => [...new Set(getActiveEnrollments(s, date).map(e => enrollmentCode(e)).filter(Boolean))];
export const _enrollCodeList = (enrolls) => {
    const codes = enrolls.flatMap(e => e.class_type === '내신' ? [enrollmentCode(e), '내신'] : [enrollmentCode(e)]);
    return [...new Set(codes)].join(', ');
};

export function getStudentClassContextsForDate(student, dateStr) {
    if (!student) return [];
    const branch = branchFromStudent(student);
    const active = getActiveEnrollments(student, dateStr);
    const dayName = getDayName(dateStr);
    const scheduled = active.filter(e => normalizeDays(e.day).includes(dayName));
    const candidates = scheduled.length > 0 ? scheduled : active;
    const seen = new Set();
    const contexts = [];

    for (const enrollment of candidates) {
        const settingsKey = enrollmentCode(enrollment);
        if (!settingsKey || seen.has(settingsKey)) continue;
        seen.add(settingsKey);
        contexts.push({
            settingsKey,
            displayCode: displayCodeFromCsKey(settingsKey, branch),
        });
    }
    return contexts;
}

export function deriveNaesinCode(student, enrollment) {
    const school = currentSchool(student);
    const { level, grade } = normalizeRealLevelGrade(student || {});
    const levelShort = LEVEL_SHORT[level] || '';
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

// 내신/자유학기 override의 base가 될 수 있는 "건강한" 정규/자유학기 enrollment인가.
// 죽은 정규(end_date 과거)나 요일 없는 정규에 내신을 올리면, 내신 종료 후 정규 복귀 시
// 활성 enrollment·등원요일이 없어 출결·검색에서 누락된다 (이예원 유령 사고, 2026-05-31).
export function isActiveNaesinBase(e, dateStr) {
    if (e.class_type !== '정규' && e.class_type !== '자유학기') return false;
    const today = dateStr || todayStr();
    if (isValidDateStr(e.end_date) && e.end_date < today) return false;                          // 죽은 정규
    if (e.class_type === '정규' && !(Array.isArray(e.day) && e.day.length)) return false;   // 요일 없는 정규
    return true;
}

// 활성 enrollment만 반환.
// - start_date가 미래인 enrollment 제외 (등원예정 학생의 미래 등원일 회로 차단)
// - end_date가 지난 enrollment(내신/특강)은 제외
// - 내신이 활성 기간이면 정규를 숨김 (내신 종료 후 정규 복귀)
export function getActiveEnrollments(s, dateStr) {
    const enrollments = s.enrollments || [];
    if (enrollments.length === 0) return [];
    const today = dateStr || todayStr();

    // 1) start_date가 미래 또는 end_date가 과거인 enrollment 제외
    //    - 정규는 end_date 없으면 유지
    //    - start_date 없는 옛 데이터는 유지 (호환성)
    const current = enrollments.filter(e => {
        if (isValidDateStr(e.start_date) && e.start_date > today) return false; // 아직 시작 안 함
        if (isValidDateStr(e.end_date) && e.end_date < today) return false;     // 이미 종료
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

// 학생의 "현재 수업 모드"(내신기간 활성) 판정 — 내신 라벨용.
// 판정 로직은 shared SSoT(isNaesinActiveAt). getActiveEnrollments와 동일한 활성 필터
// (미시작·종료 제외)를 적용한 뒤 넘겨, '내신 라벨'과 '파생 등원일정'이 항상 일치한다.
export function isNaesinActiveToday(s, dateStr) {
    const today = dateStr || todayStr();
    const current = (s.enrollments || []).filter(e =>
        !(isValidDateStr(e.start_date) && e.start_date > today) &&
        !(isValidDateStr(e.end_date) && e.end_date < today));
    return isNaesinActiveAt(current, {
        classSettings: state.classSettings,
        dateStr: today,
        resolveNaesinCsKey: (re) => resolveNaesinCsKey(s, re),
    });
}

export function isFreeSemesterActiveToday(s, dateStr) {
    const today = dateStr || todayStr();
    const enrollments = s.enrollments || [];
    const current = enrollments.filter(e => !isValidDateStr(e.end_date) || e.end_date >= today);
    return current.some(e => {
        if (e.class_type === '자유학기' && isValidDateStr(e.start_date) && e.start_date <= today) return true;
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
