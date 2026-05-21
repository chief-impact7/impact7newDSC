import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  filterConsultationsByKeyword, DEFAULT_HISTORY_LIMIT,
  defaultSearchRange, consultationTitleFallback, buildTitlePrompt, sortConsultationsForHistory,
} from './consultation-filter.js';

const sample = [
  { text: '수학 보강 권유', consultation_type: '정기', teacher_name: 'kim' },
  { text: '휴원 상담 진행', consultation_type: '휴원', teacher_name: 'park' },
  { text: '진로 면담', consultation_type: '학부모요청', teacher_name: 'lee' },
];

test('키워드 없으면 전체 반환', () => {
  assert.equal(filterConsultationsByKeyword(sample, '').length, 3);
  assert.equal(filterConsultationsByKeyword(sample, '   ').length, 3);
  assert.equal(filterConsultationsByKeyword(sample, null).length, 3);
});

test('본문 부분일치', () => {
  const r = filterConsultationsByKeyword(sample, '보강');
  assert.equal(r.length, 1);
  assert.equal(r[0].consultation_type, '정기');
});

test('유형 일치', () => {
  const r = filterConsultationsByKeyword(sample, '학부모요청');
  assert.equal(r.length, 1);
  assert.equal(r[0].text, '진로 면담');
});

test('강사명 대소문자 무시', () => {
  assert.equal(filterConsultationsByKeyword(sample, 'KIM').length, 1);
});

test('일치 없으면 0건', () => {
  assert.equal(filterConsultationsByKeyword(sample, 'zzz').length, 0);
});

test('null/undefined 필드 안전', () => {
  const list = [{ text: null, consultation_type: undefined, teacher_name: null }];
  assert.equal(filterConsultationsByKeyword(list, 'x').length, 0);
});

test('DEFAULT_HISTORY_LIMIT은 20', () => {
  assert.equal(DEFAULT_HISTORY_LIMIT, 20);
});

test('defaultSearchRange: 오늘과 3개월 전 (UTC)', () => {
  const r = defaultSearchRange(new Date('2026-05-21T00:00:00Z'));
  assert.deepEqual(r, { start: '2026-02-21', end: '2026-05-21' });
});

test('defaultSearchRange: 연도 롤오버', () => {
  const r = defaultSearchRange(new Date('2026-01-15T00:00:00Z'));
  assert.deepEqual(r, { start: '2025-10-15', end: '2026-01-15' });
});

test('consultationTitleFallback: 앞 20자, trim', () => {
  assert.equal(consultationTitleFallback('   abcdefghijklmnopqrstuvwxyz   '), 'abcdefghijklmnopqrst');
  assert.equal(consultationTitleFallback('짧은 메모'), '짧은 메모');
  assert.equal(consultationTitleFallback(''), '');
  assert.equal(consultationTitleFallback(null), '');
});

test('buildTitlePrompt: 메모 포함 + 제목 지시', () => {
  const p = buildTitlePrompt('휴원 상담');
  assert.match(p, /휴원 상담/);
  assert.match(p, /제목/);
});

test('sortConsultationsForHistory: pin 먼저, 그 안에서 date desc', () => {
  const list = [
    { id: 'a', date: '2026-05-01' },
    { id: 'b', date: '2026-05-10' },
    { id: 'c', date: '2026-04-01' },
  ];
  const r = sortConsultationsForHistory(list, ['c']);
  assert.deepEqual(r.map(x => x.id), ['c', 'b', 'a']);
});

test('sortConsultationsForHistory: 원본 불변', () => {
  const list = [{ id: 'a', date: '2026-05-01' }, { id: 'b', date: '2026-05-10' }];
  sortConsultationsForHistory(list, []);
  assert.deepEqual(list.map(x => x.id), ['a', 'b']);
});
