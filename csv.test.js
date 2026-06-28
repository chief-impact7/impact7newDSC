import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeCell, csvCell, serializeCsv } from './src/shared/csv.js';

test('safeCell: 수식 트리거 문자는 작은따옴표로 텍스트화', () => {
  assert.equal(safeCell('=1+1'), "'=1+1");
  assert.equal(safeCell('+82'), "'+82");
  assert.equal(safeCell('-3'), "'-3");
  assert.equal(safeCell('@user'), "'@user");
  assert.equal(safeCell('정상'), '정상');
  assert.equal(safeCell(null), '');
});

test('csvCell: 따옴표는 두 개로 이스케이프하고 전체를 따옴표로 감쌈', () => {
  assert.equal(csvCell('a"b'), '"a""b"');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('a\nb'), '"a\nb"');
});

test('serializeCsv: BOM prefix + 헤더/행 직렬화', () => {
  const out = serializeCsv(['날짜', '메모'], [['2026-06-29', 'a,b']]);
  assert.ok(out.startsWith('﻿'), 'BOM으로 시작');
  assert.equal(out, '﻿"날짜","메모"\n"2026-06-29","a,b"');
});
