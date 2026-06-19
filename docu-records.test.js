import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitRecordsByType, toFileMeta, isRecentRecord, hasRecentRecord } from './docu-records.js';

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

const NOW = Date.parse('2026-06-19T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

test('isRecentRecord: occurred_at이 14일 이내면 true', () => {
  assert.equal(isRecentRecord({ occurred_at: '2026-06-10' }, NOW), true);
  assert.equal(isRecentRecord({ occurred_at: '2026-06-19' }, NOW), true);
});

test('isRecentRecord: occurred_at이 14일보다 오래되면 false', () => {
  assert.equal(isRecentRecord({ occurred_at: '2026-06-01' }, NOW), false);
});

test('isRecentRecord: created_at(Firestore Timestamp)로 판정', () => {
  const recent = { occurred_at: '', created_at: { seconds: (NOW - 2 * DAY) / 1000 } };
  const old = { occurred_at: '', created_at: { seconds: (NOW - 30 * DAY) / 1000 } };
  assert.equal(isRecentRecord(recent, NOW), true);
  assert.equal(isRecentRecord(old, NOW), false);
});

test('isRecentRecord: created_at·occurred_at 중 하나라도 최근이면 true', () => {
  const rec = { occurred_at: '2026-01-01', created_at: { seconds: (NOW - 1 * DAY) / 1000 } };
  assert.equal(isRecentRecord(rec, NOW), true);
});

test('isRecentRecord: 날짜 정보 없으면 false', () => {
  assert.equal(isRecentRecord({ occurred_at: '', created_at: null }, NOW), false);
  assert.equal(isRecentRecord(null, NOW), false);
});

test('hasRecentRecord: 최근 기록이 하나라도 있으면 true', () => {
  const records = [
    { occurred_at: '2026-01-01' },
    { occurred_at: '2026-06-15' },
  ];
  assert.equal(hasRecentRecord(records, NOW), true);
  assert.equal(hasRecentRecord([{ occurred_at: '2026-01-01' }], NOW), false);
  assert.equal(hasRecentRecord([], NOW), false);
  assert.equal(hasRecentRecord(null, NOW), false);
});
