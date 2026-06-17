import { studentGradeKey, branchFromStudent, enrollmentCode } from '../shared/firestore-helpers.js';
import { studentSearchTerms } from '@impact7/shared/student-label';
import { ENROLLABLE_STATUSES } from '@impact7/shared/enrollment-status';

// 학생 목록을 필터 조건으로 좁힌다. 모든 분류 의미는 공유 헬퍼에 위임(로컬 재구현 금지).
export function filterStudents(students, criteria = {}) {
  const { branch, grades, classCode, status, q } = criteria;
  const needle = String(q ?? '').trim().toLowerCase();
  return (students || []).filter((s) => {
    if (branch && branchFromStudent(s) !== branch) return false;
    if (grades && grades.size && !grades.has(studentGradeKey(s))) return false;
    if (classCode && enrollmentCode(s) !== classCode) return false;
    if (status === 'enrolled' && !ENROLLABLE_STATUSES.has(s.status)) return false;
    if (status === 'non' && ENROLLABLE_STATUSES.has(s.status)) return false;
    if (needle) {
      const nameMatch = String(s.name ?? '').toLowerCase().includes(needle);
      const terms = studentSearchTerms(s);
      const termMatch = terms.some((t) => t.toLowerCase().includes(needle));
      if (!nameMatch && !termMatch) return false;
    }
    return true;
  });
}
