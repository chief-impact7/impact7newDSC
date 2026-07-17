import { studentGradeKey, branchFromStudent, allClassCodes } from '../shared/firestore-helpers.js';
import { studentSearchTerms } from '@impact7/shared/student-label';
import { ENROLLABLE_STATUSES } from '@impact7/shared/enrollment-status';

export function studentMatchesQuery(s, needle) {
  if (!needle) return true;
  if (String(s.name ?? '').toLowerCase().includes(needle)) return true;
  if (studentSearchTerms(s).some((t) => t.toLowerCase().includes(needle))) return true;
  return allClassCodes(s).some((c) => c.toLowerCase().includes(needle));
}

export function staffMatchesQuery(person, needle) {
  if (!needle) return true;
  return [person.name, person.department, person.affiliation]
    .some((value) => String(value ?? '').toLowerCase().includes(needle));
}

// 학생 목록을 필터 조건으로 좁힌다. 모든 분류 의미는 공유 헬퍼에 위임(로컬 재구현 금지).
export function filterStudents(students, criteria = {}) {
  const { branch, grades, classCode, status, q } = criteria;
  const needle = String(q ?? '').trim().toLowerCase();
  return (students || []).filter((s) => {
    if (branch && branchFromStudent(s) !== branch) return false;
    if (grades && grades.size && !grades.has(studentGradeKey(s))) return false;
    if (classCode && !allClassCodes(s).includes(classCode)) return false;
    if (status === 'enrolled' && !ENROLLABLE_STATUSES.has(s.status)) return false;
    if (status === 'non' && ENROLLABLE_STATUSES.has(s.status)) return false;
    return studentMatchesQuery(s, needle);
  });
}

export function filterStaff(staff, criteria = {}) {
  const { status, affiliation, department, q } = criteria;
  const needle = String(q ?? '').trim().toLowerCase();
  return (staff || []).filter((person) => {
    if (status && status !== 'all' && person.status !== status) return false;
    if (affiliation && person.affiliation !== affiliation) return false;
    if (department && person.department !== department) return false;
    return staffMatchesQuery(person, needle);
  });
}
