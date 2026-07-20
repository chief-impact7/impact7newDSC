// [상담 조회] 순수 뷰 로직 — firebase/DOM 의존 없음 → node:test 가능.
// 상담 원본 배열을 필터·그룹·표/CSV 행으로 변환한다. 학년/반은 호출측이 students에서
// 미리 추출한 studentInfoById로 주입(여기서 firebase 헬퍼를 직접 import하지 않음).
import { teacherDisplayName } from '@impact7/shared/teacher-label';

export const CONSULTATION_COLUMNS = ['날짜', '학생', '학년/반', '강사', '대상', '형태', '유형', '제목', '메모'];

// 상담자명 표시 정규화 — 저장 스냅샷의 대소문자 흔들림(aaron/Aaron)을 HR 영어이름 규약(첫글자만 대문자)으로 통일.
export const teacherLabel = (c) => teacherDisplayName(c.teacher_name) || '';

// allowedIds가 null이면 전체 통과(필터 미적용). Set이면 student_id 교집합.
export function filterByStudentIds(list, allowedIds) {
  if (!allowedIds) return list;
  return list.filter(c => allowedIds.has(c.student_id));
}

// 날짜(desc) 묶음. 입력이 date desc로 조회되므로 묶음 내 순서는 보존.
export function groupByDate(list) {
  const map = new Map();
  for (const c of list) {
    const k = c.date || '';
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(c);
  }
  return [...map.keys()]
    .sort((a, b) => String(b).localeCompare(String(a)))
    .map(key => ({ key, items: map.get(key) }));
}

// 학생명(ko 오름차순) 묶음, 묶음 내 date desc.
export function groupByStudent(list) {
  const map = new Map();
  for (const c of list) {
    const k = c.student_id || '';
    if (!map.has(k)) map.set(k, { key: c.student_name || '', studentId: k, items: [] });
    map.get(k).items.push(c);
  }
  for (const g of map.values()) {
    g.items.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  }
  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key, 'ko'));
}

// 상담자(강사)명별 묶음, 상담자명 ko 오름차순, 묶음 내 date desc.
export function groupByTeacher(list) {
  const map = new Map();
  for (const c of list) {
    const k = teacherLabel(c) || '(미상)';
    if (!map.has(k)) map.set(k, { key: k, items: [] });
    map.get(k).items.push(c);
  }
  for (const g of map.values()) {
    g.items.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  }
  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key, 'ko'));
}

// 그룹 배열을 키워드로 필터(그룹 key 부분일치, 소문자). 키워드 비면 원본.
export function filterGroupsByKeyword(groups, keyword) {
  const kw = (keyword || '').trim().toLowerCase();
  if (!kw) return groups;
  return groups.filter(g => String(g.key || '').toLowerCase().includes(kw));
}

// studentInfoById: { [studentId]: { gradeLabel, classLabel } }
export function toRow(c, studentInfoById = {}) {
  const info = studentInfoById[c.student_id] || {};
  const gradeClass = [info.gradeLabel, info.classLabel].filter(Boolean).join(' · ');
  return [
    c.date || '',
    c.student_name || '',
    gradeClass,
    teacherLabel(c),
    c.target || '',
    c.method || '',
    c.consultation_type || '',
    c.title || '',
    c.text || '',
  ];
}

export function toCsvRows(list, studentInfoById = {}) {
  return list.map(c => toRow(c, studentInfoById));
}
