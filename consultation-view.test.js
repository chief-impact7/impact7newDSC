import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  filterByStudentIds, groupByDate, groupByStudent, groupByTeacher,
  filterGroupsByKeyword, toRow, toCsvRows, CONSULTATION_COLUMNS,
} from './src/dashboard/lib/consultation-view.js';

const sample = [
  { id: '1', student_id: 's1', student_name: '김가', date: '2026-06-28', teacher_name: '강사A', target: '학생', method: '대면', consultation_type: '정기', title: '제목1', text: '메모1' },
  { id: '2', student_id: 's2', student_name: '이나', date: '2026-06-29', teacher_name: '강사B', target: '학부모', method: '문자', consultation_type: '수시', title: '', text: '메모2' },
  { id: '3', student_id: 's1', student_name: '김가', date: '2026-06-29', teacher_name: '강사A', target: '학생', method: '전화', consultation_type: '정기', title: '제목3', text: '메모3' },
];

test('filterByStudentIds: null이면 전체, Set이면 교집합', () => {
  assert.equal(filterByStudentIds(sample, null).length, 3);
  assert.deepEqual(filterByStudentIds(sample, new Set(['s2'])).map(c => c.id), ['2']);
});

test('groupByDate: 날짜 내림차순 묶음', () => {
  const g = groupByDate(sample);
  assert.deepEqual(g.map(x => x.key), ['2026-06-29', '2026-06-28']);
  assert.equal(g[0].items.length, 2);
});

test('groupByStudent: 학생명 오름차순, 묶음 내 date desc', () => {
  const g = groupByStudent(sample);
  assert.deepEqual(g.map(x => x.key), ['김가', '이나']);
  assert.deepEqual(g[0].items.map(c => c.date), ['2026-06-29', '2026-06-28']);
});

test('groupByTeacher: 상담자명 오름차순, 묶음 내 date desc', () => {
  const g = groupByTeacher(sample);
  assert.deepEqual(g.map(x => x.key), ['강사A', '강사B']);
  assert.equal(g[0].items.length, 2);
  assert.deepEqual(g[0].items.map(c => c.date), ['2026-06-29', '2026-06-28']);
});

test('filterGroupsByKeyword: 그룹 key 부분일치(빈 키워드는 전체)', () => {
  const g = groupByStudent(sample);
  assert.deepEqual(filterGroupsByKeyword(g, '이나').map(x => x.key), ['이나']);
  assert.equal(filterGroupsByKeyword(g, '').length, 2);
  assert.equal(filterGroupsByKeyword(g, 'xyz').length, 0);
});

test('toRow: 컬럼 순서대로, 학년/반은 studentInfo에서 조인', () => {
  const info = { s1: { gradeLabel: '중2', classLabel: 'A101' } };
  assert.deepEqual(
    toRow(sample[0], info),
    ['2026-06-28', '김가', '중2 · A101', '강사A', '학생', '대면', '정기', '제목1', '메모1'],
  );
  // 정보 없는 학생은 학년/반 빈칸
  assert.equal(toRow(sample[1], info)[2], '');
});

test('toCsvRows: 컬럼 수가 헤더와 일치', () => {
  const rows = toCsvRows(sample, {});
  assert.equal(rows.length, 3);
  rows.forEach(r => assert.equal(r.length, CONSULTATION_COLUMNS.length));
});
