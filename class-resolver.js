// ─── Class Resolver ─────────────────────────────────────────────────────────
// daily-ops.js에서 분리한 반코드 해소 / 멤버십 집계 (클러스터 2)
// 순수 조회 로직. RULES 7.4: _getAllClassCodes()는 class_settings + enrollment 양쪽에서 정규 반코드 수집.

import { branchFromClassNumber } from '@impact7/shared/branch';
import { state } from './state.js';
import { getDayName, todayStr, studentLevel } from './src/shared/firestore-helpers.js';
import {
    normalizeDays, branchFromStudent, matchesBranchFilter,
    enrollmentCode, displayCodeFromCsKey, getActiveEnrollments,
    isOnLeaveAt, isWithdrawnAt, isActiveNaesinBase, isValidDateStr,
} from './student-helpers.js';

// ─── 반 관리 헬퍼 ────────────────────────────────────────────────────────────

export function getUniqueClassCodes() {
    const dayName = getDayName(state.selectedDate);
    const regularCodes = new Set();
    const naesinCodes = new Set();
    state.allStudents.forEach(s => {
        if (isWithdrawnAt(s, state.selectedDate)) return;
        if (!matchesBranchFilter(s)) return;
        getActiveEnrollments(s, state.selectedDate).forEach(e => {
            const days = normalizeDays(e.day);
            if (!days.includes(dayName)) return;
            if (e.class_type === '내신') {
                const code = enrollmentCode(e);
                if (code) naesinCodes.add(code);
            } else {
                const code = enrollmentCode(e);
                if (code) regularCodes.add(code);
            }
        });
    });
    // 타반수업 target_class_code도 포함
    state.tempClassOverrides.forEach(o => {
        if (o.target_class_code) regularCodes.add(o.target_class_code);
    });
    return { regular: [...regularCodes].sort(), naesin: [...naesinCodes].sort() };
}

// 반설정 정규 chip 카운트: 요일 무관, getRegularClassStudents 위임.
// override-in 학생은 그 반 멤버에 없는 학생만 추가 카운트.
export function getClassMgmtCount(code) {
    const members = getRegularClassStudents(code, true); // 반설정 멤버 카운트 — 등원예정 포함
    const ids = new Set(members.map(s => s.docId));
    const extra = state.tempClassOverrides.filter(o => o.target_class_code === code && !ids.has(o.student_id)).length;
    return members.length + extra;
}

export function isInTeukangClass(s, classCode, _scheduleDays) {
    const scheduleDays = _scheduleDays ?? new Set(Object.keys(state.classSettings[classCode]?.schedule || {}));
    return (s.enrollments || []).some(e => {
        if (e.class_type !== '특강') return false;
        const ec = enrollmentCode(e);
        if (ec) return ec === classCode;
        return scheduleDays.size > 0 && e.day?.some(d => scheduleDays.has(d));
    });
}

export function getTeukangClassStudents(classCode) {
    const scheduleDays = new Set(Object.keys(state.classSettings[classCode]?.schedule || {}));
    // 특강 enrollment 자체가 필터 역할. 퇴원 학생도 특강 수강 가능.
    return state.allStudents.filter(s =>
        matchesBranchFilter(s) && isInTeukangClass(s, classCode, scheduleDays)
    );
}

export function getFreeSemesterClassStudents(classCode) {
    return state.allStudents.filter(s => {
        if (isWithdrawnAt(s, state.selectedDate)) return false;
        if (!matchesBranchFilter(s)) return false;
        return (s.enrollments || []).some(e =>
            (e.class_type === '정규' || e.class_type === '자유학기') && enrollmentCode(e) === classCode
        );
    });
}

// 정규 반 멤버 (요일 무관): 자유학기/내신 기간 중인 학생도 정규 멤버이므로 포함.
// (정규 || 자유학기) + class_number 화이트리스트 (feedback_naesin_regular_identification.md).
export function getRegularClassStudents(classCode, includePending = false) {
    const today = state.selectedDate;
    return state.allStudents.filter(s => {
        if (isWithdrawnAt(s, today)) return false;
        if (!matchesBranchFilter(s)) return false;
        return (s.enrollments || []).some(e => {
            if (!((e.class_type === '정규' || e.class_type === '자유학기') && e.class_number)) return false;
            if (isValidDateStr(e.end_date) && e.end_date < today) return false;
            // 등원예정(start_date 미래)은 출결에선 제외, 반 설정(includePending)에선 포함
            if (!includePending && isValidDateStr(e.start_date) && e.start_date > today) return false;
            return enrollmentCode(e) === classCode;
        });
    });
}

export function _getAllClassCodes() {
    const regularCodes = new Set();
    const freeCounts = new Map();
    const naesinCounts = new Map();

    // 1. class_settings 기반 등록 — 자유학기/내신/정규/특강 분류
    Object.entries(state.classSettings).forEach(([code, cs]) => {
        if (!cs) return;
        if (cs.class_type === '특강') return; // teukang 그룹에서 별도 처리

        if (cs.naesin_start && cs.naesin_end) {
            const branch = branchFromClassNumber(code);
            if (state.selectedBranch && branch !== state.selectedBranch) return;
            naesinCounts.set(code, { displayCode: displayCodeFromCsKey(code, branch), count: 0 });
            return;
        }

        if (cs.free_schedule !== undefined || cs.free_start) {
            freeCounts.set(code, 0);
        }
        regularCodes.add(code);
    });

    // class_settings 문서 없는 정규 반 → enrollment fallback (반설정 미등록 반도 소속 트리 노출)
    state.allStudents.forEach(s => {
        if (isWithdrawnAt(s, state.selectedDate)) return;
        (s.enrollments || []).forEach(e => {
            if ((e.class_type || '정규') !== '정규') return;
            const code = enrollmentCode(e);
            if (code && !state.classSettings[code]) regularCodes.add(code);
        });
    });

    // 2. 학생 enrollment로 카운트 (등록된 반에 한해)
    state.allStudents.forEach(s => {
        if (isWithdrawnAt(s, state.selectedDate)) return;
        if (!matchesBranchFilter(s)) return;

        // 자유학기 카운트
        const studentFreeCodes = new Set();
        (s.enrollments || []).forEach(e => {
            if (e.class_type !== '정규' && e.class_type !== '자유학기') return;
            const code = enrollmentCode(e);
            if (!code || !freeCounts.has(code)) return;
            studentFreeCodes.add(code);
        });
        studentFreeCodes.forEach(code => freeCounts.set(code, freeCounts.get(code) + 1));

        // 내신 카운트 (class_settings 등록된 csKey만)
        const reg = (s.enrollments || []).find(e => isActiveNaesinBase(e, state.selectedDate) && e.naesin_class_override);
        if (!reg) return;
        const csKey = reg.naesin_class_override;
        if (csKey && naesinCounts.has(csKey)) naesinCounts.get(csKey).count++;
    });

    const naesinWithCounts = [...naesinCounts.entries()]
        .map(([key, { displayCode, count }]) => ({ code: key, displayCode, count }))
        .sort((a, b) => a.displayCode.localeCompare(b.displayCode, 'ko'));
    const teukang = Object.entries(state.classSettings)
        .filter(([, cs]) => cs.class_type === '특강')
        .map(([code]) => code)
        .sort();
    const free = [...freeCounts.entries()]
        .map(([code, count]) => ({ code, count }))
        .sort((a, b) => a.code.localeCompare(b.code));
    return { regular: [...regularCodes].sort(), naesin: naesinWithCounts, teukang, free };
}

// 내신 반코드(Firestore 키)로 학생 목록 조회
// classKey = 소속+반코드 (예: "2단지신목중2A"), 빈 소속이면 "신목중2A"
// 주의(M-12): 이 조회/카운트는 반설정 화면의 "배정 로스터"로, naesin_start/end 기간을
// 의도적으로 확인하지 않는다(기간 밖에도 반 편성·관리 필요). 반면 출결 탭의 활성 멤버십은
// getNaesinInfo(shared deriveActiveNaesinEnrollment, 기간 게이트)를 쓴다 — 두 인원수가
// 기간 밖에서 다를 수 있는 것은 정상이다(로스터 vs 활성).
export function getNaesinStudentsByDerivedCode(classKey) {
    if (!classKey) return [];
    const result = [];
    const seen = new Set();
    state.allStudents.forEach(s => {
        if (isWithdrawnAt(s, state.selectedDate)) return;
        if (isOnLeaveAt(s, state.selectedDate)) return;
        if (!matchesBranchFilter(s)) return;
        const hasMatch = (s.enrollments || []).some(e => isActiveNaesinBase(e, state.selectedDate) && e.naesin_class_override === classKey);
        if (!hasMatch) return;
        if (!seen.has(s.docId)) {
            seen.add(s.docId);
            result.push({ student: s });
        }
    });
    return result;
}

// L4(반) 리스트: 그 단지+학부에 enrollment 학생이 1명 이상 속하고, 반 schedule이 오늘 요일과 매치되는 반.
// 학생 출석 상태(휴원/미등원)는 무관 — 반 schedule만으로 오늘 노출 여부 결정.
// 반 유형별 schedule 저장 위치:
//   정규: cs.default_days (배열), 없으면 enrollment.day 합집합 fallback (renderRegularClassDayCard와 동일)
//   자유학기: cs.free_schedule (객체) + free_start/end 기간
//   내신: cs.schedule (객체) + naesin_start/end 기간
//   특강: cs.schedule (객체) + special_start/end 기간 (옵션)
export function _getClassesForBranchLevel(branch, level) {
    const { regular, naesin, teukang, free } = _getAllClassCodes();
    const dayName = getDayName(state.selectedDate);
    const today = state.selectedDate;
    const inPeriod = (start, end) =>
        (!start || start <= today) && (!end || end >= today);

    const hasRegularToday = (code) => {
        const cs = state.classSettings[code];
        if (cs?.default_days?.length > 0) return cs.default_days.includes(dayName);
        return state.allStudents.some(s =>
            (s.enrollments || []).some(e =>
                enrollmentCode(e) === code &&
                (e.class_type || '정규') === '정규' &&
                (e.day || []).includes(dayName)
            )
        );
    };
    const hasFreeToday = (code) => {
        const cs = state.classSettings[code];
        return !!cs?.free_schedule?.[dayName] && inPeriod(cs.free_start, cs.free_end);
    };
    const hasNaesinToday = (csKey) => {
        const cs = state.classSettings[csKey];
        return !!cs?.schedule?.[dayName] && inPeriod(cs.naesin_start, cs.naesin_end);
    };
    const hasTeukangToday = (code) => {
        const cs = state.classSettings[code];
        return !!cs?.schedule?.[dayName] && inPeriod(cs.special_start, cs.special_end);
    };

    const branchStudents = state.allStudents.filter(s =>
        !isWithdrawnAt(s, today) &&
        branchFromStudent(s) === branch
    );
    const students = branchStudents.filter(s => studentLevel(s) === level);
    const countBy = (pred) => students.filter(s => (s.enrollments || []).some(pred)).length;
    const dominantLevel = (pred) => {
        const counts = new Map();
        for (const student of branchStudents) {
            if (!pred(student)) continue;
            const studentAcademicLevel = studentLevel(student);
            if (!studentAcademicLevel) continue;
            counts.set(studentAcademicLevel, (counts.get(studentAcademicLevel) || 0) + 1);
        }
        return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    };

    const result = [];
    for (const code of regular) {
        if (!hasRegularToday(code)) continue;
        const matchesClass = e => (e.class_type || '정규') === '정규' && enrollmentCode(e) === code;
        if (dominantLevel(s => (s.enrollments || []).some(matchesClass)) !== level) continue;
        const count = countBy(matchesClass);
        if (count > 0) result.push({ mode: 'regular', code, display: code, count });
    }
    for (const { code } of free) {
        if (!hasFreeToday(code)) continue;
        const matchesClass = e => (e.class_type === '정규' || e.class_type === '자유학기') && enrollmentCode(e) === code;
        if (dominantLevel(s => (s.enrollments || []).some(matchesClass)) !== level) continue;
        const count = countBy(matchesClass);
        if (count > 0) result.push({ mode: 'free', code, display: code, count });
    }
    for (const { code: csKey, displayCode } of naesin) {
        if (!hasNaesinToday(csKey)) continue;
        const matchesClass = s =>
            (s.enrollments || []).some(e => isActiveNaesinBase(e, today) && e.naesin_class_override === csKey);
        if (dominantLevel(matchesClass) !== level) continue;
        const count = students.filter(matchesClass).length;
        if (count > 0) result.push({ mode: 'naesin', code: csKey, display: displayCode, count });
    }
    for (const code of teukang) {
        if (!hasTeukangToday(code)) continue;
        const matchesClass = e => e.class_type === '특강' && enrollmentCode(e) === code;
        if (dominantLevel(s => (s.enrollments || []).some(matchesClass)) !== level) continue;
        const count = countBy(matchesClass);
        if (count > 0) result.push({ mode: 'teukang', code, display: code, count });
    }
    return result;
}

export function getClassCodesForDate(dateStr, excludeStudentId) {
    const dayName = getDayName(dateStr);
    const codes = new Set();
    state.allStudents.forEach(s => {
        if (isWithdrawnAt(s, dateStr)) return;
        if (!matchesBranchFilter(s)) return;
        getActiveEnrollments(s, dateStr).forEach(e => {
            if (!e.day.includes(dayName)) return;
            const code = enrollmentCode(e);
            if (code) codes.add(code);
        });
    });
    if (excludeStudentId) {
        const student = state.allStudents.find(s => s.docId === excludeStudentId);
        if (student) {
            getActiveEnrollments(student, dateStr).forEach(e => {
                codes.delete(enrollmentCode(e));
            });
        }
    }
    return [...codes].sort();
}

export function hasActiveCodedEnrollment(enrollments, date = todayStr()) {
    return (enrollments || []).some(e => {
        const code = enrollmentCode(e);
        if (!code) return false;
        if (!e.end_date || e.end_date >= date) return true;
        const naesinKey = e.naesin_class_override;
        const cs = naesinKey ? state.classSettings[naesinKey] : null;
        return !!(cs?.naesin_start && cs?.naesin_end && cs.naesin_start <= date && cs.naesin_end >= date);
    });
}

// 내신 반코드 판별: 유도된 내신 코드(한글 포함)인지 확인
export function _isNaesinClassCode(code) {
    if (!code) return false;
    return /[가-힣]/.test(code);
}
