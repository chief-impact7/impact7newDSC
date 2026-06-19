import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitRecordsByType, toFileMeta } from './docu-records.js';

const sample = [
  { id: 'a', type: 'reflection', occurred_at: '2026-06-10', content: '', files: [] },
  { id: 'b', type: 'etc', occurred_at: '2026-06-12', content: '지각', files: [] },
  { id: 'c', type: 'reflection', occurred_at: '2026-06-15', content: '', files: [] },
];

test('type별로 분리하고 occurred_at 내림차순 정렬', () => {
  const { reflections, etc } = splitRecordsByType(sample);
  assert.deepEqual(reflections.map(r => r.id), ['c', 'a']);
  assert.deepEqual(etc.map(r => r.id), ['b']);
});

test('빈 입력은 빈 배열', () => {
  const { reflections, etc } = splitRecordsByType([]);
  assert.deepEqual(reflections, []);
  assert.deepEqual(etc, []);
});

test('알 수 없는 type은 어느 그룹에도 없음', () => {
  const { reflections, etc } = splitRecordsByType([{ id: 'x', type: 'other', occurred_at: '2026-01-01' }]);
  assert.equal(reflections.length, 0);
  assert.equal(etc.length, 0);
});

test('toFileMeta는 storage 메타만 추출', () => {
  const meta = toFileMeta({ name: 'a.jpg', size: 1234, type: 'image/jpeg' }, 'student-records/s1/r1/a.jpg');
  assert.deepEqual(meta, { path: 'student-records/s1/r1/a.jpg', name: 'a.jpg', size: 1234, contentType: 'image/jpeg' });
});
